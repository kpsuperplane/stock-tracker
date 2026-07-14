import { EarningsRepository } from "../db/earnings";
import { FactRevisionBucketRepository } from "../db/revision-buckets";
import { canonicalizeDecimal } from "../domain/decimal";
import type {
  EarningsHistoryProvider,
  EarningsHistoryRange,
} from "../providers/earnings";
import {
  describeProviderError,
  type ProviderFailure,
  providerFailure,
} from "../providers/provider-errors";
import { secEarningsProvider } from "../providers/sec-earnings";
import { easternMarketDate } from "../shared/dates";
import { reconcileEarningsHistoryCoverage } from "./event-coverage";

interface ClaimedHistoryRow {
  instrument_id: string;
  symbol: string;
  provider_symbol: string;
  exchange: string;
  currency: "USD" | "CAD";
  requested_start_date: string;
  attempt_count: number;
}

export interface EarningsHistoryBackfillSummary {
  instruments: number;
  attempted: number;
  secCompleted: number;
  alphaCompleted: number;
  events: number;
  retried: number;
  fallbackDeferred: number;
}

const addMilliseconds = (timestamp: string, milliseconds: number): string =>
  new Date(Date.parse(timestamp) + milliseconds).toISOString();

const fallbackImmediately = new Set([
  "provider_symbol_unavailable",
  "provider_symbol_mismatch",
  "provider_history_archived",
  "provider_history_unavailable",
  "provider_schema",
  "provider_user_agent_unavailable",
  "provider_http_404",
]);

export class EarningsHistoryBackfillService {
  private readonly earnings: EarningsRepository;
  private readonly buckets: FactRevisionBucketRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly batchSize: number;
  private readonly fallbackLimit: number;

  constructor(
    private readonly dependencies: {
      db: D1Database;
      secProvider?: EarningsHistoryProvider;
      alphaProvider?: EarningsHistoryProvider;
      now?: () => Date;
      newId?: () => string;
      batchSize?: number;
      fallbackLimit?: number;
    },
  ) {
    this.earnings = new EarningsRepository(dependencies.db);
    this.buckets = new FactRevisionBucketRepository(dependencies.db);
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
    this.batchSize = dependencies.batchSize ?? 8;
    this.fallbackLimit = dependencies.fallbackLimit ?? 4;
  }

  private async reconcile(timestamp: string): Promise<number> {
    return reconcileEarningsHistoryCoverage(this.dependencies.db, timestamp);
  }

  private async claim(timestamp: string): Promise<ClaimedHistoryRow | null> {
    return this.dependencies.db
      .prepare(
        `UPDATE earnings_history_coverage
            SET status = 'in_progress', lease_until = ?1,
                last_attempted_at = ?2, attempt_count = attempt_count + 1,
                updated_at = ?2
          WHERE instrument_id = (
            SELECT coverage.instrument_id
              FROM earnings_history_coverage coverage
             WHERE (
               coverage.status IN ('pending', 'retry', 'current')
               AND coverage.next_attempt_at <= ?2
             ) OR (
               coverage.status = 'in_progress'
               AND (coverage.lease_until IS NULL OR coverage.lease_until <= ?2)
             )
             ORDER BY CASE coverage.status
                        WHEN 'retry' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
                      coverage.next_attempt_at, coverage.updated_at,
                      coverage.instrument_id
             LIMIT 1
          )
        RETURNING instrument_id,
          (SELECT symbol FROM instruments WHERE id = instrument_id) AS symbol,
          (SELECT provider_symbol FROM instruments WHERE id = instrument_id)
            AS provider_symbol,
          (SELECT exchange FROM instruments WHERE id = instrument_id) AS exchange,
          (SELECT currency FROM instruments WHERE id = instrument_id) AS currency,
          requested_start_date, attempt_count`,
      )
      .bind(addMilliseconds(timestamp, 15 * 60_000), timestamp)
      .first<ClaimedHistoryRow>();
  }

  private async markRetry(
    instrumentId: string,
    failure: ProviderFailure,
    timestamp: string,
  ): Promise<void> {
    const retryDelay =
      failure.code === "provider_rate_limited" ? 15 * 60_000 : 86_400_000;
    await this.dependencies.db
      .prepare(
        `UPDATE earnings_history_coverage
            SET status = 'retry', next_attempt_at = ?1, lease_until = NULL,
                last_error_code = ?2, last_error_message = ?3,
                updated_at = ?4
          WHERE instrument_id = ?5`,
      )
      .bind(
        addMilliseconds(timestamp, retryDelay),
        failure.code,
        failure.message,
        timestamp,
        instrumentId,
      )
      .run();
  }

  private validateRange(
    row: ClaimedHistoryRow,
    range: EarningsHistoryRange,
    startDate: string,
    endDate: string,
  ): void {
    if (
      range.range.requestedStartDate !== startDate ||
      range.range.requestedEndDate !== endDate ||
      !range.range.provider ||
      !range.range.providerRevision ||
      !range.range.observedAt
    ) {
      throw new Error("provider_snapshot_mismatch");
    }
    for (const event of range.events) {
      if (
        event.type !== "earnings" ||
        event.instrumentId !== row.instrument_id ||
        event.symbol.toUpperCase() !== row.symbol.toUpperCase() ||
        event.provider !== range.range.provider ||
        event.reportDate < startDate ||
        event.reportDate > endDate ||
        event.currency !== row.currency
      ) {
        throw new Error("provider_snapshot_mismatch");
      }
    }
  }

