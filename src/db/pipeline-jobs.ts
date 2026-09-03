export type PipelineJobTrigger =
  | "scheduled"
  | "ledger_reconciliation"
  | "backfill";
export type PipelineJobStatus =
  | "pending"
  | "planning"
  | "running"
  | "complete"
  | "complete_with_errors"
  | "terminal";
export type PipelineSyncLane = "current" | "history";
export type PipelinePlanningPhase =
  | "market"
  | "analysis"
  | "dividends"
  | "complete";

export interface PipelineJobRecord {
  id: string;
  triggerType: PipelineJobTrigger;
  requestedStartDate: string | null;
  requestedEndDate: string | null;
  affectedInstrumentsJson: string;
  eligibilityIntervalsJson: string;
  priority: number;
  status: PipelineJobStatus;
  createdAt: string;
  updatedAt: string;
  backfillReprocessExisting?: boolean;
  backfillForcedRefreshGeneration?: number | null;
  plannerCursor?: string | null;
  plannerDividendCursor?: string | null;
  plannerLeaseUntil?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  syncLane?: PipelineSyncLane;
  jobGroupId?: string | null;
  planningPhase?: PipelinePlanningPhase;
  workTotal?: number;
  workReused?: number;
  workSkipped?: number;
  workFetched?: number;
  workAnalyzed?: number;
  workProcessed?: number;
  workFailed?: number;
  marketWorkPending?: number;
  analysisWorkPending?: number;
}

export interface PipelineJobProgress {
  workTotal: number;
  workReused: number;
  workSkipped: number;
  workFetched: number;
  workAnalyzed: number;
  workProcessed: number;
  workFailed: number;
}

interface PipelineJobRow {
  id: string;
  trigger_type: PipelineJobTrigger;
  requested_start_date: string | null;
  requested_end_date: string | null;
  affected_instruments_json: string;
  eligibility_intervals_json: string;
  priority: number;
  status: PipelineJobStatus;
  created_at: string;
  updated_at: string;
  backfill_reprocess_existing: number;
  backfill_forced_refresh_generation: number | null;
  planner_cursor: string | null;
  planner_dividend_cursor: string | null;
  planner_lease_until: string | null;
  started_at: string | null;
  completed_at: string | null;
  sync_lane: PipelineSyncLane;
  job_group_id: string | null;
  planning_phase: PipelinePlanningPhase;
  work_total: number;
  work_reused: number;
  work_skipped: number;
  work_fetched: number;
  work_analyzed: number;
  work_processed: number;
  work_failed: number;
  market_work_pending: number;
  analysis_work_pending: number;
}

const mapPipelineJob = (row: PipelineJobRow): PipelineJobRecord => ({
  id: row.id,
  triggerType: row.trigger_type,
  requestedStartDate: row.requested_start_date,
  requestedEndDate: row.requested_end_date,
  affectedInstrumentsJson: row.affected_instruments_json,
  eligibilityIntervalsJson: row.eligibility_intervals_json,
  priority: row.priority,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  backfillReprocessExisting: row.backfill_reprocess_existing === 1,
  backfillForcedRefreshGeneration: row.backfill_forced_refresh_generation,
  plannerCursor: row.planner_cursor,
  plannerDividendCursor: row.planner_dividend_cursor,
  plannerLeaseUntil: row.planner_lease_until,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  syncLane: row.sync_lane,
  jobGroupId: row.job_group_id,
  planningPhase: row.planning_phase,
  workTotal: row.work_total,
  workReused: row.work_reused,
  workSkipped: row.work_skipped,
  workFetched: row.work_fetched,
  workAnalyzed: row.work_analyzed,
  workProcessed: row.work_processed,
  workFailed: row.work_failed,
  marketWorkPending: row.market_work_pending,
  analysisWorkPending: row.analysis_work_pending,
});

const allowedTransitions: Readonly<
  Record<PipelineJobStatus, readonly PipelineJobStatus[]>
> = {
  // A worker can crash after the planner has completed but before it records
  // the pending -> planning transition.  Allow settlement to repair that
  // persisted-state gap without requiring browser polling.
  pending: ["planning", "complete", "complete_with_errors", "terminal"],
  planning: ["running", "complete", "complete_with_errors", "terminal"],
  running: ["complete", "complete_with_errors", "terminal"],
  complete: [],
  complete_with_errors: [],
  terminal: [],
};

export class PipelineJobRepository {
  constructor(private readonly db: D1Database) {}

