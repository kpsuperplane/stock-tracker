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

  createStatement(job: PipelineJobRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO pipeline_jobs
         (id, trigger_type, requested_start_date, requested_end_date,
          affected_instruments_json, eligibility_intervals_json, priority,
          status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
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
      );
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
         SET status = ?1, updated_at = ?2, completed_at = ?3,
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
