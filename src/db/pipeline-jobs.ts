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
});

const allowedTransitions: Readonly<
  Record<PipelineJobStatus, readonly PipelineJobStatus[]>
> = {
  pending: ["planning", "terminal"],
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
                completed_at
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
          planner_dividend_cursor, planner_lease_until)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15)`,
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
      );
  }

  async updatePlannerCursor(input: {
    id: string;
    cursor: string | null;
    dividendCursor: string | null;
    leaseUntil: string | null;
    now: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE pipeline_jobs
            SET planner_cursor = ?1,
                planner_dividend_cursor = ?2,
                planner_lease_until = ?3,
                updated_at = ?4
          WHERE id = ?5 AND status IN ('pending', 'planning', 'running')`,
      )
      .bind(
        input.cursor,
        input.dividendCursor,
        input.leaseUntil,
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
}
