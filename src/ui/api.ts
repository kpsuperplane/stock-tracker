import type { ReportDto, ReportSummaryDto } from "../shared/contracts";

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!response.ok) {
    const payload: { error?: { message?: string } } = await response
      .json<{ error?: { message?: string } }>()
      .catch(() => ({}));
    throw new Error(payload.error?.message ?? "请求失败。");
  }
  if (response.status === 204) return undefined as T;
  return response.json<T>();
};

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
    screeningId: string;
    symbol: string;
    tradingDate: string;
    errorCode: string | null;
    errorMessage: string | null;
    retryable: boolean;
  }>;
};

export const api = {
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
};
