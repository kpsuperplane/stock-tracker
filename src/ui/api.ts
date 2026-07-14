import type {
  AccountCategoryDto,
  AccountScopeSelection,
  CalendarReadModelDto,
  EventsTimelineDto,
  JobReadModelDto,
  PortfolioReadModelDto,
  ReportDto,
  ReportSummaryDto,
  StatusReadModelDto,
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

export interface RequestMetaOptions {
  allowNotModified?: boolean;
}

const isFormDataBody = (body: BodyInit | null | undefined): boolean =>
  typeof FormData !== "undefined" && body instanceof FormData;

export const requestWithMeta = async <T>(
  path: string,
  init?: RequestInit,
  options: RequestMetaOptions = {},
): Promise<ApiResponse<T>> => {
  const headers = new Headers(init?.headers);
  const method = (init?.method ?? "GET").toUpperCase();
  if (
    ["POST", "PATCH", "PUT", "DELETE"].includes(method) &&
    !headers.has("X-Stock-Tracker-Request")
  ) {
    headers.set("X-Stock-Tracker-Request", "1");
  }
  if (!headers.has("Content-Type") && !isFormDataBody(init?.body)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...init,
    headers,
    // Keep same-origin session cookies, including Cloudflare Access, on API
    // requests when the app is served through a preview shell.
    credentials: init?.credentials ?? "same-origin",
  });
  if (response.status === 304 && options.allowNotModified) {
    return { data: undefined as T, headers: response.headers };
  }
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

export type EventFilters = {
  instrumentId?: string;
  symbol?: string;
  type?: "transaction" | "split";
  cursor?: string;
  limit?: number;
  scopeType?: AccountScopeSelection["scopeType"];
  scopeId?: string;
};

export type PortfolioReadOptions = {
  locale: "en" | "cn";
  scope?: AccountScopeSelection;
  today?: string;
  cursor?: string;
  limit?: number;
};

export type PortfolioReadResult = {
  portfolio: PortfolioReadModelDto | null;
  notModified: boolean;
  etag: string | null;
  positionBasisRevision: number | null;
};

export interface PortfolioApiClient {
  read: (options: PortfolioReadOptions) => Promise<PortfolioReadResult>;
  clearCache?: () => void;
}

export type CalendarReadOptions = {
  locale: "en" | "cn";
  scope?: AccountScopeSelection;
  view: "month" | "week";
  startDate: string;
  endDate: string;
  asOfDate: string;
  cursor?: string;
  limit?: number;
};

export type CalendarReadResult = {
  calendar: CalendarReadModelDto | null;
  notModified: boolean;
  etag: string | null;
  positionBasisRevision: number | null;
};

export interface CalendarApiClient {
  read: (options: CalendarReadOptions) => Promise<CalendarReadResult>;
  clearCache?: () => void;
}

export type TransactionMutationInput = {
  symbol?: string;
  accountId?: string;
  tradeDate: string;
  side: "buy" | "sell";
  quantityDecimal: string;
  priceDecimal: string;
};

export type EventMutationResponse = {
  transaction: TransactionEventDto | null;
  deleted?: true;
  positionBasisRevision: number;
  pipelineJobId: string;
  warningCode?: "split_history_unavailable" | "split_history_conflict";
};

export type ImportStartResponse = {
  importId: string;
  status: "pending";
};

export type ImportError = {
  rowNumber: number | null;
  symbol: string;
  code: string;
  message: string | null;
  source: "row" | "provider";
};

export interface EventsApiClient {
  list: (filters?: EventFilters) => Promise<EventsTimelineDto>;
  create: (
    input: Required<Pick<TransactionMutationInput, "symbol">> &
      Omit<TransactionMutationInput, "symbol">,
    positionBasisRevision: number,
  ) => Promise<EventMutationResponse>;
  update: (
    id: string,
    input: Omit<TransactionMutationInput, "symbol">,
    positionBasisRevision: number,
    eventRevision: number,
  ) => Promise<EventMutationResponse>;
  remove: (
    id: string,
    positionBasisRevision: number,
    eventRevision: number,
  ) => Promise<EventMutationResponse>;
}

export interface EventImportsApiClient {
  start: (file: File) => Promise<ImportStartResponse>;
  errors: (
    importId: string,
    cursor?: string,
    limit?: number,
  ) => Promise<{ errors: ImportError[]; nextCursor: string | null }>;
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
      `/data/ledger${queryString(filters)}`,
      { cache: "no-store" },
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
    request<EventMutationResponse>("/api/transactions", {
      method: "POST",
      headers: mutationHeaders(positionBasisRevision),
      body: JSON.stringify(input),
    }),
  update: (id, input, positionBasisRevision, eventRevision) =>
    request<EventMutationResponse>(
      `/api/transactions/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: mutationHeaders(positionBasisRevision, eventRevision),
        body: JSON.stringify(input),
      },
    ),
  remove: (id, positionBasisRevision, eventRevision) =>
    request<EventMutationResponse>(
      `/api/transactions/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: mutationHeaders(positionBasisRevision, eventRevision),
      },
    ),
};

