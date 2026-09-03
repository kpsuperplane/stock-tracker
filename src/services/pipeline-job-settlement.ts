import {
  type PipelineJobRecord,
  PipelineJobRepository,
} from "../db/pipeline-jobs";

interface LinkedJobRow {
  id: string;
}

interface SettlementRow {
  status: PipelineJobRecord["status"];
  plannerCursor: string | null;
  plannerDividendCursor: string | null;
  plannerState: string | null;
  workTotal: number;
  workProcessed: number;
  workFailed: number;
}

/** Updates progress and settles every active job touched by a finished batch. */
export class PipelineJobSettlementService {
  private readonly jobs: PipelineJobRepository;

  constructor(private readonly db: D1Database) {
    this.jobs = new PipelineJobRepository(db);
  }

  async settleForBatch(batchId: string, now: string): Promise<number> {
    const linkedJobs = await this.db
      .prepare(
        `SELECT DISTINCT link.pipeline_job_id AS id
           FROM dispatch_batch_items item
           JOIN job_work_items link ON link.work_item_id = item.work_item_id
           JOIN pipeline_jobs job ON job.id = link.pipeline_job_id
          WHERE item.dispatch_batch_id = ?1
            AND job.status IN ('pending', 'planning', 'running')`,
      )
      .bind(batchId)
      .all<LinkedJobRow>();
    let settled = 0;
    for (const { id } of linkedJobs.results) {
      if (await this.settle(id, now)) settled += 1;
    }
    return settled;
  }

  async settle(pipelineJobId: string, now: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT job.status,
                job.planner_cursor AS plannerCursor,
                job.planner_dividend_cursor AS plannerDividendCursor,
                planner.state AS plannerState,
                job.work_total AS workTotal,
                job.work_processed AS workProcessed,
                job.work_failed AS workFailed
           FROM pipeline_jobs job
           LEFT JOIN work_items planner
             ON planner.pipeline_job_id = job.id
            AND planner.scope = 'job_planning'
          WHERE job.id = ?1
          LIMIT 1`,
      )
      .bind(pipelineJobId)
      .first<SettlementRow>();
    if (
      !row ||
      !["pending", "planning", "running"].includes(row.status) ||
      row.plannerState !== "complete" ||
      row.plannerCursor !== null ||
      row.plannerDividendCursor !== null
    ) {
      return false;
    }
    if (Number(row.workProcessed) + Number(row.workFailed) < row.workTotal) {
      return false;
    }
    return this.jobs.transition({
      id: pipelineJobId,
      from: row.status,
      to: row.workFailed > 0 ? "complete_with_errors" : "complete",
      now,
    });
  }

  /**
   * A phase continuation becomes actionable when the last pending work link
   * for the preceding phase settles. The batch join is bounded by the batch's
   * own work items rather than by the size of the historical job.
   */
  async planningContinuationsForBatch(batchId: string): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `SELECT DISTINCT job.id
           FROM dispatch_batch_items item
           JOIN job_work_items link ON link.work_item_id = item.work_item_id
           JOIN pipeline_jobs job ON job.id = link.pipeline_job_id
           JOIN work_items planner
             ON planner.pipeline_job_id = job.id
            AND planner.scope = 'job_planning'
          WHERE item.dispatch_batch_id = ?1
            AND job.status IN ('pending', 'planning', 'running')
            AND planner.state = 'pending'
            AND (
              (job.planning_phase = 'analysis'
                AND job.market_work_pending = 0)
              OR (job.planning_phase = 'dividends'
                AND job.analysis_work_pending = 0)
            )
          ORDER BY job.id`,
      )
      .bind(batchId)
      .all<LinkedJobRow>();
    return rows.results.map((row) => row.id);
  }

  /** Bounded recovery for a crash after the final link was accounted. */
  async settleReady(now: string, limit = 25): Promise<number> {
    const rows = await this.db
      .prepare(
        `SELECT job.id
           FROM pipeline_jobs job
          WHERE job.status IN ('pending', 'planning', 'running')
            AND job.work_processed + job.work_failed >= job.work_total
            AND job.planner_cursor IS NULL
            AND job.planner_dividend_cursor IS NULL
            AND EXISTS (
              SELECT 1 FROM work_items planner
               WHERE planner.pipeline_job_id = job.id
                 AND planner.scope = 'job_planning'
                 AND planner.state = 'complete'
            )
          ORDER BY job.priority DESC, job.created_at, job.id
          LIMIT ?1`,
      )
      .bind(Math.max(1, Math.min(100, Math.floor(limit))))
      .all<LinkedJobRow>();
    let settled = 0;
    for (const row of rows.results) {
      if (await this.settle(row.id, now)) settled += 1;
    }
    return settled;
  }
}
