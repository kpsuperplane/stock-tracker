import type { DispatchBatchRecord } from "../db/dispatch-batches";
import { InstrumentRepository } from "../db/instruments";
import type { WorkItemRecord } from "../db/work-items";
import { isMarketTradingDayForExchange } from "../domain/market-calendar";
import type { SyncSliceMessage } from "../shared/contracts";
import type { PipelineWorkProcessor } from "../worker/pipeline-queue";
import { ResourceGovernor } from "./resource-governor";
import {
  dateAdd,
  intentSelection,
  type SyncDataset,
  type SyncIntentRow,
  type SyncSliceRow,
} from "./sync-intents";

export interface SyncSliceProcessorDependencies {
  db: D1Database;
  processor: PipelineWorkProcessor;
  now?: () => Date;
  newId?: () => string;
}

export class SyncSliceProcessor {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly governor: ResourceGovernor;
  private readonly instruments: InstrumentRepository;

  constructor(private readonly dependencies: SyncSliceProcessorDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
    this.governor = new ResourceGovernor(dependencies.db, this.now, this.newId);
    this.instruments = new InstrumentRepository(dependencies.db);
  }

  async process(message: SyncSliceMessage): Promise<"processed" | "stale"> {
    const timestamp = this.now().toISOString();
    const slice = await this.dependencies.db
      .prepare(
        `SELECT id, intent_id AS intentId, reservation_id AS reservationId,
                requested_start_date AS requestedStartDate,
                requested_end_date AS requestedEndDate, state,
                lease_token AS leaseToken, lease_until AS leaseUntil,
                attempt_count AS attemptCount, max_attempts AS maxAttempts
           FROM sync_slices WHERE id = ?1`,
      )
      .bind(message.syncSliceId)
      .first<SyncSliceRow>();
    if (
      !slice ||
      slice.leaseToken !== message.leaseToken ||
      slice.state !== "queued" ||
      slice.leaseUntil <= timestamp
    ) {
      return "stale";
    }
    const intent = await this.dependencies.db
      .prepare(`${intentSelection} WHERE id = ?1`)
      .bind(slice.intentId)
      .first<SyncIntentRow>();
    if (intent?.status !== "active") return "stale";
    const processingLease = new Date(
      Date.parse(timestamp) + 10 * 60_000,
    ).toISOString();
    const claim = await this.dependencies.db.batch([
      this.dependencies.db
        .prepare(
          `UPDATE sync_slices
              SET state = 'processing', lease_until = ?1,
                  attempt_count = attempt_count + 1, updated_at = ?2
            WHERE id = ?3 AND state = 'queued' AND lease_token = ?4
              AND lease_until > ?2`,
        )
        .bind(processingLease, timestamp, slice.id, message.leaseToken),
      this.dependencies.db
        .prepare(
          `UPDATE sync_intents
              SET attempt_count = attempt_count + 1, updated_at = ?1
            WHERE id = ?2 AND status = 'active'`,
        )
        .bind(timestamp, intent.id),
    ]);
    if ((claim[0]?.meta.changes ?? 0) !== 1) return "stale";
    await this.governor.consume(slice.reservationId);
    const instrument = await this.instruments.findById(intent.instrumentId);
    if (!instrument) {
      await this.finishFailure(slice, intent, "instrument_not_found", false);
      return "processed";
    }
    const dates: string[] = [];
    for (
      let date = slice.requestedStartDate;
      date <= slice.requestedEndDate;
      date = dateAdd(date, 1)
    ) {
      if (isMarketTradingDayForExchange(date, instrument.exchange)) {
        dates.push(date);
      }
    }
    const work = dates.map(
      (date): WorkItemRecord => ({
        id: `${slice.id}:${date}`,
        scope: "global_fact",
        pipelineJobId: null,
        workType: intent.dataset === "analysis" ? "analysis" : "market_fact",
        instrumentId: intent.instrumentId,
        effectiveDate: date,
        dependencyRevision: null,
        forcedRefreshGeneration: null,
        deterministicKey: `${slice.id}:${intent.dataset}:${date}`,
        state: "processing",
        priority: intent.priority,
        attemptCount: slice.attemptCount + 1,
        maxAttempts: slice.maxAttempts,
        dispatchLeaseUntil: null,
        processingLeaseUntil: processingLease,
        resultRevision: null,
        terminalErrorCode: null,
        terminalErrorMessage: null,
        availableAt: null,
        retentionUntil: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
      }),
    );
    const batch: DispatchBatchRecord = {
      id: slice.id,
      workType: intent.dataset === "analysis" ? "analysis" : "market_fact",
      instrumentId: intent.instrumentId,
      requestedStartDate: slice.requestedStartDate,
      requestedEndDate: slice.requestedEndDate,
      state: "processing",
      dispatchLeaseUntil: null,
      processingLeaseUntil: processingLease,
      attemptCount: slice.attemptCount + 1,
      maxAttempts: slice.maxAttempts,
      dispatchAttemptCount: 1,
      dispatchMaxAttempts: 3,
      dlqState: "none",
      dlqAttemptCount: 0,
      dlqLeaseUntil: null,
      dlqLastError: null,
      dlqDeliveredAt: null,
      terminalErrorCode: null,
      terminalErrorMessage: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      completedAt: null,
      retentionUntil: null,
    };
    const process =
      intent.dataset === "analysis"
        ? this.dependencies.processor.processAnalysis
        : this.dependencies.processor.processMarketFact;
    if (!process) {
      await this.finishFailure(slice, intent, "sync_processor_missing", false);
      return "processed";
    }
    const outcomes =
      (await process.call(this.dependencies.processor, { batch, work })) ?? [];
    const failure = outcomes.find((outcome) => outcome.kind !== "complete");
    if (failure) {
      await this.finishFailure(
        slice,
        intent,
        failure.errorCode ?? "sync_slice_failed",
        failure.kind === "retry",
      );
      return "processed";
    }
    await this.finishSuccess(slice, intent, dates);
    return "processed";
  }

