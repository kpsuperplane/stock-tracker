import {
  type PipelineJobRecord,
  PipelineJobRepository,
} from "../db/pipeline-jobs";
import {
  RESUMABLE_PLANNING_MAX_ATTEMPTS,
  WorkItemRepository,
} from "../db/work-items";
import { isMarketTradingDayForExchange } from "../domain/market-calendar";
import { ReconciliationPlannerService } from "./reconciliation-planner";

export interface BackfillPipelineStartInput {
  startDate: string;
  endDate: string;
  reprocessExisting: boolean;
  now: string;
}

export interface BackfillPipelineDependencies {
  db: D1Database;
  listActiveSymbols: () => Promise<string[]>;
}

interface PipelineProgress {
  workTotal: number;
  workReused: number;
  workSkipped: number;
  workFetched: number;
  workAnalyzed: number;
  workProcessed: number;
  workFailed: number;
}

interface PipelineDateRow {
  effective_date: string;
  total: number;
  completed: number;
  failed: number;
  unsettled: number;
}

interface PipelineErrorRow {
  id: string;
  symbol: string | null;
  effective_date: string | null;
  work_type: string;
  state: string;
  outcome: string;
  error_code: string | null;
  last_error: string | null;
  attempt_count: number;
}

interface BackfillInstrument {
  id: string;
  exchange: string;
}

const MAX_START_PLANNER_PAGES = 10;
const MAX_CONTINUATION_PAGES = 25;
const MAX_GENERATION_RESERVATION_ATTEMPTS = 5;

const isGenerationReservationConflict = (error: unknown): boolean =>
  /unique constraint|pipeline_jobs_backfill_generation|constraint failed/i.test(
    String(error),
  );

const isRetryableTerminalError = (errorCode: string | null): boolean => {
  if (!errorCode) return false;
  return /(?:timeout|timed[_-]?out|network|abort|provider_(?:429|5\d\d)|http_(?:429|5\d\d)|provider_partial_range|dispatch_attempts_exhausted|pipeline_attempts_exhausted|pipeline_failed)/i.test(
    errorCode,
  );
};

const isContinuationRace = (error: unknown): boolean =>
  /planner_(?:claim|lease|work_item).*conflict|planner_lease_(?:required|unexpected)|pipeline_planner_cursor_conflict|planner_(?:work_item_not_active|work_not_active|completion_conflict)/i.test(
    String(error),
  );

/**
 * Backfill's compatibility adapter for the normalized reconciliation pipeline.
 *
 * The adapter deliberately owns only the orchestration boundary: it creates a
 * pipeline job and its planner work item, then runs the shared planner to
 * materialize durable work. Legacy backfills remain in JobsService and are
 * selected by the route when this adapter is not installed.
 */
export class BackfillPipelineAdapter {
  private readonly pipelineJobs: PipelineJobRepository;
  private readonly workItems: WorkItemRepository;

  constructor(private readonly dependencies: BackfillPipelineDependencies) {
    this.pipelineJobs = new PipelineJobRepository(dependencies.db);
    this.workItems = new WorkItemRepository(dependencies.db);
  }

