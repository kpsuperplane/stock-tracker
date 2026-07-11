import type { JobReadModelDto } from "../shared/contracts";

interface JobRow {
  id: string;
  trigger_type: string;
  requested_start_date: string | null;
  requested_end_date: string | null;
  priority: number;
  status: string;
  work_total: number;
  work_reused: number;
  work_skipped: number;
  work_fetched: number;
  work_analyzed: number;
  work_processed: number;
  work_failed: number;
  created_at: string;
  updated_at: string;
}

interface WorkRow {
  id: string;
  work_type: string;
  instrument_id: string | null;
  effective_date: string | null;
  state: string;
  outcome: string | null;
  terminal_error_code: string | null;
  terminal_error_message: string | null;
}

export class JobReadModelService {
  constructor(private readonly db: D1Database) {}

  async find(id: string): Promise<JobReadModelDto | null> {
    const job = await this.db
      .prepare(
        `SELECT id, trigger_type, requested_start_date, requested_end_date,
                priority, status, work_total, work_reused, work_skipped,
                work_fetched, work_analyzed, work_processed, work_failed,
                created_at, updated_at
         FROM pipeline_jobs WHERE id = ?1`,
      )
      .bind(id)
      .first<JobRow>();
    if (!job) return null;
    const work = await this.db
      .prepare(
        `SELECT work.id, work.work_type, work.instrument_id,
                work.effective_date, work.state, link.outcome,
                work.terminal_error_code, work.terminal_error_message
         FROM job_work_items link JOIN work_items work
           ON work.id = link.work_item_id
         WHERE link.pipeline_job_id = ?1
         ORDER BY work.effective_date, work.work_type, work.id`,
      )
      .bind(id)
      .all<WorkRow>();
    const mappedWork = work.results.map((row) => ({
      id: row.id,
      workType: row.work_type,
      instrumentId: row.instrument_id,
      effectiveDate: row.effective_date,
      state: row.state,
      outcome: row.outcome,
      terminalErrorCode: row.terminal_error_code,
      terminalErrorMessage: row.terminal_error_message,
    }));
    return {
      id: job.id,
      triggerType: job.trigger_type,
      requestedStartDate: job.requested_start_date,
      requestedEndDate: job.requested_end_date,
      priority: job.priority,
      status: job.status,
      createdAt: job.created_at,
      updatedAt: job.updated_at,
      progress: {
        workTotal: job.work_total,
        workReused: job.work_reused,
        workSkipped: job.work_skipped,
        workFetched: job.work_fetched,
        workAnalyzed: job.work_analyzed,
        workProcessed: job.work_processed,
        workFailed: job.work_failed,
      },
      work: mappedWork,
      errors: mappedWork
        .filter((row) => row.terminalErrorCode || row.terminalErrorMessage)
        .map((row) => ({
          workItemId: row.id,
          code: row.terminalErrorCode,
          message: row.terminalErrorMessage,
          effectiveDate: row.effectiveDate,
        })),
    };
  }
}