  async findById(id: string): Promise<PipelineJobRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, trigger_type, requested_start_date,
                requested_end_date, affected_instruments_json,
                eligibility_intervals_json, priority, status,
                created_at, updated_at, backfill_reprocess_existing,
                backfill_forced_refresh_generation, planner_cursor,
                planner_dividend_cursor, planner_lease_until, started_at,
                completed_at, sync_lane, job_group_id, planning_phase
                , work_total, work_reused, work_skipped, work_fetched,
                work_analyzed, work_processed, work_failed,
                market_work_pending, analysis_work_pending
         FROM pipeline_jobs WHERE id = ?1`,
      )
      .bind(id)
      .first<PipelineJobRow>();
    return row ? mapPipelineJob(row) : null;
  }

  createStatement(job: PipelineJobRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO pipeline_jobs
         (id, trigger_type, requested_start_date, requested_end_date,
          affected_instruments_json, eligibility_intervals_json, priority,
          status, created_at, updated_at, backfill_reprocess_existing,
          backfill_forced_refresh_generation, planner_cursor,
          planner_dividend_cursor, planner_lease_until, sync_lane,
          job_group_id, planning_phase)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16, ?17, ?18)`,
      )
      .bind(
        job.id,
        job.triggerType,
        job.requestedStartDate,
        job.requestedEndDate,
        job.affectedInstrumentsJson,
        job.eligibilityIntervalsJson,
        job.priority,
        job.status,
        job.createdAt,
        job.updatedAt,
        job.backfillReprocessExisting ? 1 : 0,
        job.backfillForcedRefreshGeneration ?? null,
        job.plannerCursor ?? null,
        job.plannerDividendCursor ?? null,
        job.plannerLeaseUntil ?? null,
        job.syncLane ??
          (job.triggerType === "backfill" ? "history" : "current"),
        job.jobGroupId ?? null,
        job.planningPhase ?? "market",
      );
  }

  async updatePlannerCursor(input: {
    id: string;
    cursor: string | null;
    dividendCursor: string | null;
    leaseUntil: string | null;
    now: string;
    planningPhase?: PipelinePlanningPhase;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE pipeline_jobs
            SET planner_cursor = ?1,
                planner_dividend_cursor = ?2,
                planner_lease_until = ?3,
                planning_phase = COALESCE(?4, planning_phase),
                updated_at = ?5
          WHERE id = ?6 AND status IN ('pending', 'planning', 'running')`,
      )
      .bind(
        input.cursor,
        input.dividendCursor,
        input.leaseUntil,
        input.planningPhase ?? null,
        input.now,
        input.id,
      )
      .run();
    return result.meta.changes === 1;
  }

  async reopenForRetry(input: { id: string; now: string }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE pipeline_jobs
            SET status = 'running', completed_at = NULL, updated_at = ?1
          WHERE id = ?2
            AND status IN ('complete', 'complete_with_errors', 'terminal')`,
      )
      .bind(input.now, input.id)
      .run();
    return result.meta.changes === 1;
  }

  async transition(input: {
    id: string;
    from: PipelineJobStatus;
    to: PipelineJobStatus;
    now: string;
    retentionUntil?: string | null;
  }): Promise<boolean> {
    if (!allowedTransitions[input.from].includes(input.to)) {
      throw new Error("invalid_pipeline_job_transition");
    }
    const completedAt =
      input.to === "complete" ||
      input.to === "complete_with_errors" ||
      input.to === "terminal"
        ? input.now
        : null;
    const result = await this.db
      .prepare(
        `UPDATE pipeline_jobs
         SET status = ?1, updated_at = ?2,
             started_at = CASE
               WHEN ?1 IN ('planning', 'running') THEN COALESCE(started_at, ?2)
               ELSE started_at
             END,
             completed_at = ?3,
             retention_until = ?4
         WHERE id = ?5 AND status = ?6`,
      )
      .bind(
        input.to,
        input.now,
        completedAt,
        input.retentionUntil ?? null,
        input.id,
        input.from,
      )
      .run();
    return result.meta.changes === 1;
  }

  async updateProgress(input: {
    id: string;
    progress: PipelineJobProgress;
    now: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE pipeline_jobs
         SET work_total = ?1, work_reused = ?2, work_skipped = ?3,
             work_fetched = ?4, work_analyzed = ?5, work_processed = ?6,
             work_failed = ?7, updated_at = ?8
         WHERE id = ?9 AND status IN ('pending', 'planning', 'running')`,
      )
      .bind(
        input.progress.workTotal,
        input.progress.workReused,
        input.progress.workSkipped,
        input.progress.workFetched,
        input.progress.workAnalyzed,
        input.progress.workProcessed,
        input.progress.workFailed,
        input.now,
        input.id,
      )
      .run();
    return result.meta.changes === 1;
  }

  /**
   * Record a planned page exactly once. Global work is counted by
   * job_work_items triggers; this ledger accounts only dates that produced no
   * work row, so a queue redelivery cannot double-count planner skips.
   */
  async recordPlanningPage(input: {
    id: string;
    phase: string;
    cursorStart: string;
    cursorEnd: string | null;
    skippedCount: number;
    now: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `INSERT INTO pipeline_planning_pages
           (pipeline_job_id, phase, cursor_start, cursor_end, skipped_count,
            created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(pipeline_job_id, phase, cursor_start) DO NOTHING
         RETURNING pipeline_job_id`,
      )
      .bind(
        input.id,
        input.phase,
        input.cursorStart,
        input.cursorEnd,
        Math.max(0, Math.floor(input.skippedCount)),
        input.now,
      )
      .all<{ pipeline_job_id: string }>();
    return result.results.length === 1;
  }
}