  async start(input: BackfillPipelineStartInput): Promise<string> {
    const id = crypto.randomUUID();
    const symbols = await this.dependencies.listActiveSymbols();
    const instruments = await this.findInstruments(symbols);
    const instrumentIds = instruments.map((instrument) => instrument.id);
    const plannerWorkItemId = crypto.randomUUID();
    const now = input.now;
    const plannerWorkItem = {
      id: plannerWorkItemId,
      pipelineJobId: id,
      workType: "backfill_reconciliation_plan",
      deterministicKey: WorkItemRepository.planningKey(
        id,
        "backfill_reconciliation_plan",
      ),
      priority: 200,
      maxAttempts: RESUMABLE_PLANNING_MAX_ATTEMPTS,
      createdAt: now,
      updatedAt: now,
    };

    // The unique generation index is the reservation boundary.  If two
    // requests race on MAX()+1, one insert wins and the other retries from the
    // newly persisted pipeline-job generation.  This also allocates a unique
    // generation when the planner ultimately has no work to materialize.
    for (
      let attempt = 0;
      attempt < MAX_GENERATION_RESERVATION_ATTEMPTS;
      attempt += 1
    ) {
      const forcedRefreshGeneration = input.reprocessExisting
        ? await this.nextForcedRefreshGeneration()
        : null;
      const pipelineJob: PipelineJobRecord = {
        id,
        triggerType: "backfill",
        requestedStartDate: input.startDate,
        requestedEndDate: input.endDate,
        affectedInstrumentsJson: JSON.stringify(instrumentIds),
        eligibilityIntervalsJson: JSON.stringify(
          instruments.flatMap((instrument) =>
            weekdaysInRange(input.startDate, input.endDate).flatMap((date) =>
              isMarketTradingDayForExchange(date, instrument.exchange)
                ? [
                    {
                      instrumentId: instrument.id,
                      startDate: date,
                      endDate: date,
                    },
                  ]
                : [],
            ),
          ),
        ),
        priority: 200,
        status: "pending",
        createdAt: now,
        updatedAt: now,
        backfillReprocessExisting: input.reprocessExisting,
        backfillForcedRefreshGeneration: forcedRefreshGeneration,
        plannerCursor: null,
        plannerDividendCursor: null,
        plannerLeaseUntil: null,
      };
      try {
        await this.dependencies.db.batch([
          this.pipelineJobs.createStatement(pipelineJob),
          this.workItems.createPlanningStatement(plannerWorkItem),
          this.dependencies.db
            .prepare(
              `INSERT INTO job_work_items
                 (pipeline_job_id, work_item_id, relationship, outcome, created_at)
               VALUES (?1, ?2, 'required', 'pending', ?3)`,
            )
            .bind(id, plannerWorkItemId, now),
        ]);
        break;
      } catch (error) {
        if (
          !input.reprocessExisting ||
          !isGenerationReservationConflict(error) ||
          attempt === MAX_GENERATION_RESERVATION_ATTEMPTS - 1
        ) {
          throw error;
        }
      }
    }

    await this.planNextPage(id, now);
    // Complete a bounded amount of planning in the creating worker.  Larger
    // ranges retain their cursor and are advanced by the explicit continuation
    // path below; status polling never performs this work.
    await this.continuePlanning(id, now, MAX_START_PLANNER_PAGES);
    await this.completeIfSettled(id, now);

    return id;
  }

