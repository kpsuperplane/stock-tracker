import type { CorporateActionProvider } from "../providers/corporate-actions";
import { LedgerService } from "./ledger";

interface PendingSplitRefreshRow {
  instrument_id: string;
  first_trade_date: string;
}

export interface SplitRefreshSummary {
  attempted: number;
  refreshed: number;
  conflicts: number;
  failed: number;
}

/** Retries split enrichment that could not complete during a ledger mutation. */
export class ScheduledSplitRefreshService {
  private readonly now: () => Date;
  private readonly batchSize: number;

  constructor(
    private readonly dependencies: {
      db: D1Database;
      provider: CorporateActionProvider;
      now?: () => Date;
      batchSize?: number;
    },
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.batchSize = dependencies.batchSize ?? 20;
  }

  async refreshPending(): Promise<SplitRefreshSummary> {
    const candidates = await this.dependencies.db
      .prepare(
        `SELECT instruments.id AS instrument_id,
                MIN(transactions.trade_date) AS first_trade_date
           FROM instruments
           JOIN transactions ON transactions.instrument_id = instruments.id
           LEFT JOIN corporate_action_coverage AS coverage
             ON coverage.instrument_id = instruments.id
            AND coverage.provider = 'yahoo-chart-v8'
          WHERE instruments.security_type = 'stock'
            AND (coverage.instrument_id IS NULL OR coverage.status = 'unavailable')
          GROUP BY instruments.id
          ORDER BY COALESCE(coverage.updated_at, ''), instruments.id
          LIMIT ?1`,
      )
      .bind(this.batchSize)
      .all<PendingSplitRefreshRow>();
    const summary: SplitRefreshSummary = {
      attempted: 0,
      refreshed: 0,
      conflicts: 0,
      failed: 0,
    };
    for (const candidate of candidates.results) {
      summary.attempted += 1;
      const revision =
        (
          await this.dependencies.db
            .prepare("SELECT revision FROM position_basis_state WHERE id = 1")
            .first<{ revision: number }>()
        )?.revision ?? 0;
      const result = await new LedgerService({
        db: this.dependencies.db,
        corporateActionProvider: this.dependencies.provider,
        now: this.now,
      }).refreshSplitHistory({
        expectedPositionBasisRevision: revision,
        instrumentId: candidate.instrument_id,
        requestedStartDate: candidate.first_trade_date,
      });
      if (result.kind === "committed") summary.refreshed += 1;
      else if (result.kind === "candidate_conflict") summary.conflicts += 1;
      else summary.failed += 1;
    }
    return summary;
  }
}
