import {
  type PipelineJobRecord,
  PipelineJobRepository,
} from "../db/pipeline-jobs";
import { WorkItemRepository } from "../db/work-items";
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
}

interface PipelineErrorRow {
  id: string;
  effective_date: string | null;
  work_type: string;
  state: string;
  error_code: string | null;
  last_error: string | null;
  attempt_count: number;
}

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
    const instrumentIds = await this.findInstrumentIds(symbols);
    const plannerWorkItemId = crypto.randomUUID();
    const now = input.now;
    const pipelineJob: PipelineJobRecord = {
      id,
      triggerType: "backfill",
      requestedStartDate: input.startDate,
      requestedEndDate: input.endDate,
      affectedInstrumentsJson: JSON.stringify(instrumentIds),
      // Backfills retain the legacy weekday contract while the planner still
      // expands each date against each instrument's holding timeline. Keeping
      // these intervals unscoped lets one shared planner handle a multi-
      // instrument book without duplicating the date list per instrument.
      eligibilityIntervalsJson: JSON.stringify(
        weekdaysInRange(input.startDate, input.endDate).map((date) => ({
          startDate: date,
          endDate: date,
        })),
      ),
      priority: 200,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };

    const plannerWorkItem = {
      id: plannerWorkItemId,
      pipelineJobId: id,
      workType: "backfill_reconciliation_plan",
      deterministicKey: WorkItemRepository.planningKey(
        id,
        "backfill_reconciliation_plan",
      ),
      priority: 200,
      maxAttempts: 5,
      createdAt: now,
      updatedAt: now,
    };

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

    const forcedRefreshGeneration = input.reprocessExisting
      ? await this.nextForcedRefreshGeneration()
      : undefined;
    const planner = new ReconciliationPlannerService({
      db: this.dependencies.db,
      now: () => new Date(now),
    });

    let cursor: string | null = null;
    let plannerLeaseUntil: string | null = null;
    let complete = false;
    while (!complete) {
      const page = await planner.planPage({
        pipelineJobId: id,
        plannerWorkItemId,
        cursor,
        pageSize: 100,
        reprocessExisting: input.reprocessExisting,
        ...(plannerLeaseUntil ? { plannerLeaseUntil } : {}),
        ...(forcedRefreshGeneration !== undefined
          ? { forcedRefreshGeneration }
          : {}),
      });
      cursor = page.nextCursor;
      plannerLeaseUntil = page.plannerLeaseUntil;
      complete = page.complete;
    }

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

    const [progress, dateRows, errors, forcedRefreshGeneration] =
      await Promise.all([
        this.loadProgress(id),
        this.loadDateRows(id),
        this.loadErrors(id),
        this.loadForcedRefreshGeneration(id),
      ]);
    const dates = weekdaysInRange(job.requestedStartDate, job.requestedEndDate);
    const runs = dates.map((date) => {
      const row = dateRows.find(
        (candidate) => candidate.effective_date === date,
      );
      if (!row) {
        return {
          date,
          tradingDate: date,
          status: ["complete", "complete_with_errors", "terminal"].includes(
            job.status,
          )
            ? "skipped"
            : "pending",
          tickerJobsTotal: 0,
          tickerJobsProcessed: 0,
          tickerJobsFailed: 0,
          tickersFailed: 0,
        };
      }
      const failed = Number(row.failed) > 0;
      const complete = Number(row.completed) === Number(row.total);
      return {
        date,
        tradingDate: date,
        status: failed
          ? "complete_with_errors"
          : complete
            ? "complete"
            : "running",
        tickerJobsTotal: Number(row.total),
        tickerJobsProcessed: Number(row.completed),
        tickerJobsFailed: Number(row.failed),
        tickersFailed: Number(row.failed),
      };
    });

    const status = mapPipelineStatus(job.status, progress.workFailed);
    const datesProcessed = runs.filter((run) =>
      ["complete", "complete_with_errors", "skipped"].includes(run.status),
    ).length;
    const pipeline = {
      id: job.id,
      status: job.status,
      triggerType: job.triggerType,
      requestedStartDate: job.requestedStartDate,
      requestedEndDate: job.requestedEndDate,
      progress,
      forcedRefreshGeneration,
    };

    return {
      id: job.id,
      start_date: job.requestedStartDate,
      end_date: job.requestedEndDate,
      reprocess_existing: forcedRefreshGeneration !== null,
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

  private async findInstrumentIds(symbols: string[]): Promise<string[]> {
    if (symbols.length === 0) return [];
    const result = await this.dependencies.db
      .prepare(
        `SELECT id
           FROM instruments
          WHERE UPPER(symbol) IN (SELECT UPPER(value) FROM json_each(?1))
          ORDER BY symbol`,
      )
      .bind(JSON.stringify(symbols))
      .all<{ id: string }>();
    return result.results.map((row) => row.id);
  }

  private async nextForcedRefreshGeneration(): Promise<number> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT COALESCE(MAX(forced_refresh_generation), 0) + 1 AS next_generation
           FROM work_items
          WHERE scope = 'global'`,
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
                    THEN 1 ELSE 0 END) AS linked_work_fetched,
           SUM(CASE WHEN work.work_type = 'analysis' AND work.state = 'complete'
                    THEN 1 ELSE 0 END) AS linked_work_analyzed,
           SUM(CASE WHEN work.state = 'complete' THEN 1 ELSE 0 END) AS linked_work_processed,
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
      workProcessed: Math.max(
        Number(row?.stored_work_processed ?? 0),
        Number(row?.linked_work_processed ?? 0),
      ),
      workFailed: Math.max(
        Number(row?.stored_work_failed ?? 0),
        Number(row?.linked_work_failed ?? 0),
      ),
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
           SUM(CASE WHEN w.state = 'complete' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN w.state = 'terminal' THEN 1 ELSE 0 END) AS failed
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
        `SELECT w.id, w.effective_date, w.work_type, w.state,
                w.terminal_error_code AS error_code,
                w.terminal_error_message AS last_error, w.attempt_count
           FROM job_work_items j
           JOIN work_items w ON w.id = j.work_item_id
          WHERE j.pipeline_job_id = ?1
            AND w.scope = 'global_fact'
            AND w.state = 'terminal'
          ORDER BY w.effective_date, w.id`,
      )
      .bind(pipelineJobId)
      .all<PipelineErrorRow>();
    return result.results.map((row) => ({
      workItemId: row.id,
      date: row.effective_date,
      workType: row.work_type,
      state: row.state,
      errorCode: row.error_code,
      errorMessage: row.last_error,
      message: row.last_error,
      attemptCount: Number(row.attempt_count),
      retryable: true,
    }));
  }

  private async loadForcedRefreshGeneration(
    pipelineJobId: string,
  ): Promise<number | null> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT MAX(w.forced_refresh_generation) AS generation
           FROM job_work_items j
           JOIN work_items w ON w.id = j.work_item_id
          WHERE j.pipeline_job_id = ?1
            AND w.scope = 'global_fact'
            AND w.forced_refresh_generation IS NOT NULL`,
      )
      .bind(pipelineJobId)
      .first<{ generation: number | null }>();
    return row?.generation === null || row?.generation === undefined
      ? null
      : Number(row.generation);
  }

  private async completeIfSettled(id: string, now: string): Promise<void> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT
           COUNT(work.id) AS total,
           SUM(CASE WHEN work.state IN ('pending', 'dispatching', 'queued', 'processing')
                    THEN 1 ELSE 0 END) AS unsettled,
           SUM(CASE WHEN work.state = 'terminal' THEN 1 ELSE 0 END) AS terminal
         FROM job_work_items link
         JOIN work_items work ON work.id = link.work_item_id
        WHERE link.pipeline_job_id = ?1
          AND work.scope = 'global_fact'`,
      )
      .bind(id)
      .first<{
        total: number;
        unsettled: number | null;
        terminal: number | null;
      }>();
    if (Number(row?.unsettled ?? 0) > 0) return;
    const to =
      Number(row?.terminal ?? 0) > 0 ? "complete_with_errors" : "complete";
    await this.pipelineJobs.transition({
      id,
      from: "running",
      to,
      now,
    });
  }
}

function mapPipelineStatus(
  status: PipelineJobRecord["status"],
  failed: number,
): string {
  if (status === "complete_with_errors" || failed > 0)
    return "complete_with_errors";
  if (status === "complete") return "complete";
  if (status === "terminal") return "failed";
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