  /**
   * Project a pipeline job into the response shape consumed by the existing
   * Backfill page. This is intentionally read-only and does not create a
   * legacy `backfill_jobs` row.
   */
  async getStatus(id: string): Promise<Record<string, unknown> | null> {
    const job = await this.pipelineJobs.findById(id);
    if (!job) return null;
    // Scheduled and ledger jobs are not Backfill resources.  The route may
    // fall through to its legacy lookup for those ids.
    if (job.triggerType !== "backfill") return null;

    const [progress, dateRows, errors, forcedRefreshGeneration, settlement] =
      await Promise.all([
        this.loadProgress(id),
        this.loadDateRows(id),
        this.loadErrors(id),
        this.loadForcedRefreshGeneration(id),
        this.loadSettlement(id),
      ]);
    const projectedStatus = mapPipelineStatus(
      job.status,
      progress.workFailed,
      settlement,
    );
    const dates = weekdaysInRange(job.requestedStartDate, job.requestedEndDate);
    const runs = dates.map((date) => {
      const row = dateRows.find(
        (candidate) => candidate.effective_date === date,
      );
      if (!row) {
        return {
          date,
          tradingDate: date,
          status: ["complete", "complete_with_errors"].includes(projectedStatus)
            ? "skipped"
            : "pending",
          tickerJobsTotal: 0,
          tickerJobsProcessed: 0,
          tickerJobsFailed: 0,
          tickersFailed: 0,
        };
      }
      const failed = Number(row.failed) > 0;
      const complete = Number(row.unsettled ?? 0) === 0;
      return {
        date,
        tradingDate: date,
        status: !complete
          ? "running"
          : failed
            ? "complete_with_errors"
            : "complete",
        tickerJobsTotal: Number(row.total),
        tickerJobsProcessed: Number(row.completed),
        tickerJobsFailed: Number(row.failed),
        tickersFailed: Number(row.failed),
      };
    });

    const status = projectedStatus;
    const datesProcessed = runs.filter((run) =>
      ["complete", "complete_with_errors", "skipped"].includes(run.status),
    ).length;
    const pipeline = {
      id: job.id,
      status: projectedStatus,
      triggerType: job.triggerType,
      requestedStartDate: job.requestedStartDate,
      requestedEndDate: job.requestedEndDate,
      progress,
      forcedRefreshGeneration,
      reprocessExisting: job.backfillReprocessExisting === true,
      plannerCursor: job.plannerCursor,
      plannerDividendCursor: job.plannerDividendCursor,
      startedAt: job.startedAt ?? null,
      completedAt: job.completedAt ?? null,
    };

    return {
      id: job.id,
      start_date: job.requestedStartDate,
      end_date: job.requestedEndDate,
      created_at: job.createdAt,
      updated_at: job.updatedAt,
      started_at: job.startedAt ?? null,
      completed_at: job.completedAt ?? null,
      reprocess_existing: job.backfillReprocessExisting === true,
      forcedRefreshGeneration,
      pipeline_job_id: job.id,
      status,
      dates_total: dates.length,
      dates_processed: datesProcessed,
      ticker_jobs_total: progress.workTotal,
      ticker_jobs_processed: progress.workProcessed,
      ticker_jobs_failed: progress.workFailed,
      work_reused: progress.workReused,
      work_skipped: progress.workSkipped,
      work_fetched: progress.workFetched,
      work_analyzed: progress.workAnalyzed,
      work_processed: progress.workProcessed,
      work_failed: progress.workFailed,
      runs,
      errors,
      pipeline,
      pipelineJob: pipeline,
    };
  }

  private async findInstruments(
    symbols: string[],
  ): Promise<BackfillInstrument[]> {
    if (symbols.length === 0) return [];
    const result = await this.dependencies.db
      .prepare(
        `SELECT id, exchange
           FROM instruments
          WHERE UPPER(symbol) IN (SELECT UPPER(value) FROM json_each(?1))
          ORDER BY symbol`,
      )
      .bind(JSON.stringify(symbols))
      .all<BackfillInstrument>();
    return result.results;
  }

  private async planNextPage(
    pipelineJobId: string,
    now: string,
  ): Promise<void> {
    const job = await this.pipelineJobs.findById(pipelineJobId);
    if (!job) throw new Error("pipeline_job_not_found");
    const plannerWork = await this.workItems.findPlanningForJob(pipelineJobId);
    if (!plannerWork) throw new Error("planner_work_item_missing");
    if (plannerWork.state === "complete" || plannerWork.state === "terminal") {
      return;
    }
    const planner = new ReconciliationPlannerService({
      db: this.dependencies.db,
      now: () => new Date(now),
    });
    const plannerLeaseUntil =
      job.plannerLeaseUntil ?? plannerWork.processingLeaseUntil;
    const page = await planner.planPage({
      pipelineJobId,
      plannerWorkItemId: plannerWork.id,
      ...(job.plannerCursor === undefined ? {} : { cursor: job.plannerCursor }),
      ...(job.plannerDividendCursor === undefined
        ? {}
        : { dividendCursor: job.plannerDividendCursor }),
      ...(plannerLeaseUntil ? { plannerLeaseUntil } : {}),
      ...(job.backfillReprocessExisting
        ? {
            forceRefresh: true,
            reprocessExisting: true,
            forcedRefreshGeneration: job.backfillForcedRefreshGeneration ?? 1,
          }
        : {}),
    });
    if (page.dividendRecalculations.length > 0) {
      await this.dependencies.db.batch(
        page.dividendRecalculations.map((event) =>
          this.dependencies.db
            .prepare(
              `INSERT OR IGNORE INTO pipeline_job_dividend_recalculations
               (pipeline_job_id, instrument_id, ex_date, created_at)
               VALUES (?1, ?2, ?3, ?4)`,
            )
            .bind(pipelineJobId, event.instrumentId, event.exDate, now),
        ),
      );
    }
    const updated = await this.pipelineJobs.updatePlannerCursor({
      id: pipelineJobId,
      cursor: page.nextCursor,
      dividendCursor: page.nextDividendCursor,
      leaseUntil: page.plannerLeaseUntil,
      now,
    });
    if (!updated) throw new Error("pipeline_planner_cursor_conflict");
  }

