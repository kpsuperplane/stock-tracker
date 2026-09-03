import { EarningsRepository } from "../db/earnings";
import { deriveHoldings } from "../domain/holdings";
import { isMarketTradingDayForExchange } from "../domain/market-calendar";
import { alphaVantageEarningsProvider } from "../providers/alpha-vantage-earnings";
import type {
  HistoryCoverageDto,
  PortfolioImportStatusDto,
  ReconciliationStatus,
  ReconciliationStatusDto,
  StatusReadModelDto,
} from "../shared/contracts";
import {
  easternCloseUtc,
  easternMarketDate,
  previousCalendarDate,
} from "../shared/dates";
import {
  type JobReadModelListInput,
  JobReadModelService,
} from "./job-read-model";
import { readSyncCapacity } from "./resource-governor";

interface ReconciliationSummaryRow {
  total: number;
  completed: number;
  active: number;
  waiting: number;
  failed: number;
  updatedAt: string | null;
  nextAttemptAt: string | null;
}

interface ReconciliationErrorRow {
  errorCode: string | null;
  errorMessage: string | null;
}

const emptySummary: ReconciliationSummaryRow = {
  total: 0,
  completed: 0,
  active: 0,
  waiting: 0,
  failed: 0,
  updatedAt: null,
  nextAttemptAt: null,
};

const statusFor = (summary: ReconciliationSummaryRow): ReconciliationStatus => {
  if (summary.failed > 0) return "attention";
  if (summary.active > 0) return "syncing";
  if (summary.waiting > 0) return "waiting";
  if (summary.total === 0) return "unknown";
  return summary.completed === summary.total ? "current" : "attention";
};

const toDto = (
  summary: ReconciliationSummaryRow | null,
  error: ReconciliationErrorRow | null,
): ReconciliationStatusDto => {
  const value = summary ?? emptySummary;
  return {
    status: statusFor(value),
    total: Number(value.total ?? 0),
    completed: Number(value.completed ?? 0),
    active: Number(value.active ?? 0),
    waiting: Number(value.waiting ?? 0),
    pending: Number(value.active ?? 0) + Number(value.waiting ?? 0),
    failed: Number(value.failed ?? 0),
    updatedAt: value.updatedAt,
    nextAttemptAt: value.nextAttemptAt,
    errorCode: error?.errorCode ?? null,
    errorMessage: error?.errorMessage ?? null,
  };
};

interface ReconciliationQuery {
  summary: string;
  error: string;
  summaryBindings?: readonly unknown[];
  errorBindings?: readonly unknown[];
}

interface StatusInstrumentRow {
  id: string;
  exchange: string;
}

interface StatusTransactionRow {
  id: string;
  instrumentId: string;
  tradeDate: string;
  side: "buy" | "sell";
  quantityDecimal: string;
}

interface StatusActionRow {
  id: string;
  instrumentId: string;
  effectiveDate: string;
  numerator: string;
  denominator: string;
}

interface StatusCurrentRow {
  instrumentId: string;
  tradingDate: string | null;
  factValid: number;
  state: string | null;
  effectiveDate: string | null;
  processingLeaseUntil: string | null;
  dispatchLeaseUntil: string | null;
  updatedAt: string | null;
  nextAttemptAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  jobStatus: string | null;
  plannerState: string | null;
  plannerLeaseUntil: string | null;
}

type PortfolioImportStatusRow = Omit<PortfolioImportStatusDto, "active"> & {
  active: number;
};

const latestCompletedTradingDate = (now: string, exchange: string): string => {
  const today = easternMarketDate(now);
  let candidate =
    now >= easternCloseUtc(today) ? today : previousCalendarDate(today);
  while (!isMarketTradingDayForExchange(candidate, exchange)) {
    candidate = previousCalendarDate(candidate);
  }
  return candidate;
};

export class StatusReadModelService {
  constructor(private readonly db: D1Database) {}

