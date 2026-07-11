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

export interface JobReadModelInput {
  limit?: number;
  cursor?: string | null;
}

export interface JobReadModelListInput {
  limit?: number;
  cursor?: string | null;
}

export interface JobReadModelListResult {
  jobs: JobReadModelDto[];
  nextCursor: string | null;
}

const MAX_WORK_DETAIL = 100;
const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 50;

export class JobReadModelService {
  constructor(private readonly db: D1Database) {}

  async list(
    input: JobReadModelListInput = {},
  ): Promise<JobReadModelListResult> {
    const limit = Math.min(
      Math.max(input.limit ?? DEFAULT_LIST_LIMIT, 1),
      MAX_LIST_LIMIT,
    );
    const rows = await this.db
      .prepare(
        `SELECT id FROM pipeline_jobs
         WHERE (?1 IS NULL OR id < ?1)
         ORDER BY id DESC
         LIMIT ?2`,
      )
      .bind(input.cursor ?? null, limit + 1)
      .all<{ id: string }>();
    const page = rows.results.slice(0, limit);
    const jobs = (
      await Promise.all(
        page.map(({ id }) => this.find(id, { limit: DEFAULT_LIST_LIMIT })),
      )
    ).filter((job): job is JobReadModelDto => job !== null);
    const hasMore = rows.results.length > limit;
    return {
      jobs,
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async find(
    id: string,
    input: JobReadModelInput = {},
  ): Promise<JobReadModelDto | null> {
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
    const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_WORK_DETAIL);
    const work = await this.db
      .prepare(
        `SELECT work.id, work.work_type, work.instrument_id,
                work.effective_date, work.state, link.outcome,
                work.terminal_error_code, work.terminal_error_message
         FROM job_work_items link JOIN work_items work
           ON work.id = link.work_item_id
         WHERE link.pipeline_job_id = ?1
           AND (?2 IS NULL OR work.id > ?2)
         ORDER BY work.id
         LIMIT ?3`,
      )
      .bind(id, input.cursor ?? null, limit + 1)
      .all<WorkRow>();
    const hasMore = work.results.length > limit;
    const mappedWork = work.results.slice(0, limit).map((row) => ({
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
      nextCursor:
        hasMore && mappedWork.length > 0
          ? btoa(JSON.stringify({ id: mappedWork.at(-1)?.id }))
          : null,
    };
  }
}
