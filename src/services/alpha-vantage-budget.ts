export type AlphaVantageRequestKind =
  | "earnings_calendar"
  | "earnings_history"
  | "dividend";

interface UsageRow {
  requestsUsed: number;
}

const categoryValues = (
  kind: AlphaVantageRequestKind,
): readonly [number, number, number] => [
  kind === "earnings_calendar" ? 1 : 0,
  kind === "earnings_history" ? 1 : 0,
  kind === "dividend" ? 1 : 0,
];

export class AlphaVantageRequestBudget {
  constructor(
    private readonly db: D1Database,
    private readonly usageDate: string,
    private readonly now: () => Date = () => new Date(),
    private readonly dailyLimit = 25,
  ) {}

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
         RETURNING requests_used AS requestsUsed`,
      )
      .bind(
        this.usageDate,
        calendar,
        history,
        dividend,
        this.now().toISOString(),
        this.dailyLimit,
      )
      .first<UsageRow>();
    if (!row) throw new Error("provider_daily_limit");
    return row.requestsUsed;
  }

  fetcher(kind: AlphaVantageRequestKind, fetcher: typeof fetch = fetch) {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      await this.reserve(kind);
      return fetcher(input, init);
    };
  }
}