  private async heldStockInstruments(
    now: string,
  ): Promise<StatusInstrumentRow[]> {
    const [instruments, transactions, actions] = await Promise.all([
      this.db
        .prepare(
          "SELECT id, exchange FROM instruments WHERE security_type = 'stock'",
        )
        .all<StatusInstrumentRow>(),
      this.db
        .prepare(
          `SELECT id, instrument_id AS instrumentId, trade_date AS tradeDate,
                  side, quantity_decimal AS quantityDecimal
             FROM transactions ORDER BY instrument_id, trade_date, id`,
        )
        .all<StatusTransactionRow>(),
      this.db
        .prepare(
          `SELECT id, instrument_id AS instrumentId,
                  effective_date AS effectiveDate,
                  split_numerator AS numerator,
                  split_denominator AS denominator
             FROM corporate_actions WHERE status = 'active'
            ORDER BY instrument_id, effective_date, id`,
        )
        .all<StatusActionRow>(),
    ]);
    const transactionsByInstrument = new Map<string, StatusTransactionRow[]>();
    for (const row of transactions.results) {
      const values = transactionsByInstrument.get(row.instrumentId) ?? [];
      values.push(row);
      transactionsByInstrument.set(row.instrumentId, values);
    }
    const actionsByInstrument = new Map<string, StatusActionRow[]>();
    for (const row of actions.results) {
      const values = actionsByInstrument.get(row.instrumentId) ?? [];
      values.push(row);
      actionsByInstrument.set(row.instrumentId, values);
    }
    return instruments.results.filter((instrument) => {
      try {
        return (
          deriveHoldings({
            today: easternMarketDate(now),
            transactions: (
              transactionsByInstrument.get(instrument.id) ?? []
            ).map((row) => ({
              id: row.id,
              tradeDate: row.tradeDate,
              side: row.side,
              quantityDecimal: row.quantityDecimal,
            })),
            activeSplits: (actionsByInstrument.get(instrument.id) ?? []).map(
              (row) => ({
                id: row.id,
                effectiveDate: row.effectiveDate,
                numerator: row.numerator,
                denominator: row.denominator,
              }),
            ),
          }).currentQuantity() !== "0"
        );
      } catch {
        return false;
      }
    });
  }