export const eventImportsApi: EventImportsApiClient = {
  start: (file) => {
    const form = new FormData();
    form.append("file", file);
    return request<ImportStartResponse>("/api/event-imports", {
      method: "POST",
      headers: { "X-Stock-Tracker-Request": "1" },
      body: form,
    });
  },
  errors: (importId, cursor, limit) => {
    const query = new URLSearchParams();
    if (cursor) query.set("cursor", cursor);
    if (limit !== undefined) query.set("limit", String(limit));
    const suffix = query.toString();
    return request(
      `/api/event-imports/${encodeURIComponent(importId)}/errors${suffix ? `?${suffix}` : ""}`,
    );
  },
};

type PortfolioCacheEntry = {
  portfolio: PortfolioReadModelDto;
  etag: string | null;
  positionBasisRevision: number | null;
};

const portfolioCache = new Map<string, PortfolioCacheEntry>();

type CalendarCacheEntry = {
  calendar: CalendarReadModelDto;
  etag: string | null;
  positionBasisRevision: number | null;
};

const calendarCache = new Map<string, CalendarCacheEntry>();

const portfolioQuery = (options: PortfolioReadOptions): string => {
  const params = new URLSearchParams({ locale: options.locale });
  if (options.today) params.set("today", options.today);
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.scope?.scopeType)
    params.set("scopeType", options.scope.scopeType);
  if (options.scope?.scopeId) params.set("scopeId", options.scope.scopeId);
  return `?${params.toString()}`;
};

export const portfolioApi: PortfolioApiClient = {
  read: async (options) => {
    const key = JSON.stringify(options);
    const cached = portfolioCache.get(key);
    const response = await requestWithMeta<{
      portfolio: PortfolioReadModelDto;
    }>(
      `/api/portfolio${portfolioQuery(options)}`,
      cached?.etag ? { headers: { "If-None-Match": cached.etag } } : undefined,
      { allowNotModified: true },
    );
    const etag = response.headers.get("ETag") ?? cached?.etag ?? null;
    const revisionHeader = response.headers.get("X-Position-Basis-Revision");
    const parsedRevision =
      revisionHeader === null ? null : Number(revisionHeader);
    const positionBasisRevision = Number.isSafeInteger(parsedRevision)
      ? parsedRevision
      : (cached?.positionBasisRevision ?? null);
    if (response.data === undefined) {
      return {
        portfolio: cached?.portfolio ?? null,
        notModified: true,
        etag,
        positionBasisRevision,
      };
    }
    const portfolio = response.data.portfolio;
    portfolioCache.set(key, { portfolio, etag, positionBasisRevision });
    return { portfolio, notModified: false, etag, positionBasisRevision };
  },
  clearCache: () => portfolioCache.clear(),
};

