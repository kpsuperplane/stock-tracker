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
}