  /**
   * Explicit, browser-independent planner continuation.  A bounded number of
   * pages is processed per invocation; the persisted cursor remains the
   * durable trigger for the next worker invocation when more work remains.
   */
  async continuePlanning(
    pipelineJobId: string,
    now = new Date().toISOString(),
    maxPages = MAX_CONTINUATION_PAGES,
  ): Promise<{ pages: number; complete: boolean }> {
    const pageLimit = Math.max(1, Math.min(MAX_CONTINUATION_PAGES, maxPages));
    let pages = 0;
    while (pages < pageLimit) {
      const job = await this.pipelineJobs.findById(pipelineJobId);
      if (
        job?.triggerType !== "backfill" ||
        job.status === "complete" ||
        job.status === "complete_with_errors" ||
        job.status === "terminal"
      ) {
        return { pages, complete: true };
      }
      const plannerWork =
        await this.workItems.findPlanningForJob(pipelineJobId);
      if (
        !plannerWork ||
        plannerWork.state === "complete" ||
        plannerWork.state === "terminal"
      ) {
        await this.completeIfSettled(pipelineJobId, now);
        return { pages, complete: true };
      }
      try {
        await this.planNextPage(pipelineJobId, now);
      } catch (error) {
        // Another worker may have claimed the planner between the read above
        // and this page.  Its lease/cursor is the authoritative continuation;
        // an explicit worker invocation should be idempotent in that case.
        if (isContinuationRace(error)) {
          await this.completeIfSettled(pipelineJobId, now);
          return { pages, complete: false };
        }
        throw error;
      }
      pages += 1;
      const advanced = await this.pipelineJobs.findById(pipelineJobId);
      if (
        !advanced ||
        (advanced.plannerCursor === null &&
          advanced.plannerDividendCursor === null)
      ) {
        await this.completeIfSettled(pipelineJobId, now);
        return { pages, complete: true };
      }
    }
    await this.completeIfSettled(pipelineJobId, now);
    return { pages, complete: false };
  }

  async retry(input: {
    pipelineJobId: string;
    workItemId: string;
    now: string;
  }): Promise<
    | { kind: "queued"; workItemId: string }
    | { kind: "not_found" }
    | { kind: "not_retryable" }
  > {
    const job = await this.pipelineJobs.findById(input.pipelineJobId);
    const work = await this.workItems.findById(input.workItemId);
    if (!job || !work || work.scope !== "global_fact") {
      return { kind: "not_found" };
    }
    if (job.triggerType !== "backfill") return { kind: "not_retryable" };
    if (
      !(await this.workItems.isLinkedToJob({
        pipelineJobId: input.pipelineJobId,
        workItemId: input.workItemId,
      }))
    ) {
      return { kind: "not_found" };
    }
    if (
      work.state !== "terminal" ||
      !isRetryableTerminalError(work.terminalErrorCode)
    ) {
      return { kind: "not_retryable" };
    }
    const reset = await this.workItems.resetForRetry({
      id: input.workItemId,
      pipelineJobId: input.pipelineJobId,
      expectedUpdatedAt: work.updatedAt,
      now: input.now,
    });
    if (!reset) return { kind: "not_retryable" };
    if (
      job.status === "complete" ||
      job.status === "complete_with_errors" ||
      job.status === "terminal"
    ) {
      await this.pipelineJobs.reopenForRetry({
        id: input.pipelineJobId,
        now: input.now,
      });
    }
    return { kind: "queued", workItemId: input.workItemId };
  }