const calendarQuery = (options: CalendarReadOptions): string => {
  const params = new URLSearchParams({
    locale: options.locale,
    view: options.view,
    startDate: options.startDate,
    endDate: options.endDate,
    asOfDate: options.asOfDate,
  });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.scope?.scopeType)
    params.set("scopeType", options.scope.scopeType);
  if (options.scope?.scopeId) params.set("scopeId", options.scope.scopeId);
  return `?${params.toString()}`;
};

export const calendarApi: CalendarApiClient = {
  read: async (options) => {
    const key = JSON.stringify(options);
    const cached = calendarCache.get(key);
    const response = await requestWithMeta<{
      calendar: CalendarReadModelDto;
    }>(
      `/api/calendar${calendarQuery(options)}`,
      cached?.etag ? { headers: { "If-None-Match": cached.etag } } : undefined,
      { allowNotModified: true },
    );
    const etag = response.headers.get("ETag") ?? cached?.etag ?? null;
    const revisionHeader = response.headers.get("X-Position-Basis-Revision");
    const parsedRevision =
      revisionHeader === null ? null : Number(revisionHeader);
    const positionBasisRevision = Number.isSafeInteger(parsedRevision)
      ? parsedRevision
      : (cached?.positionBasisRevision ?? null);
    if (response.data === undefined) {
      return {
        calendar: cached?.calendar ?? null,
        notModified: true,
        etag,
        positionBasisRevision,
      };
    }
    const calendar = response.data.calendar;
    calendarCache.set(key, { calendar, etag, positionBasisRevision });
    return { calendar, notModified: false, etag, positionBasisRevision };
  },
  clearCache: () => calendarCache.clear(),
};

export const api = {
  accounts: {
    tree: (includeArchived = true) =>
      request<{
        categories: AccountCategoryDto[];
        structureRevision: number;
      }>(`/api/accounts?includeArchived=${includeArchived ? "true" : "false"}`),
    createCategory: (input: { name: string; sortOrder?: number }) =>
      request<{ category: AccountCategoryDto }>("/api/accounts/categories", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    updateCategory: (
      id: string,
      input: { name?: string; sortOrder?: number; archived?: boolean },
      revision: number,
    ) =>
      request<{ category: AccountCategoryDto }>(
        `/api/accounts/categories/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "If-Match": String(revision) },
          body: JSON.stringify(input),
        },
      ),
    createAccount: (input: {
      categoryId: string;
      name: string;
      owner?: string;
      sortOrder?: number;
    }) =>
      request<{ account: AccountCategoryDto["accounts"][number] }>(
        "/api/accounts/accounts",
        { method: "POST", body: JSON.stringify(input) },
      ),
    updateAccount: (
      id: string,
      input: {
        categoryId?: string;
        name?: string;
        owner?: string;
        sortOrder?: number;
        archived?: boolean;
      },
      revision: number,
    ) =>
      request<{ account: AccountCategoryDto["accounts"][number] }>(
        `/api/accounts/accounts/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "If-Match": String(revision) },
          body: JSON.stringify(input),
        },
      ),
  },
  portfolio: portfolioApi,
  calendar: calendarApi,
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
  status: (limit?: number, cursor?: string) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const query = params.toString();
    return request<{ status: StatusReadModelDto }>(
      `/api/status${query ? `?${query}` : ""}`,
    );
  },
  jobs: (limit?: number, cursor?: string) => {
    const params = new URLSearchParams();
    if (limit !== undefined) params.set("limit", String(limit));
    if (cursor) params.set("cursor", cursor);
    const query = params.toString();
    return request<{ jobs: JobReadModelDto[]; nextCursor: string | null }>(
      `/api/jobs${query ? `?${query}` : ""}`,
    );
  },
  job: (id: string, cursor?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);
    if (limit !== undefined) params.set("limit", String(limit));
    const query = params.toString();
    return request<{ job: JobReadModelDto }>(
      `/api/jobs/${encodeURIComponent(id)}${query ? `?${query}` : ""}`,
    );
  },
};
