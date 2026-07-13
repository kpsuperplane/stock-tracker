import type { DividendProvider } from "../providers/dividends";
import { easternMarketDate } from "../shared/dates";
import { DividendFactsService } from "./fact-persistence";

interface HeldInstrumentRow {
  instrument_id: string;
  provider_symbol: string;
  currency: "USD" | "CAD";
  first_trade_date: string;
}

interface ClaimedInstrumentRow extends HeldInstrumentRow {
  attempt_count: number;
}

export interface DividendRefreshSummary {
  instruments: number;
  attempted: number;
  refreshed: number;
  events: number;
  failed: number;
}

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const addMilliseconds = (timestamp: string, milliseconds: number): string =>
  new Date(Date.parse(timestamp) + milliseconds).toISOString();

export class ScheduledDividendRefreshService {
  private readonly now: () => Date;
  private readonly batchSize: number;

  constructor(
    private readonly dependencies: {
      db: D1Database;
      provider: DividendProvider;
      now?: () => Date;
      newId?: () => string;
      batchSize?: number;
    },
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.batchSize = dependencies.batchSize ?? 20;
  }

  private async reconcile(timestamp: string): Promise<number> {
    await this.dependencies.db
      .prepare(
        `INSERT INTO dividend_refresh_state
         (instrument_id, requested_start_date, status, attempt_count,
          next_attempt_at, created_at, updated_at)
         SELECT i.id, MIN(t.trade_date), 'pending', 0, ?1, ?1, ?1
           FROM instruments i
           JOIN transactions t ON t.instrument_id = i.id
          WHERE i.instrument_type = 'stock'
          GROUP BY i.id
         ON CONFLICT(instrument_id) DO UPDATE SET
           requested_start_date = MIN(
             dividend_refresh_state.requested_start_date,
             excluded.requested_start_date
           ),
           status = CASE
             WHEN excluded.requested_start_date
                    < dividend_refresh_state.requested_start_date
             THEN 'pending'
             ELSE dividend_refresh_state.status
           END,
           next_attempt_at = CASE
             WHEN excluded.requested_start_date
                    < dividend_refresh_state.requested_start_date
             THEN excluded.next_attempt_at
             ELSE dividend_refresh_state.next_attempt_at
           END,
           updated_at = ?1`,
      )
      .bind(timestamp)
      .run();
    const row = await this.dependencies.db
      .prepare(
        `SELECT COUNT(DISTINCT i.id) AS count
           FROM instruments i JOIN transactions t ON t.instrument_id = i.id
          WHERE i.instrument_type = 'stock'`,
      )
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  private async claim(timestamp: string): Promise<ClaimedInstrumentRow | null> {
    const leaseUntil = addMilliseconds(timestamp, 15 * 60_000);
    return this.dependencies.db
      .prepare(
        `UPDATE dividend_refresh_state
            SET status = 'in_progress', lease_until = ?1,
                last_attempted_at = ?2, attempt_count = attempt_count + 1,
                updated_at = ?2
          WHERE instrument_id = (
            SELECT state.instrument_id
              FROM dividend_refresh_state state
             WHERE (
               state.status IN ('pending', 'retry', 'current')
               AND state.next_attempt_at <= ?2
             ) OR (
               state.status = 'in_progress'
               AND (state.lease_until IS NULL OR state.lease_until <= ?2)
             )
             ORDER BY CASE state.status WHEN 'retry' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                      state.next_attempt_at, state.updated_at, state.instrument_id
             LIMIT 1
          )
        RETURNING instrument_id,
          (SELECT provider_symbol FROM instruments WHERE id = instrument_id)
            AS provider_symbol,
          (SELECT currency FROM instruments WHERE id = instrument_id) AS currency,
          requested_start_date AS first_trade_date,
          attempt_count`,
      )
      .bind(leaseUntil, timestamp)
      .first<ClaimedInstrumentRow>();
  }

  private async complete(
    instrumentId: string,
    timestamp: string,
  ): Promise<void> {
    await this.dependencies.db
      .prepare(
        `UPDATE dividend_refresh_state
            SET status = 'current', attempt_count = 0,
                next_attempt_at = ?1, lease_until = NULL,
                completed_at = ?2, last_error_code = NULL,
                last_error_message = NULL, updated_at = ?2
          WHERE instrument_id = ?3`,
      )
      .bind(addMilliseconds(timestamp, 5 * 86_400_000), timestamp, instrumentId)
      .run();
  }

  private async retry(
    instrumentId: string,
    code: string,
    timestamp: string,
  ): Promise<void> {
    await this.dependencies.db
      .prepare(
        `UPDATE dividend_refresh_state
            SET status = 'retry', next_attempt_at = ?1, lease_until = NULL,
                last_error_code = ?2, last_error_message = ?2,
                updated_at = ?3
          WHERE instrument_id = ?4`,
      )
      .bind(
        addMilliseconds(timestamp, 86_400_000),
        code,
        timestamp,
        instrumentId,
      )
      .run();
  }

  async refreshHeldInstruments(): Promise<DividendRefreshSummary> {
    const timestamp = this.now().toISOString();
    const instrumentCount = await this.reconcile(timestamp);
    const today = easternMarketDate(timestamp);
    const service = new DividendFactsService({
      db: this.dependencies.db,
      provider: this.dependencies.provider,
      now: this.now,
      ...(this.dependencies.newId === undefined
        ? {}
        : { newId: this.dependencies.newId }),
    });
    const summary: DividendRefreshSummary = {
      instruments: instrumentCount,
      attempted: 0,
      refreshed: 0,
      events: 0,
      failed: 0,
    };
    for (let index = 0; index < this.batchSize; index += 1) {
      const row = await this.claim(timestamp);
      if (!row) break;
      summary.attempted += 1;
      const result = await service.refresh({
        instrumentId: row.instrument_id,
        symbol: row.provider_symbol,
        currency: row.currency,
        startDate: row.first_trade_date,
        endDate: addDays(today, 370),
      });
      if (result.kind === "refreshed") {
        await this.complete(row.instrument_id, timestamp);
        summary.refreshed += 1;
        summary.events += result.events.length;
      } else {
        await this.retry(row.instrument_id, result.code, timestamp);
        summary.failed += 1;
      }
    }
    return summary;
  }
}
