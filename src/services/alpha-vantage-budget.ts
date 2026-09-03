export type AlphaVantageRequestKind =
  | "earnings_calendar"
  | "earnings_history"
  | "dividend";

interface UsageRow {
  requestsUsed: number;
}

const EARNINGS_DAILY_LIMIT = 20;
const DIVIDEND_FALLBACK_DAILY_LIMIT = 5;
const DEFAULT_REQUEST_INTERVAL_MS = 1_100;

const categoryValues = (
  kind: AlphaVantageRequestKind,
): readonly [number, number, number] => [
  kind === "earnings_calendar" ? 1 : 0,
  kind === "earnings_history" ? 1 : 0,
  kind === "dividend" ? 1 : 0,
];

export class AlphaVantageRequestBudget {
  private lastRequestStartedAt: number | null = null;

  constructor(
    private readonly db: D1Database,
    private readonly usageDate: string,
    private readonly now: () => Date = () => new Date(),
    private readonly dailyLimit = 25,
    private readonly wait: (milliseconds: number) => Promise<void> = (
      milliseconds,
    ) => scheduler.wait(milliseconds),
    private readonly clock: () => number = () => Date.now(),
    private readonly requestIntervalMs = DEFAULT_REQUEST_INTERVAL_MS,
  ) {}

  private async pace(): Promise<void> {
    if (this.lastRequestStartedAt !== null) {
      const delay =
        this.lastRequestStartedAt + this.requestIntervalMs - this.clock();
      if (delay > 0) await this.wait(delay);
    }
    this.lastRequestStartedAt = this.clock();
  }

  async reserve(kind: AlphaVantageRequestKind): Promise<number> {
    const [calendar, history, dividend] = categoryValues(kind);
    const row = await this.db
      .prepare(
        `INSERT INTO alpha_vantage_daily_usage
         (usage_date, requests_used, earnings_calendar_requests,
          earnings_history_requests, dividend_requests, updated_at)
         VALUES (?1, 1, ?2, ?3, ?4, ?5)
         ON CONFLICT(usage_date) DO UPDATE SET
           requests_used = requests_used + 1,
           earnings_calendar_requests = earnings_calendar_requests + ?2,
           earnings_history_requests = earnings_history_requests + ?3,
           dividend_requests = dividend_requests + ?4,
           updated_at = ?5
         WHERE requests_used < ?6
           AND CASE WHEN ?7 = 'dividend'
             THEN dividend_requests < ?8
               AND dividend_fallback_disabled = 0
             ELSE (earnings_calendar_requests + earnings_history_requests) < ?9
           END
         RETURNING requests_used AS requestsUsed`,
      )
      .bind(
        this.usageDate,
        calendar,
        history,
        dividend,
        this.now().toISOString(),
        this.dailyLimit,
        kind,
        DIVIDEND_FALLBACK_DAILY_LIMIT,
        EARNINGS_DAILY_LIMIT,
      )
      .first<UsageRow>();
    if (!row) throw new Error("provider_daily_limit");
    return row.requestsUsed;
  }

  async disableDividendFallback(code: string): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO alpha_vantage_daily_usage
         (usage_date, requests_used, earnings_calendar_requests,
          earnings_history_requests, dividend_requests, updated_at,
          dividend_fallback_disabled, dividend_fallback_error)
         VALUES (?1, 0, 0, 0, 0, ?2, 1, ?3)
         ON CONFLICT(usage_date) DO UPDATE SET
           dividend_fallback_disabled = 1,
           dividend_fallback_error = ?3,
           updated_at = ?2`,
      )
      .bind(this.usageDate, this.now().toISOString(), code.slice(0, 120))
      .run();
  }

  fetcher(kind: AlphaVantageRequestKind, fetcher: typeof fetch = fetch) {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      await this.pace();
      await this.reserve(kind);
      return fetcher(input, init);
    };
  }
}