  private async finishFailure(
    slice: SyncSliceRow,
    intent: SyncIntentRow,
    code: string,
    retryable: boolean,
  ): Promise<void> {
    const timestamp = this.now().toISOString();
    const exhausted = intent.attemptCount + 1 >= intent.maxAttempts;
    const retry = retryable && !exhausted;
    const retryMinutes =
      [15, 60, 360, 1_440][Math.min(intent.attemptCount, 3)] ?? 1_440;
    const nextAttempt = new Date(
      Date.parse(timestamp) + retryMinutes * 60_000,
    ).toISOString();
    await this.dependencies.db.batch([
      this.dependencies.db
        .prepare(
          `UPDATE sync_slices
              SET state = ?1, error_code = ?2,
                  error_message = 'The compact sync slice did not complete.',
                  completed_at = ?3, updated_at = ?3
            WHERE id = ?4 AND state = 'processing'`,
        )
        .bind(retry ? "retry" : "blocked", code, timestamp, slice.id),
      this.dependencies.db
        .prepare(
          `UPDATE sync_intents
              SET status = ?1, next_attempt_at = ?2,
                  last_error_code = ?3,
                  last_error_message = 'The compact sync slice did not complete.',
                  updated_at = ?4, completed_at = CASE WHEN ?1 = 'blocked'
                                                       THEN ?4 ELSE NULL END
            WHERE id = ?5 AND status = 'active'`,
        )
        .bind(
          retry ? "waiting" : "blocked",
          retry ? nextAttempt : null,
          code,
          timestamp,
          intent.id,
        ),
    ]);
    await this.settlePipelineJob(intent.pipelineJobId, timestamp);
  }

  private async finishSuccess(
    slice: SyncSliceRow,
    intent: SyncIntentRow,
    dates: readonly string[],
  ): Promise<void> {
    const timestamp = this.now().toISOString();
    await this.mergeCoverage(
      intent.instrumentId,
      intent.dataset,
      slice.requestedStartDate,
      slice.requestedEndDate,
      timestamp,
    );
    if (intent.dataset === "market" && dates.length > 0) {
      await this.createQualifyingAnalysisIntents(intent, dates, timestamp);
    }
    const nextCursor = dateAdd(slice.requestedStartDate, -1);
    const complete = nextCursor < intent.targetStartDate;
    await this.dependencies.db.batch([
      this.dependencies.db
        .prepare(
          `UPDATE sync_slices
              SET state = 'complete', completed_at = ?1, updated_at = ?1,
                  result_revision = ?2
            WHERE id = ?3 AND state = 'processing'`,
        )
        .bind(timestamp, `coverage:${timestamp}`, slice.id),
      this.dependencies.db
        .prepare(
          `UPDATE sync_intents
              SET status = ?1,
                  cursor_end_date = CASE WHEN ?1 = 'current'
                                         THEN cursor_end_date ELSE ?2 END,
                  next_attempt_at = NULL, last_error_code = NULL,
                  last_error_message = NULL, updated_at = ?3,
                  completed_at = CASE WHEN ?1 = 'current' THEN ?3 ELSE NULL END
            WHERE id = ?4 AND status = 'active'`,
        )
        .bind(
          complete ? "current" : "pending",
          nextCursor,
          timestamp,
          intent.id,
        ),
    ]);
    await this.settlePipelineJob(intent.pipelineJobId, timestamp);
  }