  private async nextForcedRefreshGeneration(): Promise<number> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT COALESCE(MAX(generation), 0) + 1 AS next_generation
           FROM (
             SELECT backfill_forced_refresh_generation AS generation
               FROM pipeline_jobs
              WHERE backfill_forced_refresh_generation IS NOT NULL
             UNION ALL
             SELECT forced_refresh_generation AS generation
               FROM work_items
              WHERE scope = 'global_fact'
                AND forced_refresh_generation IS NOT NULL
           )`,
      )
      .first<{ next_generation: number }>();
    return Math.max(1, Number(row?.next_generation ?? 1));
  }

  private async loadProgress(pipelineJobId: string): Promise<PipelineProgress> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT
           p.work_total AS stored_work_total,
           p.work_reused AS stored_work_reused,
           p.work_skipped AS stored_work_skipped,
           p.work_fetched AS stored_work_fetched,
           p.work_analyzed AS stored_work_analyzed,
           p.work_processed AS stored_work_processed,
           p.work_failed AS stored_work_failed,
           COUNT(work.id) AS linked_work_total,
           SUM(CASE WHEN link.outcome = 'reused' THEN 1 ELSE 0 END) AS linked_work_reused,
           SUM(CASE WHEN link.outcome = 'skipped' THEN 1 ELSE 0 END) AS linked_work_skipped,
           SUM(CASE WHEN work.work_type = 'market_fact' AND work.state = 'complete'
                    AND link.outcome = 'processed' THEN 1 ELSE 0 END) AS linked_work_fetched,
           SUM(CASE WHEN work.work_type = 'analysis' AND work.state = 'complete'
                    AND link.outcome = 'processed' THEN 1 ELSE 0 END) AS linked_work_analyzed,
           SUM(CASE WHEN work.state = 'complete' AND link.outcome <> 'failed'
                    THEN 1 ELSE 0 END) AS linked_work_processed,
           SUM(CASE WHEN link.outcome = 'failed' OR work.state = 'terminal'
                    THEN 1 ELSE 0 END) AS linked_work_failed
         FROM pipeline_jobs p
         LEFT JOIN job_work_items link ON link.pipeline_job_id = p.id
         LEFT JOIN work_items work
           ON work.id = link.work_item_id AND work.scope = 'global_fact'
        WHERE p.id = ?1
        GROUP BY p.id`,
      )
      .bind(pipelineJobId)
      .first<Record<string, number | null>>();
    return {
      workTotal: Math.max(
        Number(row?.stored_work_total ?? 0),
        Number(row?.linked_work_total ?? 0),
      ),
      workReused: Math.max(
        Number(row?.stored_work_reused ?? 0),
        Number(row?.linked_work_reused ?? 0),
      ),
      workSkipped: Math.max(
        Number(row?.stored_work_skipped ?? 0),
        Number(row?.linked_work_skipped ?? 0),
      ),
      workFetched: Math.max(
        Number(row?.stored_work_fetched ?? 0),
        Number(row?.linked_work_fetched ?? 0),
      ),
      workAnalyzed: Math.max(
        Number(row?.stored_work_analyzed ?? 0),
        Number(row?.linked_work_analyzed ?? 0),
      ),
      // Planner skips are settled work even though they have no global row.
      // Include them without double-counting jobs created after the planner's
      // persisted processed counter was upgraded to include skips.
      workProcessed: Math.max(
        Number(row?.stored_work_processed ?? 0),
        Number(row?.linked_work_processed ?? 0) +
          Math.max(
            Number(row?.stored_work_skipped ?? 0),
            Number(row?.linked_work_skipped ?? 0),
          ),
      ),
      // A targeted retry clears the terminal work state. Do not retain the
      // previous failure counter as if it were still an active error.
      workFailed: Number(row?.linked_work_failed ?? 0),
    };
  }

  private async loadDateRows(
    pipelineJobId: string,
  ): Promise<PipelineDateRow[]> {
    const result = await this.dependencies.db
      .prepare(
        `SELECT
           w.effective_date,
           COUNT(*) AS total,
           SUM(CASE WHEN w.state = 'complete' AND j.outcome <> 'failed'
                    THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN w.state = 'terminal' OR j.outcome = 'failed'
                    THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN j.outcome = 'pending'
                     AND w.state IN ('pending', 'dispatching', 'queued', 'processing')
                    THEN 1 ELSE 0 END) AS unsettled
         FROM job_work_items j
         JOIN work_items w ON w.id = j.work_item_id
        WHERE j.pipeline_job_id = ?1
          AND w.scope = 'global_fact'
          AND w.effective_date IS NOT NULL
        GROUP BY w.effective_date
        ORDER BY w.effective_date`,
      )
      .bind(pipelineJobId)
      .all<PipelineDateRow>();
    return result.results;
  }

  private async loadErrors(
    pipelineJobId: string,
  ): Promise<Record<string, unknown>[]> {
    const result = await this.dependencies.db
      .prepare(
        `SELECT w.id, i.symbol, w.effective_date, w.work_type, w.state,
                j.outcome,
                w.terminal_error_code AS error_code,
                w.terminal_error_message AS last_error, w.attempt_count
           FROM job_work_items j
           JOIN work_items w ON w.id = j.work_item_id
           LEFT JOIN instruments i ON i.id = w.instrument_id
          WHERE j.pipeline_job_id = ?1
            AND w.scope = 'global_fact'
            AND (w.state = 'terminal' OR j.outcome = 'failed')
          ORDER BY w.effective_date, w.id`,
      )
      .bind(pipelineJobId)
      .all<PipelineErrorRow>();
    return result.results.map((row) => ({
      workItemId: row.id,
      screeningId: row.id,
      symbol: row.symbol ?? "",
      date: row.effective_date,
      tradingDate: row.effective_date ?? "",
      workType: row.work_type,
      state: row.state,
      errorCode:
        row.error_code ??
        (row.outcome === "failed" ? "shared_work_failed" : null),
      errorMessage:
        row.last_error ??
        (row.outcome === "failed"
          ? "This shared work item failed for this backfill."
          : null),
      message:
        row.last_error ??
        (row.outcome === "failed"
          ? "This shared work item failed for this backfill."
          : null),
      attemptCount: Number(row.attempt_count),
      retryable:
        row.state === "terminal" && isRetryableTerminalError(row.error_code),
    }));
  }

  private async loadForcedRefreshGeneration(
    pipelineJobId: string,
  ): Promise<number | null> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT COALESCE(
                  MAX(w.forced_refresh_generation),
                  p.backfill_forced_refresh_generation
                ) AS generation
           FROM pipeline_jobs p
           LEFT JOIN job_work_items j ON j.pipeline_job_id = p.id
           LEFT JOIN work_items w
             ON w.id = j.work_item_id
            AND w.scope = 'global_fact'
            AND w.forced_refresh_generation IS NOT NULL
          WHERE p.id = ?1
          GROUP BY p.id, p.backfill_forced_refresh_generation`,
      )
      .bind(pipelineJobId)
      .first<{ generation: number | null }>();
    return row?.generation === null || row?.generation === undefined
      ? null
      : Number(row.generation);
  }

  private async loadSettlement(pipelineJobId: string): Promise<{
    complete: boolean;
    failed: number;
  }> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT pipeline.planner_cursor,
                pipeline.planner_dividend_cursor,
                planner.state AS planner_state,
                (SELECT COUNT(*)
                   FROM job_work_items link
                   JOIN work_items work ON work.id = link.work_item_id
                  WHERE link.pipeline_job_id = pipeline.id
                    AND work.scope = 'global_fact'
                    AND link.outcome = 'pending'
                    AND work.state IN ('pending', 'dispatching', 'queued', 'processing'))
                  AS unsettled,
                (SELECT COUNT(*)
                   FROM job_work_items link
                   JOIN work_items work ON work.id = link.work_item_id
                  WHERE link.pipeline_job_id = pipeline.id
                    AND work.scope = 'global_fact'
                    AND (work.state = 'terminal' OR link.outcome = 'failed')) AS failed
           FROM pipeline_jobs pipeline
           LEFT JOIN work_items planner
             ON planner.pipeline_job_id = pipeline.id
            AND planner.scope = 'job_planning'
          WHERE pipeline.id = ?1`,
      )
      .bind(pipelineJobId)
      .first<{
        planner_cursor: string | null;
        planner_dividend_cursor: string | null;
        planner_state: string | null;
        unsettled: number | null;
        failed: number | null;
      }>();
    const complete =
      row?.planner_state === "complete" &&
      row?.planner_cursor === null &&
      row?.planner_dividend_cursor === null &&
      Number(row.unsettled ?? 0) === 0;
    return { complete, failed: Number(row?.failed ?? 0) };
  }

  private async completeIfSettled(id: string, now: string): Promise<void> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT
           pipeline.status AS pipeline_status,
           pipeline.planner_cursor,
           pipeline.planner_dividend_cursor,
           planner.state AS planner_state,
           COUNT(work.id) AS total,
           SUM(CASE WHEN link.outcome = 'pending'
                     AND work.state IN ('pending', 'dispatching', 'queued', 'processing')
                    THEN 1 ELSE 0 END) AS unsettled,
           SUM(CASE WHEN work.state = 'terminal' OR link.outcome = 'failed'
                    THEN 1 ELSE 0 END) AS terminal
         FROM pipeline_jobs pipeline
         LEFT JOIN work_items planner
           ON planner.pipeline_job_id = pipeline.id
          AND planner.scope = 'job_planning'
         LEFT JOIN job_work_items link
           ON link.pipeline_job_id = pipeline.id
         LEFT JOIN work_items work
           ON work.id = link.work_item_id AND work.scope = 'global_fact'
        WHERE pipeline.id = ?1`,
      )
      .bind(id)
      .first<{
        pipeline_status: PipelineJobRecord["status"];
        planner_cursor: string | null;
        planner_dividend_cursor: string | null;
        planner_state: string | null;
        total: number;
        unsettled: number | null;
        terminal: number | null;
      }>();
    if (
      !row ||
      !["pending", "planning", "running"].includes(row.pipeline_status) ||
      row.planner_state !== "complete" ||
      row.planner_cursor !== null ||
      row.planner_dividend_cursor !== null
    ) {
      return;
    }
    if (Number(row?.unsettled ?? 0) > 0) return;
    const to =
      Number(row?.terminal ?? 0) > 0 ? "complete_with_errors" : "complete";
    await this.pipelineJobs.transition({
      id,
      from: row.pipeline_status,
      to,
      now,
    });
  }
}

function mapPipelineStatus(
  status: PipelineJobRecord["status"],
  failed: number,
  settlement?: { complete: boolean; failed: number },
): string {
  if (status === "complete_with_errors") return "complete_with_errors";
  if (status === "complete") return "complete";
  if (status === "terminal") return "failed";
  // Completion is projected from settled children for read-only status
  // requests.  The persisted transition is performed by the explicit worker
  // continuation path, so polling never mutates the pipeline job.
  if (settlement?.complete) {
    return settlement.failed > 0 || failed > 0
      ? "complete_with_errors"
      : "complete";
  }
  // Terminal children do not settle the compatibility job until every other
  // linked work item has reached a terminal state.
  if (status === "running" || status === "planning" || status === "pending") {
    return "running";
  }
  if (failed > 0) return "complete_with_errors";
  return "running";
}

function weekdaysInRange(
  startDate: string | null,
  endDate: string | null,
): string[] {
  if (!startDate || !endDate) return [];
  const dates: string[] = [];
  const cursor = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  while (cursor <= end) {
    const weekday = cursor.getUTCDay();
    if (weekday !== 0 && weekday !== 6)
      dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export function backfillPipelineFlagEnabled(env: {
  BACKFILL_RECONCILIATION_PIPELINE_ENABLED?: unknown;
  BACKFILL_PIPELINE_ENABLED?: unknown;
  ENABLE_BACKFILL_PIPELINE?: unknown;
  ENABLE_BACKFILL_RECONCILIATION_PIPELINE?: unknown;
}): boolean {
  const value =
    env.BACKFILL_RECONCILIATION_PIPELINE_ENABLED ??
    env.BACKFILL_PIPELINE_ENABLED ??
    env.ENABLE_BACKFILL_PIPELINE ??
    env.ENABLE_BACKFILL_RECONCILIATION_PIPELINE;
  return (
    value === true ||
    (typeof value === "string" &&
      ["1", "true", "on", "enabled"].includes(value.toLowerCase()))
  );
}
