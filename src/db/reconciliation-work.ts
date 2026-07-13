import { easternMarketDate } from "../shared/dates";
import {
  type GlobalFactWorkRecord,
  mapWorkItem,
  type WorkItemRecord,
  WorkItemRepository,
  type WorkItemRow,
} from "./work-items";

export interface MaterializeReconciliationPageInput {
  pipelineJobId: string;
  work: readonly GlobalFactWorkRecord[];
  now: string;
}

export interface MaterializedReconciliationPage {
  createdCount: number;
  reusedCount: number;
  attachedCount: number;
  globalWork: WorkItemRecord[];
}

interface MaterializedWorkRow extends WorkItemRow {
  candidate_id: string;
}

/**
 * Persists one reconciliation page in a constant number of D1 round trips.
 * The planner used to issue several awaited statements for every trading
 * date, which made a 100-item page exceed its lease against remote D1.
 */
export class ReconciliationWorkRepository {
  constructor(private readonly db: D1Database) {}

  async materializePage(
    input: MaterializeReconciliationPageInput,
  ): Promise<MaterializedReconciliationPage> {
    if (input.work.length === 0) {
      return {
        createdCount: 0,
        reusedCount: 0,
        attachedCount: 0,
        globalWork: [],
      };
    }
    const keys = new Set<string>();
    for (const work of input.work) {
      if (work.deterministicKey !== WorkItemRepository.globalFactKey(work)) {
        throw new Error("invalid_global_fact_key");
      }
      if (keys.has(work.deterministicKey)) {
        throw new Error("duplicate_reconciliation_work_key");
      }
      keys.add(work.deterministicKey);
    }

    const payload = JSON.stringify(input.work);
    const marketDate = easternMarketDate(input.now);
    const writes = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO work_items
           (id, scope, pipeline_job_id, work_type, instrument_id, effective_date,
            dependency_revision, forced_refresh_generation, deterministic_key,
            state, priority, attempt_count, max_attempts, available_at,
            retention_until, created_at, updated_at)
           SELECT json_extract(candidate.value, '$.id'), 'global_fact', NULL,
                  json_extract(candidate.value, '$.workType'),
                  json_extract(candidate.value, '$.instrumentId'),
                  json_extract(candidate.value, '$.effectiveDate'),
                  json_extract(candidate.value, '$.dependencyRevision'),
                  json_extract(candidate.value, '$.forcedRefreshGeneration'),
                  json_extract(candidate.value, '$.deterministicKey'),
                  'pending', json_extract(candidate.value, '$.priority'), 0,
                  json_extract(candidate.value, '$.maxAttempts'),
                  json_extract(candidate.value, '$.availableAt'),
                  json_extract(candidate.value, '$.retentionUntil'),
                  json_extract(candidate.value, '$.createdAt'),
                  json_extract(candidate.value, '$.updatedAt')
             FROM json_each(?1) candidate
            WHERE true
           ON CONFLICT(deterministic_key) DO NOTHING`,
        )
        .bind(payload),
      this.db
        .prepare(
          `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
           SELECT substr(work.effective_date, 1, 7), COUNT(*), ?2
             FROM json_each(?1) candidate
             JOIN work_items work
               ON work.id = json_extract(candidate.value, '$.id')
            WHERE work.scope = 'global_fact'
              AND work.effective_date IS NOT NULL
            GROUP BY substr(work.effective_date, 1, 7)
           ON CONFLICT(bucket_key) DO UPDATE SET
             revision = fact_revision_buckets.revision + excluded.revision,
             updated_at = excluded.updated_at`,
        )
        .bind(payload, input.now),
      this.db
        .prepare(
          `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
           SELECT 'latest', COUNT(*), ?2
             FROM json_each(?1) candidate
             JOIN work_items work
               ON work.id = json_extract(candidate.value, '$.id')
            WHERE work.scope = 'global_fact'
              AND work.effective_date = (
                SELECT MAX(trading_date) FROM daily_market_facts
                 WHERE trading_date <= ?3
              )
           HAVING COUNT(*) > 0
           ON CONFLICT(bucket_key) DO UPDATE SET
             revision = fact_revision_buckets.revision + excluded.revision,
             updated_at = excluded.updated_at`,
        )
        .bind(payload, input.now, marketDate),
      this.db
        .prepare(
          `UPDATE work_items AS work
              SET priority = MAX(
                    work.priority,
                    CAST(json_extract(candidate.value, '$.priority') AS INTEGER)
                  ),
                  updated_at = ?2
             FROM json_each(?1) candidate
            WHERE work.scope = 'global_fact'
              AND work.deterministic_key =
                  json_extract(candidate.value, '$.deterministicKey')`,
        )
        .bind(payload, input.now),
      this.db
        .prepare(
          `INSERT INTO job_work_items
           (pipeline_job_id, work_item_id, relationship, outcome, created_at,
            updated_at)
           SELECT ?2, work.id, 'required',
                  CASE work.state
                    WHEN 'complete' THEN 'reused'
                    WHEN 'terminal' THEN 'failed'
                    ELSE 'pending'
                  END,
                  ?3, ?3
             FROM json_each(?1) candidate
             JOIN work_items work
               ON work.deterministic_key =
                  json_extract(candidate.value, '$.deterministicKey')
            WHERE true
           ON CONFLICT(pipeline_job_id, work_item_id) DO NOTHING`,
        )
        .bind(payload, input.pipelineJobId, input.now),
    ]);

    const rows = await this.db
      .prepare(
        `SELECT work.*,
                json_extract(candidate.value, '$.id') AS candidate_id
           FROM json_each(?1) candidate
           JOIN work_items work
             ON work.deterministic_key =
                json_extract(candidate.value, '$.deterministicKey')
          ORDER BY CAST(candidate.key AS INTEGER)`,
      )
      .bind(payload)
      .all<MaterializedWorkRow>();
    if (rows.results.length !== input.work.length) {
      throw new Error("global_work_missing_after_insert");
    }
    const globalWork = rows.results.map(mapWorkItem);
    return {
      createdCount: rows.results.filter((row) => row.id === row.candidate_id)
        .length,
      reusedCount: globalWork.filter((work) => work.state === "complete")
        .length,
      attachedCount: Number(writes[4]?.meta.changes ?? 0),
      globalWork,
    };
  }
}
