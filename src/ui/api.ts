import type {
  EventsTimelineDto,
  ReportDto,
  ReportSummaryDto,
  SplitConfirmationDto,
  TransactionEventDto,
} from "../shared/contracts";

type ErrorPayload = {
  error?: { code?: string; message?: string };
  [key: string]: unknown;
};

/** Typed failure returned by a product API endpoint. */
export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: Record<string, unknown>;
  readonly headers: Headers;

  constructor(
    message: string,
    status: number,
    code: string | null,
    details: Record<string, unknown>,
    headers: Headers,
  ) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
  }
}

export interface ApiResponse<T> {
  data: T;
  headers: Headers;
}

const isFormDataBody = (body: BodyInit | null | undefined): boolean =>
  typeof FormData !== "undefined" && body instanceof FormData;

export const requestWithMeta = async <T>(
  path: string,
  init?: RequestInit,
): Promise<ApiResponse<T>> => {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type") && !isFormDataBody(init?.body)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const payload = await response
      .json<ErrorPayload>()
      .catch((): ErrorPayload => ({}));
    const { error: errorPayload, ...details } = payload;
    throw new ApiClientError(
      errorPayload?.message ?? "请求失败。",
      response.status,
      errorPayload?.code ?? null,
      details,
      response.headers,
    );
  }
  if (response.status === 204) {
    return { data: undefined as T, headers: response.headers };
  }
  return { data: await response.json<T>(), headers: response.headers };
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> =>
  (await requestWithMeta<T>(path, init)).data;

export type Ticker = {
  id: string;
  symbol: string;
  companyName: string;
  exchange: string;
  currency: string;
  active: boolean;
};

export type BackfillJob = {
  id: string;
  pipeline_job_id?: string | null;
  status: string;
  dates_total: number;
  dates_processed: number;
  ticker_jobs_total: number;
  ticker_jobs_processed: number;
  ticker_jobs_failed: number;
  runs: Array<{
    tradingDate: string;
    status: string;
    tickersFailed: number;
  }>;
  errors: Array<{
    workItemId?: string;
    screeningId: string;
    symbol: string;
    tradingDate: string;
    errorCode: string | null;
    errorMessage: string | null;
    retryable: boolean;
  }>;
};

export type EventFilters = {
  instrumentId?: string;
  symbol?: string;
  type?: "transaction" | "split";
  cursor?: string;
  limit?: number;
};

export type TransactionMutationInput = {
  instrumentId?: string;
  tradeDate: string;
  side: "buy" | "sell";
  quantityDecimal: string;
  priceDecimal: string;
  confirmation?: SplitConfirmationDto;
};

export type EventMutationResponse = {
  transaction: TransactionEventDto | null;
  deleted?: true;
  positionBasisRevision: number;
  pipelineJobId: string;
};

export type SplitSnapshotLike = {
  symbol: string;
  range: {
    requestedStartDate: string;
    requestedEndDate: string;
    coverageStartDate: string | null;
    coverageEndDate: string | null;
    isComplete: boolean;
    basis: string;
    provider: string;
    observedAt: string;
    providerRevision: string;
  };
  events: Array<{
    type: "split";
    symbol: string;
    effectiveDate: string;
    numerator: string;
    denominator: string;
    provider: string;
    providerEventId: string;
    providerRevision: string;
  }>;
};

export type ImportPreviewRow = {
  rowNumber: number;
  symbol: string;
  tradeDate: string | null;
  side: "buy" | "sell" | null;
  quantityDecimal: string | null;
  priceDecimal: string | null;
  status: "valid" | "invalid";
  errors: string[];
};

export type ImportSplitReview = {
  instrumentId: string;
  symbol: string;
  requestedStartDate: string;
  requestedEndDate: string;
  provider: string;
  providerRevision: string;
  snapshot: SplitSnapshotLike;
};

export type ImportPreviewResponse = {
  kind: "preview";
  batchId: string;
  basePositionBasisRevision: number;
  rows: ImportPreviewRow[];
  reviews: ImportSplitReview[];
  projectedHoldings: Record<string, string>;
  expiresAt: string;
};

export type ImportConfirmation = SplitConfirmationDto & {
  instrumentId: string;
};

export type ImportCommitResponse = {
  kind: "committed";
  pipelineJobId: string;
  positionBasisRevision: number;
};