  private async stockValueReconciliation(
    now: string,
    held: readonly StatusInstrumentRow[],
  ): Promise<ReconciliationStatusDto> {
    if (held.length === 0) return toDto(emptySummary, null);
    const heldById = new Map(
      held.map((instrument) => [instrument.id, instrument]),
    );
    const expectedCoverage = held.map((instrument) => ({
      id: instrument.id,
      expectedDate: latestCompletedTradingDate(now, instrument.exchange),
    }));
    const current = await this.db
      .prepare(
        `WITH held AS (
           SELECT json_extract(value, '$.id') AS instrument_id,
                  json_extract(value, '$.expectedDate') AS expected_date
             FROM json_each(?1)
         ), exact_work AS (
           SELECT work.id, work.instrument_id, work.effective_date, work.state,
                  work.processing_lease_until, work.updated_at,
                  work.terminal_error_code, work.terminal_error_message,
                  (SELECT MAX(COALESCE(batch.processing_lease_until,
                                      batch.dispatch_lease_until))
                     FROM dispatch_batch_items item
                     JOIN dispatch_batches batch
                       ON batch.id = item.dispatch_batch_id
                    WHERE item.work_item_id = work.id
                      AND batch.state IN
                        ('dispatching', 'queued', 'processing'))
                    AS dispatch_lease_until
             FROM work_items work JOIN held
               ON held.instrument_id = work.instrument_id
              AND held.expected_date = work.effective_date
            WHERE work.scope = 'global_fact'
              AND work.work_type = 'market_fact'
              AND (
                EXISTS (
                  SELECT 1 FROM job_work_items link
                  JOIN pipeline_jobs job ON job.id = link.pipeline_job_id
                   WHERE link.work_item_id = work.id
                     AND job.sync_lane = 'current'
                     AND job.superseded_at IS NULL
                )
                OR (work.state = 'complete' AND NOT EXISTS (
                  SELECT 1 FROM job_work_items link
                   WHERE link.work_item_id = work.id
                ))
              )
         )
         SELECT held.instrument_id AS instrumentId,
                fact.trading_date AS tradingDate,
                CASE WHEN fact.status = 'valid' THEN 1 ELSE 0 END
                  AS factValid,
                COALESCE(slice.state, intent.status, exact_work.state) AS state,
                held.expected_date AS effectiveDate,
                COALESCE(slice.lease_until,
                         exact_work.processing_lease_until) AS processingLeaseUntil,
                COALESCE(slice.lease_until,
                         exact_work.dispatch_lease_until) AS dispatchLeaseUntil,
                COALESCE(slice.updated_at, intent.updated_at,
                         exact_work.updated_at, fact.updated_at) AS updatedAt,
                intent.next_attempt_at AS nextAttemptAt,
                COALESCE(slice.error_code, intent.last_error_code,
                         exact_work.terminal_error_code) AS errorCode,
                COALESCE(slice.error_message, intent.last_error_message,
                         exact_work.terminal_error_message) AS errorMessage,
                job.status AS jobStatus,
                planner.state AS plannerState,
                planner.processing_lease_until AS plannerLeaseUntil
           FROM held
           LEFT JOIN daily_market_facts fact
             ON fact.instrument_id = held.instrument_id
            AND fact.trading_date = held.expected_date
           LEFT JOIN sync_intents intent ON intent.id = (
             SELECT candidate.id FROM sync_intents candidate
              WHERE candidate.instrument_id = held.instrument_id
                AND candidate.dataset = 'market'
                AND candidate.priority_class = 'current'
                AND candidate.status <> 'superseded'
              ORDER BY candidate.updated_at DESC, candidate.id DESC LIMIT 1
           )
           LEFT JOIN sync_slices slice ON slice.id = (
             SELECT candidate.id FROM sync_slices candidate
              WHERE candidate.intent_id = intent.id
              ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1
           )
           LEFT JOIN exact_work ON exact_work.id = (
             SELECT candidate.id FROM exact_work candidate
              WHERE candidate.instrument_id = held.instrument_id
              ORDER BY candidate.updated_at DESC, candidate.id DESC LIMIT 1
           )
           LEFT JOIN pipeline_jobs job ON job.id = intent.pipeline_job_id
           LEFT JOIN work_items planner
             ON planner.pipeline_job_id = job.id
            AND planner.scope = 'job_planning'`,
      )
      .bind(JSON.stringify(expectedCoverage))
      .all<StatusCurrentRow>();
    const summary = current.results.reduce<ReconciliationSummaryRow>(
      (result, row) => {
        const instrument = heldById.get(row.instrumentId);
        const expectedDate = latestCompletedTradingDate(
          now,
          instrument?.exchange ?? "",
        );
        const activeWork =
          (row.state === "dispatching" || row.state === "queued") &&
          (row.dispatchLeaseUntil ?? "") > now
            ? 1
            : (row.state === "processing" || row.state === "active") &&
                (row.processingLeaseUntil ?? "") > now
              ? 1
              : 0;
        const waitingWork =
          row.state === "pending" ||
          row.state === "waiting" ||
          row.state === "retry" ||
          row.state === "cancelled" ||
          ((row.state === "dispatching" || row.state === "queued") &&
            (row.dispatchLeaseUntil === null ||
              row.dispatchLeaseUntil <= now)) ||
          (row.state === "processing" &&
            (row.processingLeaseUntil === null ||
              row.processingLeaseUntil <= now))
            ? 1
            : 0;
        const plannerActive =
          row.plannerState === "processing" &&
          (row.plannerLeaseUntil ?? "") > now
            ? 1
            : 0;
        const active = Math.max(activeWork, plannerActive);
        const jobUnsettled = ["pending", "planning", "running"].includes(
          row.jobStatus ?? "",
        );
        const waiting = Math.max(
          waitingWork,
          active === 0 && jobUnsettled ? 1 : 0,
        );
        const failed =
          row.state === "terminal" ||
          row.state === "blocked" ||
          row.jobStatus === "terminal" ||
          row.plannerState === "terminal"
            ? 1
            : 0;
        return {
          total: result.total + 1,
          completed:
            result.completed +
            (active === 0 &&
            waiting === 0 &&
            failed === 0 &&
            row.factValid === 1 &&
            row.tradingDate === expectedDate
              ? 1
              : 0),
          active: result.active + active,
          waiting: result.waiting + waiting,
          failed: result.failed + failed,
          updatedAt:
            !result.updatedAt || (row.updatedAt ?? "") > result.updatedAt
              ? (row.updatedAt ?? result.updatedAt)
              : result.updatedAt,
          nextAttemptAt:
            row.nextAttemptAt &&
            (!result.nextAttemptAt || row.nextAttemptAt < result.nextAttemptAt)
              ? row.nextAttemptAt
              : result.nextAttemptAt,
        };
      },
      { ...emptySummary },
    );
    const latestError = [...current.results]
      .filter((row) => row.errorCode || row.errorMessage)
      .sort((left, right) =>
        (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
      )[0];
    return toDto(
      summary,
      latestError
        ? {
            errorCode: latestError.errorCode,
            errorMessage: latestError.errorMessage,
          }
        : null,
    );
  }

  private async reconciliation(
    kind: "stockValues" | "dividends" | "financialReports" | "history",
    now: string,
    held: readonly StatusInstrumentRow[],
  ): Promise<ReconciliationStatusDto> {
    if (kind === "stockValues") return this.stockValueReconciliation(now, held);
    if (kind === "history") {
      const compactCount = await this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM sync_intents
            WHERE priority_class = 'history' AND status <> 'superseded'`,
        )
        .first<{ count: number }>();
      if ((compactCount?.count ?? 0) > 0) {
        const [summary, error] = await Promise.all([
          this.db
            .prepare(
              `SELECT COUNT(*) AS total,
                      COALESCE(SUM(intent.status = 'current'), 0) AS completed,
                      COALESCE(SUM(intent.status = 'active' AND EXISTS (
                        SELECT 1 FROM sync_slices slice
                         WHERE slice.intent_id = intent.id
                           AND slice.state IN ('dispatching', 'queued', 'processing')
                           AND slice.lease_until > ?1
                      )), 0) AS active,
                      COALESCE(SUM(intent.status IN ('pending', 'waiting', 'dispatching')
                        OR (intent.status = 'active' AND NOT EXISTS (
                          SELECT 1 FROM sync_slices slice
                           WHERE slice.intent_id = intent.id
                             AND slice.state IN ('dispatching', 'queued', 'processing')
                             AND slice.lease_until > ?1
                        ))), 0) AS waiting,
                      COALESCE(SUM(intent.status = 'blocked'), 0) AS failed,
                      MAX(intent.updated_at) AS updatedAt,
                      MIN(CASE WHEN intent.status IN ('pending', 'waiting')
                               THEN intent.next_attempt_at END) AS nextAttemptAt
                 FROM sync_intents intent
                WHERE intent.priority_class = 'history'
                  AND intent.status <> 'superseded'`,
            )
            .bind(now)
            .first<ReconciliationSummaryRow>(),
          this.db
            .prepare(
              `SELECT last_error_code AS errorCode,
                      last_error_message AS errorMessage
                 FROM sync_intents
                WHERE priority_class = 'history' AND status = 'blocked'
                ORDER BY updated_at DESC, id DESC LIMIT 1`,
            )
            .first<ReconciliationErrorRow>(),
        ]);
        return toDto(summary, error);
      }
    }
    const heldIds = JSON.stringify(held.map((instrument) => instrument.id));
    const queries: Record<typeof kind, ReconciliationQuery> = {
      dividends: {
        summary: `SELECT COUNT(*) AS total,
                         COALESCE(SUM(status = 'current'), 0) AS completed,
                         COALESCE(SUM(status IN ('dispatching', 'queued',
                           'in_progress') AND lease_until > ?1), 0)
                           AS active,
                         COALESCE(SUM(status IN ('pending', 'retry')
                           OR (status IN ('dispatching', 'queued', 'in_progress') AND
                             (lease_until IS NULL OR lease_until <= ?1))), 0)
                           AS waiting,
                         COALESCE(SUM(status = 'blocked'), 0) AS failed,
                         MAX(updated_at) AS updatedAt,
                         MIN(CASE WHEN status IN ('pending', 'retry')
                           THEN next_attempt_at END) AS nextAttemptAt
                    FROM dividend_refresh_state
                   WHERE instrument_id IN (
                     SELECT CAST(value AS TEXT) FROM json_each(?2)
                   )`,
        summaryBindings: [now, heldIds],
        error: `SELECT last_error_code AS errorCode,
                       last_error_message AS errorMessage
                  FROM dividend_refresh_state
                 WHERE instrument_id IN (
                         SELECT CAST(value AS TEXT) FROM json_each(?1)
                       )
                   AND (last_error_code IS NOT NULL
                    OR last_error_message IS NOT NULL)
                 ORDER BY updated_at DESC, instrument_id DESC LIMIT 1`,
        errorBindings: [heldIds],
      },
      financialReports: {
        summary: `SELECT COUNT(*) AS total,
                         COALESCE(SUM(status = 'current'), 0) AS completed,
                         COALESCE(SUM(status = 'in_progress'
                           AND lease_until > ?1), 0) AS active,
                         COALESCE(SUM(status = 'pending'
                           OR (status = 'retry' AND
                             COALESCE(last_error_code, '') <> 'provider_entitlement')
                           OR (status = 'in_progress' AND
                             (lease_until IS NULL OR lease_until <= ?1))), 0)
                           AS waiting,
                         COALESCE(SUM(status = 'retry'
                           AND last_error_code = 'provider_entitlement'), 0)
                           AS failed,
                         MAX(updated_at) AS updatedAt,
                         MIN(CASE WHEN status IN ('pending', 'retry')
                           THEN next_attempt_at END) AS nextAttemptAt
                    FROM earnings_history_coverage
                   WHERE instrument_id IN (
                     SELECT CAST(value AS TEXT) FROM json_each(?2)
                   )`,
        summaryBindings: [now, heldIds],
        error: `SELECT last_error_code AS errorCode,
                       last_error_message AS errorMessage
                  FROM earnings_history_coverage
                 WHERE instrument_id IN (
                         SELECT CAST(value AS TEXT) FROM json_each(?1)
                       )
                   AND (last_error_code IS NOT NULL
                    OR last_error_message IS NOT NULL)
                 ORDER BY updated_at DESC, instrument_id DESC LIMIT 1`,
        errorBindings: [heldIds],
      },
      history: {
        summary: `WITH per_job AS (
                    SELECT job.*,
                           CASE WHEN EXISTS (
                             SELECT 1 FROM work_items planner
                              WHERE planner.pipeline_job_id = job.id
                                AND planner.scope = 'job_planning'
                                AND planner.state = 'processing'
                                AND planner.processing_lease_until > ?1
                           ) OR EXISTS (
                             SELECT 1 FROM job_work_items link
                             JOIN work_items work ON work.id = link.work_item_id
                              WHERE link.pipeline_job_id = job.id
                                AND link.outcome = 'pending'
                                AND (
                                  (work.state = 'processing'
                                    AND work.processing_lease_until > ?1)
                                  OR (work.state IN ('dispatching', 'queued')
                                    AND EXISTS (
                                      SELECT 1 FROM dispatch_batch_items item
                                      JOIN dispatch_batches batch
                                        ON batch.id = item.dispatch_batch_id
                                       WHERE item.work_item_id = work.id
                                         AND batch.state IN
                                           ('dispatching', 'queued', 'processing')
                                         AND COALESCE(
                                           batch.processing_lease_until,
                                           batch.dispatch_lease_until
                                         ) > ?1
                                    ))
                                )
                           ) THEN 1 ELSE 0 END AS is_active
                      FROM pipeline_jobs job WHERE job.sync_lane = 'history'
                  )
                  SELECT COALESCE(SUM(work_total), 0) AS total,
                         COALESCE(SUM(work_processed), 0) AS completed,
                         COALESCE(SUM(is_active), 0) AS active,
                         COALESCE(SUM(status IN ('pending', 'planning', 'running')
                           AND is_active = 0), 0) AS waiting,
                         COALESCE(SUM(work_failed), 0)
                           + COALESCE(SUM(status = 'terminal'), 0) AS failed,
                         MAX(updated_at) AS updatedAt,
                         (SELECT MIN(work.available_at)
                            FROM job_work_items link
                            JOIN work_items work ON work.id = link.work_item_id
                            JOIN pipeline_jobs job ON job.id = link.pipeline_job_id
                           WHERE job.sync_lane = 'history'
                             AND link.outcome = 'pending'
                             AND work.state = 'pending') AS nextAttemptAt
                    FROM per_job`,
        summaryBindings: [now],
        error: `SELECT work.terminal_error_code AS errorCode,
                       work.terminal_error_message AS errorMessage
                  FROM work_items work
                  JOIN job_work_items link ON link.work_item_id = work.id
                  JOIN pipeline_jobs job ON job.id = link.pipeline_job_id
                 WHERE job.sync_lane = 'history'
                   AND (work.state = 'terminal' OR link.outcome = 'failed')
                 ORDER BY work.updated_at DESC, work.id DESC LIMIT 1`,
      },
    };
    const query = queries[kind];
    let summaryStatement = this.db.prepare(query.summary);
    if (query.summaryBindings) {
      summaryStatement = summaryStatement.bind(...query.summaryBindings);
    }
    let errorStatement = this.db.prepare(query.error);
    if (query.errorBindings) {
      errorStatement = errorStatement.bind(...query.errorBindings);
    }
    const [summary, error] = await Promise.all([
      summaryStatement.first<ReconciliationSummaryRow>(),
      errorStatement.first<ReconciliationErrorRow>(),
    ]);
    return toDto(summary, error);
  }

  async read(input: JobReadModelListInput = {}): Promise<StatusReadModelDto> {
    const now = new Date().toISOString();
    const held = await this.heldStockInstruments(now);
    const [
      earningsCoverage,
      jobs,
      imports,
      stockValues,
      dividends,
      financialReports,
      history,
      capacity,
      historyCoverage,
    ] = await Promise.all([
      new EarningsRepository(this.db).coverage(alphaVantageEarningsProvider),
      new JobReadModelService(this.db).list(input),
      this.db
        .prepare(
          `SELECT id, original_filename AS filename, status,
                  processed_symbols AS processedSymbols,
                  total_symbols AS totalSymbols, failed_rows AS failedRows,
                  result_pipeline_job_id AS resultPipelineJobId,
                  history_pipeline_job_id AS historyPipelineJobId,
                  CASE WHEN status = 'running' AND processing_lease_until > ?1
                    THEN 1 ELSE 0 END AS active,
                  terminal_error_code AS terminalErrorCode,
                  terminal_error_message AS terminalErrorMessage,
                  created_at AS createdAt, updated_at AS updatedAt,
                  completed_at AS completedAt
             FROM import_batches
            WHERE status IN ('pending', 'running', 'committed',
                             'complete_with_errors', 'terminal', 'expired')
            ORDER BY created_at DESC, id DESC LIMIT 25`,
        )
        .bind(now)
        .all<PortfolioImportStatusRow>(),
      this.reconciliation("stockValues", now, held),
      this.reconciliation("dividends", now, held),
      this.reconciliation("financialReports", now, held),
      this.reconciliation("history", now, held),
      readSyncCapacity(this.db, new Date(now)),
      this.db
        .prepare(
          `WITH history AS (
             SELECT * FROM sync_intents
              WHERE priority_class = 'history' AND status <> 'superseded'
           )
           SELECT MIN(target_start_date) AS targetStartDate,
                  (SELECT MAX(coverage.end_date)
                     FROM coverage_intervals coverage
                    WHERE EXISTS (
                      SELECT 1 FROM history intent
                       WHERE intent.instrument_id = coverage.instrument_id
                         AND intent.dataset = coverage.dataset
                         AND coverage.end_date >= intent.target_start_date
                         AND coverage.start_date <= intent.target_end_date
                    )) AS newestCompleteDate,
                  (SELECT MIN(coverage.start_date)
                     FROM coverage_intervals coverage
                    WHERE EXISTS (
                      SELECT 1 FROM history intent
                       WHERE intent.instrument_id = coverage.instrument_id
                         AND intent.dataset = coverage.dataset
                         AND coverage.end_date >= intent.target_start_date
                         AND coverage.start_date <= intent.target_end_date
                    )) AS oldestCompleteDate,
                  COALESCE(SUM(status = 'current'), 0) AS completedIntents,
                  COUNT(*) AS totalIntents,
                  MIN(CASE WHEN status IN ('pending', 'waiting')
                           THEN next_attempt_at END) AS nextAttemptAt
             FROM history`,
        )
        .first<HistoryCoverageDto>(),
    ]);

    return {
      earningsCoverage: earningsCoverage
        ? {
            provider: earningsCoverage.provider,
            coverageStartDate: earningsCoverage.coverageStartDate,
            coverageEndDate: earningsCoverage.coverageEndDate,
            observedAt: earningsCoverage.observedAt,
            status: earningsCoverage.status,
            errorCode: earningsCoverage.errorCode,
            errorMessage: earningsCoverage.errorMessage,
            updatedAt: earningsCoverage.updatedAt,
          }
        : null,
      reconciliation: {
        stockValues,
        dividends,
        financialReports,
        history,
      },
      capacity,
      historyCoverage: historyCoverage ?? {
        targetStartDate: null,
        newestCompleteDate: null,
        oldestCompleteDate: null,
        completedIntents: 0,
        totalIntents: 0,
        nextAttemptAt: null,
      },
      imports: imports.results.map(({ active, ...entry }) => ({
        ...entry,
        active: active === 1,
      })),
      jobs: jobs.jobs,
      nextCursor: jobs.nextCursor
        ? btoa(JSON.stringify(jobs.nextCursor))
        : null,
    };
  }
}
