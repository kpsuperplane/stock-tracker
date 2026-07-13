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
  storedSkipped: number;
  linkedTotal: number;
  linkedReused: number;
  linkedSkipped: number;
  linkedFetched: number;
  linkedAnalyzed: number;
  linkedProcessed: number;
  linkedFailed: number;
  unsettled: number;
  terminal: number;
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
                job.work_skipped AS storedSkipped,
                planner.state AS plannerState,
                COUNT(CASE WHEN work.scope = 'global_fact' THEN 1 END)
                  AS linkedTotal,
                SUM(CASE WHEN work.scope = 'global_fact'
                           AND link.outcome = 'reused' THEN 1 ELSE 0 END)
                  AS linkedReused,
                SUM(CASE WHEN work.scope = 'global_fact'
                           AND link.outcome = 'skipped' THEN 1 ELSE 0 END)
                  AS linkedSkipped,
                SUM(CASE WHEN work.scope = 'global_fact'
                           AND work.work_type = 'market_fact'
                           AND work.state = 'complete'
                           AND link.outcome = 'processed' THEN 1 ELSE 0 END)
                  AS linkedFetched,
                SUM(CASE WHEN work.scope = 'global_fact'
                           AND work.work_type = 'analysis'
                           AND work.state = 'complete'
                           AND link.outcome = 'processed' THEN 1 ELSE 0 END)
                  AS linkedAnalyzed,
                SUM(CASE WHEN work.scope = 'global_fact'
                           AND work.state = 'complete' THEN 1 ELSE 0 END)
                  AS linkedProcessed,
                SUM(CASE WHEN work.scope = 'global_fact'
                           AND (work.state = 'terminal'
                             OR link.outcome = 'failed') THEN 1 ELSE 0 END)
                  AS linkedFailed,
                SUM(CASE WHEN work.scope = 'global_fact'
                           AND link.outcome = 'pending'
                           AND work.state IN
                             ('pending', 'dispatching', 'queued', 'processing')
                         THEN 1 ELSE 0 END) AS unsettled,
                SUM(CASE WHEN work.scope = 'global_fact'
                           AND (work.state = 'terminal'
                             OR link.outcome = 'failed') THEN 1 ELSE 0 END)
                  AS terminal
           FROM pipeline_jobs job
           LEFT JOIN work_items planner
             ON planner.pipeline_job_id = job.id
            AND planner.scope = 'job_planning'
           LEFT JOIN job_work_items link ON link.pipeline_job_id = job.id
           LEFT JOIN work_items work ON work.id = link.work_item_id
          WHERE job.id = ?1
          GROUP BY job.id, planner.id`,
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
    const skipped = Math.max(
      Number(row.storedSkipped ?? 0),
      Number(row.linkedSkipped ?? 0),
    );
    await this.jobs.updateProgress({
      id: pipelineJobId,
      now,
      progress: {
        workTotal: Number(row.linkedTotal ?? 0) + skipped,
        workReused: Number(row.linkedReused ?? 0),
        workSkipped: skipped,
        workFetched: Number(row.linkedFetched ?? 0),
        workAnalyzed: Number(row.linkedAnalyzed ?? 0),
        workProcessed: Number(row.linkedProcessed ?? 0) + skipped,
        workFailed: Number(row.linkedFailed ?? 0),
      },
    });
    if (Number(row.unsettled ?? 0) > 0) return false;
    return this.jobs.transition({
      id: pipelineJobId,
      from: row.status,
      to: Number(row.terminal ?? 0) > 0 ? "complete_with_errors" : "complete",
      now,
    });
  }
}
