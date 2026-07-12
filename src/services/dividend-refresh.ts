import type { DividendProvider } from "../providers/dividends";
import { easternMarketDate } from "../shared/dates";
import { DividendFactsService } from "./fact-persistence";

interface HeldInstrumentRow {
  instrument_id: string;
  provider_symbol: string;
  first_trade_date: string;
}

export interface DividendRefreshSummary {
  instruments: number;
  refreshed: number;
  events: number;
  failed: number;
}

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

export class ScheduledDividendRefreshService {
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: {
      db: D1Database;
      provider: DividendProvider;
      now?: () => Date;
      newId?: () => string;
    },
  ) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async refreshHeldInstruments(): Promise<DividendRefreshSummary> {
    const rows = await this.dependencies.db
      .prepare(
        `SELECT i.id AS instrument_id, i.provider_symbol,
                MIN(t.trade_date) AS first_trade_date
           FROM instruments i
           JOIN transactions t ON t.instrument_id = i.id
          GROUP BY i.id, i.provider_symbol
          ORDER BY i.symbol`,
      )
      .all<HeldInstrumentRow>();
    const today = easternMarketDate(this.now());
    const service = new DividendFactsService({
      db: this.dependencies.db,
      provider: this.dependencies.provider,
      now: this.now,
      ...(this.dependencies.newId === undefined
        ? {}
        : { newId: this.dependencies.newId }),
    });
    const summary: DividendRefreshSummary = {
      instruments: rows.results.length,
      refreshed: 0,
      events: 0,
      failed: 0,
    };
    for (const row of rows.results) {
      const result = await service.refresh({
        instrumentId: row.instrument_id,
        symbol: row.provider_symbol,
        startDate: row.first_trade_date,
        endDate: addDays(today, 370),
      });
      if (result.kind === "refreshed") {
        summary.refreshed += 1;
        summary.events += result.events.length;
      } else {
        summary.failed += 1;
      }
    }
    return summary;
  }
}
