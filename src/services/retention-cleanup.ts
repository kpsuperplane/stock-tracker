/**
 * Bounded, resumable D1 retention cleanup.
 *
 * This service only removes derived workflow artifacts. Ledger transactions,
 * normalized facts, corporate-action provenance, import digests, legacy report
 * rows, and migration audit history are intentionally outside its scope.
 */

const COMPLETED_WORK_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
const TERMINAL_AUDIT_RETENTION_MS = 365 * 24 * 60 * 60 * 1_000;
const DEFAULT_BATCH_SIZE = 100;
const STAGING_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export interface RetentionCleanupDependencies {
  db: D1Database;
  now?: () => Date;
  batchSize?: number;
}

export interface RetentionCleanupResult {
  expiredImportBatches: number;
  deletedImportRows: number;
  deletedJobLinks: number;
  deletedDispatchLinks: number;
  deletedWorkItems: number;
  deletedDispatchBatches: number;
  deletedPipelineJobs: number;
  deletedRepairMarkers: number;
}

const changed = (value: D1Result<unknown> | undefined): number =>
  value?.meta.changes ?? 0;

export interface ImportStagingCleanupDependencies {
  db: D1Database;
  now?: () => Date;
  batchSize?: number;
}

export interface ImportStagingCleanupResult {
  expiredImportBatches: number;
  deletedImportRows: number;
}

const boundedBatchSize = (value: number | undefined): number =>
  Math.max(1, Math.min(500, Math.floor(value ?? DEFAULT_BATCH_SIZE)));

/**
 * Expires abandoned imports and removes completed jobs' derived staging. The batch
 * is deliberately small and atomic so a later scheduler tick can resume at
 * the next eligible row after a transient D1 failure.
 */
export const cleanupImportStaging = async (
  dependencies: ImportStagingCleanupDependencies,
  now = (dependencies.now ?? (() => new Date()))().toISOString(),
): Promise<ImportStagingCleanupResult> => {
  const stagingCutoff = new Date(
    Date.parse(now) - STAGING_RETENTION_MS,
  ).toISOString();
  const limit = boundedBatchSize(dependencies.batchSize);
  const results = await dependencies.db.batch([
    dependencies.db
      .prepare(
        `UPDATE import_batches
            SET status = 'expired', processing_lease_until = NULL,
                processing_lease_token = NULL,
                terminal_error_code = 'import_expired',
                terminal_error_message = 'The staged import expired.',
                completed_at = ?1, updated_at = ?1
          WHERE id IN (
            SELECT id FROM import_batches
             WHERE status IN ('pending', 'running') AND expires_at <= ?1
             LIMIT ?2
          )`,
      )
      .bind(now, limit),
    dependencies.db
      .prepare(
        `DELETE FROM import_symbols
          WHERE rowid IN (
            SELECT symbols.rowid
              FROM import_symbols symbols
              JOIN import_batches batch
                ON batch.id = symbols.import_batch_id
             WHERE batch.status IN (
               'committed', 'complete_with_errors', 'terminal', 'expired'
             )
               AND CASE WHEN batch.status = 'expired' THEN batch.expires_at
                        ELSE COALESCE(batch.completed_at, batch.committed_at)
                    END <= ?1
             LIMIT ?2
          )`,
      )
      .bind(stagingCutoff, limit),
    dependencies.db
      .prepare(
        `DELETE FROM import_rows
          WHERE rowid IN (
            SELECT rows.rowid
              FROM import_rows rows
              JOIN import_batches batch
                ON batch.id = rows.import_batch_id
             WHERE (
               batch.status IN (
                 'committed', 'complete_with_errors', 'terminal', 'expired'
               )
               AND CASE WHEN batch.status = 'expired' THEN batch.expires_at
                        ELSE COALESCE(batch.completed_at, batch.committed_at)
                    END <= ?1
             )
             LIMIT ?2
          )`,
      )
      .bind(stagingCutoff, limit),
  ]);
  return {
    expiredImportBatches: changed(results[0]),
    deletedImportRows: changed(results[2]),
  };
};

export class RetentionCleanupService {
  private readonly now: () => Date;
  private readonly batchSize: number;

  constructor(private readonly dependencies: RetentionCleanupDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.batchSize = boundedBatchSize(dependencies.batchSize);
  }