export interface EventsApiClient {
  list: (filters?: EventFilters) => Promise<EventsTimelineDto>;
  create: (
    input: Required<Pick<TransactionMutationInput, "instrumentId">> &
      Omit<TransactionMutationInput, "instrumentId">,
    positionBasisRevision: number,
  ) => Promise<EventMutationResponse>;
  update: (
    id: string,
    input: Omit<TransactionMutationInput, "instrumentId">,
    positionBasisRevision: number,
    eventRevision: number,
  ) => Promise<EventMutationResponse>;
  remove: (
    id: string,
    positionBasisRevision: number,
    eventRevision: number,
    confirmation?: SplitConfirmationDto,
  ) => Promise<EventMutationResponse>;
  confirmSplit: (
    instrumentId: string,
    confirmation: SplitConfirmationDto,
    positionBasisRevision: number,
  ) => Promise<EventMutationResponse>;
}

export interface EventImportsApiClient {
  preview: (file: File) => Promise<ImportPreviewResponse>;
  commit: (
    batchId: string,
    positionBasisRevision: number,
    confirmations: ImportConfirmation[],
  ) => Promise<ImportCommitResponse>;
}

const mutationHeaders = (
  positionBasisRevision: number,
  eventRevision?: number,
): HeadersInit => ({
  "X-Stock-Tracker-Request": "1",
  "X-Position-Basis-Revision": String(positionBasisRevision),
  ...(eventRevision === undefined
    ? {}
    : { "If-Match": `"event-${eventRevision}"` }),
});

const queryString = (filters: EventFilters = {}): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const value = params.toString();
  return value ? `?${value}` : "";
};

export const eventsApi: EventsApiClient = {
  list: async (filters) => {
    const response = await requestWithMeta<EventsTimelineDto>(
      `/api/events${queryString(filters)}`,
    );
    const revision = Number(
      response.headers.get("X-Position-Basis-Revision") ??
        response.data.positionBasisRevision,
    );
    return Number.isSafeInteger(revision)
      ? { ...response.data, positionBasisRevision: revision }
      : response.data;
  },
  create: (input, positionBasisRevision) =>
    request<EventMutationResponse>("/api/events", {
      method: "POST",
      headers: mutationHeaders(positionBasisRevision),
      body: JSON.stringify(input),
    }),
  update: (id, input, positionBasisRevision, eventRevision) =>
    request<EventMutationResponse>(`/api/events/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: mutationHeaders(positionBasisRevision, eventRevision),
      body: JSON.stringify(input),
    }),
  remove: (id, positionBasisRevision, eventRevision, confirmation) =>
    request<EventMutationResponse>(`/api/events/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: mutationHeaders(positionBasisRevision, eventRevision),
      body: JSON.stringify(confirmation ? { confirmation } : {}),
    }),
  confirmSplit: (instrumentId, confirmation, positionBasisRevision) =>
    request<EventMutationResponse>("/api/corporate-actions/confirm", {
      method: "POST",
      headers: mutationHeaders(positionBasisRevision),
      body: JSON.stringify({ instrumentId, confirmation }),
    }),
};

export const eventImportsApi: EventImportsApiClient = {
  preview: (file) => {
    const form = new FormData();
    form.append("file", file);
    return request<ImportPreviewResponse>("/api/event-imports/preview", {
      method: "POST",
      headers: { "X-Stock-Tracker-Request": "1" },
      body: form,
    });
  },
  commit: (batchId, positionBasisRevision, confirmations) =>
    request<ImportCommitResponse>(
      `/api/event-imports/${encodeURIComponent(batchId)}/commit`,
      {
        method: "POST",
        headers: mutationHeaders(positionBasisRevision),
        body: JSON.stringify({ confirmations }),
      },
    ),
};

export const api = {
  events: eventsApi,
  eventImports: eventImportsApi,
  history: (cursor?: string) =>
    request<{ reports: ReportSummaryDto[]; nextCursor: string | null }>(
      `/api/reports${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  report: (date: string) =>
    request<{ report: ReportDto }>(`/api/reports/${date}`),
  retry: (id: string) =>
    request<{ queued: true }>(`/api/screenings/${id}/retry`, {
      method: "POST",
    }),
  tickers: () => request<{ tickers: Ticker[] }>("/api/tickers"),
  addTicker: (symbol: string) =>
    request<{ ticker: Ticker }>("/api/tickers", {
      method: "POST",
      body: JSON.stringify({ symbol }),
    }),
  setTickerActive: (id: string, active: boolean) =>
    request<void>(`/api/tickers/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ active }),
    }),
  removeTicker: (id: string) =>
    request<void>(`/api/tickers/${id}`, { method: "DELETE" }),
  startBackfill: (input: {
    startDate: string;
    endDate: string;
    reprocessExisting: boolean;
  }) =>
    request<{ id: string }>("/api/backfills", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  backfill: (id: string) =>
    request<{ job: BackfillJob }>(`/api/backfills/${id}`),
  retryBackfill: (pipelineJobId: string, workItemId: string) =>
    request<{ queued: true }>(`/api/backfills/${pipelineJobId}/retry`, {
      method: "POST",
      body: JSON.stringify({ workItemId }),
    }),
};