  private async persist(
    row: ClaimedHistoryRow,
    range: EarningsHistoryRange,
    timestamp: string,
  ): Promise<void> {
    const existing = await this.earnings.listForInstruments(
      [row.instrument_id],
      range.range.provider,
    );
    const statements: D1PreparedStatement[] = [];
    const bucketKeys = new Set<string>();
    for (const event of range.events) {
      const estimate =
        event.epsEstimate === null
          ? null
          : canonicalizeDecimal(event.epsEstimate);
      const same = existing.some(
        (candidate) =>
          candidate.providerEventId === event.providerEventId &&
          candidate.providerRevision === event.providerRevision &&
          candidate.status === "active",
      );
      if (same) continue;
      statements.push(
        this.earnings.supersedeFiscalPeriodStatement({
          instrumentId: row.instrument_id,
          fiscalDateEnding: event.fiscalDateEnding,
          provider: event.provider,
          providerRevision: event.providerRevision,
          updatedAt: timestamp,
        }),
        this.earnings.upsertStatement({
          id: this.newId(),
          instrumentId: row.instrument_id,
          reportDate: event.reportDate,
          fiscalDateEnding: event.fiscalDateEnding,
          epsEstimateDecimal: estimate,
          currency: event.currency,
          timeOfDay: event.timeOfDay,
          provider: event.provider,
          providerEventId: event.providerEventId,
          providerRevision: event.providerRevision,
          retrievedAt: range.range.observedAt,
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        }),
      );
      bucketKeys.add(event.reportDate.slice(0, 7));
    }
    statements.push(
      this.dependencies.db
        .prepare(
          `UPDATE earnings_history_coverage
              SET coverage_start_date = requested_start_date,
                  coverage_end_date = ?1, provider = ?2, sec_cik = ?3,
                  status = 'current', attempt_count = 0,
                  next_attempt_at = ?4, lease_until = NULL,
                  completed_at = ?5, last_error_code = NULL,
                  last_error_message = NULL, updated_at = ?5
            WHERE instrument_id = ?6`,
        )
        .bind(
          range.range.requestedEndDate,
          range.range.provider,
          range.range.secCik,
          addMilliseconds(timestamp, 14 * 86_400_000),
          timestamp,
          row.instrument_id,
        ),
    );
    for (const bucket of bucketKeys) {
      statements.push(this.buckets.bumpStatement(bucket, timestamp));
    }
    await this.dependencies.db.batch(statements);
  }

  private instrument(row: ClaimedHistoryRow) {
    return {
      instrumentId: row.instrument_id,
      symbol: row.symbol,
      providerSymbol: row.provider_symbol,
      exchange: row.exchange,
      currency: row.currency,
    };
  }

  async refreshDue(): Promise<EarningsHistoryBackfillSummary> {
    const timestamp = this.now().toISOString();
    const endDate = easternMarketDate(timestamp);
    const instruments = await this.reconcile(timestamp);
    const summary: EarningsHistoryBackfillSummary = {
      instruments,
      attempted: 0,
      secCompleted: 0,
      alphaCompleted: 0,
      events: 0,
      retried: 0,
      fallbackDeferred: 0,
    };
    let fallbacks = 0;
    for (let index = 0; index < this.batchSize; index += 1) {
      const row = await this.claim(timestamp);
      if (!row) break;
      summary.attempted += 1;
      const startDate = row.requested_start_date;
      let range: EarningsHistoryRange | null = null;
      let secFailure = providerFailure("provider_sec_unavailable");
      if (this.dependencies.secProvider) {
        try {
          range = await this.dependencies.secProvider.getEarningsHistory(
            this.instrument(row),
            startDate,
            endDate,
          );
        } catch (error) {
          secFailure = describeProviderError(error);
        }
      }
      const shouldFallback =
        range === null &&
        (fallbackImmediately.has(secFailure.code) || row.attempt_count >= 2);
      if (shouldFallback) {
        if (
          !this.dependencies.alphaProvider ||
          fallbacks >= this.fallbackLimit
        ) {
          const code = this.dependencies.alphaProvider
            ? "provider_fallback_budget_deferred"
            : "provider_fallback_unavailable";
          await this.markRetry(
            row.instrument_id,
            providerFailure(code),
            timestamp,
          );
          summary.retried += 1;
          summary.fallbackDeferred += 1;
          continue;
        }
        fallbacks += 1;
        try {
          range = await this.dependencies.alphaProvider.getEarningsHistory(
            this.instrument(row),
            startDate,
            endDate,
          );
        } catch (error) {
          await this.markRetry(
            row.instrument_id,
            describeProviderError(error),
            timestamp,
          );
          summary.retried += 1;
          continue;
        }
      }
      if (!range) {
        await this.markRetry(row.instrument_id, secFailure, timestamp);
        summary.retried += 1;
        continue;
      }
      try {
        this.validateRange(row, range, startDate, endDate);
        await this.persist(row, range, timestamp);
      } catch (error) {
        await this.markRetry(
          row.instrument_id,
          describeProviderError(error),
          timestamp,
        );
        summary.retried += 1;
        continue;
      }
      summary.events += range.events.length;
      if (range.range.provider === secEarningsProvider) {
        summary.secCompleted += 1;
      } else {
        summary.alphaCompleted += 1;
      }
    }
    return summary;
  }
}