  private async mergeCoverage(
    instrumentId: string,
    dataset: SyncDataset,
    startDate: string,
    endDate: string,
    timestamp: string,
  ): Promise<void> {
    const overlaps = await this.dependencies.db
      .prepare(
        `SELECT start_date AS startDate, end_date AS endDate
           FROM coverage_intervals
          WHERE instrument_id = ?1 AND dataset = ?2
            AND start_date <= ?3 AND end_date >= ?4`,
      )
      .bind(instrumentId, dataset, dateAdd(endDate, 1), dateAdd(startDate, -1))
      .all<{ startDate: string; endDate: string }>();
    const mergedStart = overlaps.results.reduce(
      (value, row) => (row.startDate < value ? row.startDate : value),
      startDate,
    );
    const mergedEnd = overlaps.results.reduce(
      (value, row) => (row.endDate > value ? row.endDate : value),
      endDate,
    );
    await this.dependencies.db.batch([
      this.dependencies.db
        .prepare(
          `DELETE FROM coverage_intervals
            WHERE instrument_id = ?1 AND dataset = ?2
              AND start_date <= ?3 AND end_date >= ?4`,
        )
        .bind(
          instrumentId,
          dataset,
          dateAdd(endDate, 1),
          dateAdd(startDate, -1),
        ),
      this.dependencies.db
        .prepare(
          `INSERT INTO coverage_intervals
           (instrument_id, dataset, start_date, end_date, source_revision,
            updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
        )
        .bind(instrumentId, dataset, mergedStart, mergedEnd, timestamp),
    ]);
  }

  private async createQualifyingAnalysisIntents(
    intent: SyncIntentRow,
    dates: readonly string[],
    timestamp: string,
  ): Promise<void> {
    const rows = await this.dependencies.db
      .prepare(
        `SELECT trading_date AS tradingDate
           FROM daily_market_facts
          WHERE instrument_id = ?1
            AND trading_date IN (SELECT CAST(value AS TEXT) FROM json_each(?2))
            AND status = 'valid'
            AND ABS(CAST(movement_percent_decimal AS REAL)) >= 5
            AND movement_basis = 'split_adjusted_price_return'
          ORDER BY trading_date DESC`,
      )
      .bind(intent.instrumentId, JSON.stringify(dates))
      .all<{ tradingDate: string }>();
    if (rows.results.length === 0) return;
    await this.dependencies.db.batch(
      rows.results.map((row) =>
        this.dependencies.db
          .prepare(
            `INSERT OR IGNORE INTO sync_intents
             (id, deterministic_key, pipeline_job_id, instrument_id, dataset,
              priority_class, target_start_date, target_end_date,
              cursor_end_date, status, priority, attempt_count, max_attempts,
              created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 'analysis', ?5, ?6, ?6, ?6,
                     'pending', ?7, 0, 3, ?8, ?8)`,
          )
          .bind(
            this.newId(),
            `intent:${intent.id}:analysis:${row.tradingDate}`,
            intent.pipelineJobId,
            intent.instrumentId,
            intent.priorityClass,
            row.tradingDate,
            intent.priority,
            timestamp,
          ),
      ),
    );
  }

  private async settlePipelineJob(
    pipelineJobId: string | null,
    timestamp: string,
  ): Promise<void> {
    if (!pipelineJobId) return;
    await this.dependencies.db
      .prepare(
        `UPDATE pipeline_jobs
            SET status = CASE WHEN sync_intents_failed > 0
                              THEN 'complete_with_errors' ELSE 'complete' END,
                completed_at = ?1, updated_at = ?1, planning_phase = 'complete'
          WHERE id = ?2 AND superseded_at IS NULL
            AND status IN ('pending', 'planning', 'running')
            AND sync_intents_pending = 0`,
      )
      .bind(timestamp, pipelineJobId)
      .run();
  }
}