  async run(now = this.now().toISOString()): Promise<RetentionCleanupResult> {
    const importStaging = await cleanupImportStaging(
      { db: this.dependencies.db, batchSize: this.batchSize },
      now,
    );
    const completedCutoff = new Date(
      Date.parse(now) - COMPLETED_WORK_RETENTION_MS,
    ).toISOString();
    const terminalCutoff = new Date(
      Date.parse(now) - TERMINAL_AUDIT_RETENTION_MS,
    ).toISOString();
    const limit = this.batchSize;

    // Drive cleanup from indexed timestamps and keep each state separate. An
    // OR across state-specific retention rules made SQLite scan the retained
    // tables even when no row was old enough to delete.
    const results = await this.dependencies.db.batch([
      this.dependencies.db
        .prepare(
          `DELETE FROM job_work_items
           WHERE rowid IN (
             SELECT link.rowid
               FROM pipeline_jobs job
               JOIN job_work_items link ON link.pipeline_job_id = job.id
              WHERE job.status IN ('complete', 'complete_with_errors')
                AND job.completed_at <= ?1
              ORDER BY job.completed_at, link.pipeline_job_id,
                       link.work_item_id
              LIMIT ?2
           )`,
        )
        .bind(completedCutoff, limit),
      this.dependencies.db
        .prepare(
          `DELETE FROM job_work_items
           WHERE rowid IN (
             SELECT link.rowid
               FROM pipeline_jobs job
               JOIN job_work_items link ON link.pipeline_job_id = job.id
              WHERE job.status = 'terminal' AND job.completed_at <= ?1
              ORDER BY job.completed_at, link.pipeline_job_id,
                       link.work_item_id
              LIMIT ?2
           )`,
        )
        .bind(terminalCutoff, limit),
      this.dependencies.db
        .prepare(
          `DELETE FROM dispatch_batch_items
           WHERE rowid IN (
             SELECT item.rowid
               FROM dispatch_batches batch
               JOIN dispatch_batch_items item
                 ON item.dispatch_batch_id = batch.id
              WHERE batch.state = 'complete' AND batch.completed_at <= ?1
              ORDER BY batch.completed_at, item.dispatch_batch_id,
                       item.work_item_id
              LIMIT ?2
           )`,
        )
        .bind(completedCutoff, limit),
      this.dependencies.db
        .prepare(
          `DELETE FROM dispatch_batch_items
           WHERE rowid IN (
             SELECT item.rowid
               FROM dispatch_batches batch
               JOIN dispatch_batch_items item
                 ON item.dispatch_batch_id = batch.id
              WHERE batch.state = 'terminal' AND batch.completed_at <= ?1
                AND batch.dlq_state IN ('none', 'delivered')
              ORDER BY batch.completed_at, item.dispatch_batch_id,
                       item.work_item_id
              LIMIT ?2
           )`,
        )
        .bind(terminalCutoff, limit),
      this.dependencies.db
        .prepare(
          `DELETE FROM work_items
           WHERE rowid IN (
             SELECT work.rowid FROM work_items work
              WHERE work.state = 'complete' AND work.completed_at <= ?1
                AND NOT EXISTS (
                  SELECT 1 FROM job_work_items link
                   WHERE link.work_item_id = work.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM dispatch_batch_items item
                   WHERE item.work_item_id = work.id
                )
              ORDER BY work.completed_at, work.id
              LIMIT ?2
           )`,
        )
        .bind(completedCutoff, limit),
      this.dependencies.db
        .prepare(
          `DELETE FROM work_items
           WHERE rowid IN (
             SELECT work.rowid FROM work_items work
              WHERE work.state = 'terminal' AND work.completed_at <= ?1
                AND NOT EXISTS (
                  SELECT 1 FROM job_work_items link
                   WHERE link.work_item_id = work.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM dispatch_batch_items item
                   WHERE item.work_item_id = work.id
                )
              ORDER BY work.completed_at, work.id
              LIMIT ?2
           )`,
        )
        .bind(terminalCutoff, limit),
      this.dependencies.db
        .prepare(
          `DELETE FROM work_items
           WHERE rowid IN (
             SELECT work.rowid FROM work_items work
              WHERE work.retention_until IS NOT NULL
                AND work.retention_until <= ?1
                AND NOT EXISTS (
                  SELECT 1 FROM job_work_items link
                   WHERE link.work_item_id = work.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM dispatch_batch_items item
                   WHERE item.work_item_id = work.id
                )
              ORDER BY work.retention_until, work.id
              LIMIT ?2
           )`,
        )
        .bind(now, limit),
      this.dependencies.db
        .prepare(
          `DELETE FROM dispatch_batches
           WHERE rowid IN (
             SELECT rowid FROM dispatch_batches
              WHERE state = 'complete' AND completed_at <= ?1
              ORDER BY completed_at, id
              LIMIT ?2
           )`,
        )
        .bind(completedCutoff, limit),
      this.dependencies.db
        .prepare(
          `DELETE FROM dispatch_batches
           WHERE rowid IN (
             SELECT rowid FROM dispatch_batches
              WHERE state = 'terminal' AND completed_at <= ?1
                AND dlq_state IN ('none', 'delivered')
              ORDER BY completed_at, id
              LIMIT ?2
           )`,
        )
        .bind(terminalCutoff, limit),
      this.dependencies.db
        .prepare(
          `DELETE FROM dispatch_batches
           WHERE rowid IN (
             SELECT rowid FROM dispatch_batches
              WHERE retention_until IS NOT NULL AND retention_until <= ?1
              ORDER BY retention_until, id
              LIMIT ?2
           )`,
        )
        .bind(now, limit),
      this.dependencies.db
        .prepare(
          `DELETE FROM pipeline_jobs
           WHERE rowid IN (
             SELECT rowid FROM pipeline_jobs
              WHERE status IN ('complete', 'complete_with_errors', 'terminal')
                AND completed_at IS NOT NULL AND completed_at <= ?1
              ORDER BY completed_at, id
              LIMIT ?2
           )`,
        )
        .bind(terminalCutoff, limit),
      this.dependencies.db
        .prepare(
          `DELETE FROM legacy_dual_write_repairs
           WHERE rowid IN (
             SELECT rowid FROM legacy_dual_write_repairs
              WHERE state = 'resolved' AND updated_at <= ?1
              ORDER BY updated_at, id
              LIMIT ?2
           )`,
        )
        .bind(terminalCutoff, limit),
    ]);

    return {
      ...importStaging,
      deletedJobLinks: changed(results[0]) + changed(results[1]),
      deletedDispatchLinks: changed(results[2]) + changed(results[3]),
      deletedWorkItems:
        changed(results[4]) + changed(results[5]) + changed(results[6]),
      deletedDispatchBatches:
        changed(results[7]) + changed(results[8]) + changed(results[9]),
      deletedPipelineJobs: changed(results[10]),
      deletedRepairMarkers: changed(results[11]),
    };
  }
}

export const createRetentionCleanupService = (
  dependencies: RetentionCleanupDependencies,
) => new RetentionCleanupService(dependencies);
