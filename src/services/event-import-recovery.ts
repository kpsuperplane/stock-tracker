interface RecoveryQueue {
  sendBatch(
    messages: Iterable<{ body: { importBatchId: string } }>,
  ): Promise<unknown>;
}

interface RecoveryDependencies {
  db: D1Database;
  queue: RecoveryQueue;
  now?: () => Date;
}

export class EventImportRecoveryService {
  private readonly now: () => Date;

  constructor(private readonly dependencies: RecoveryDependencies) {
    this.now = dependencies.now ?? (() => new Date());
  }

  async recover(): Promise<{ expired: number; enqueued: number }> {
    const timestamp = this.now().toISOString();
    const expired = await this.dependencies.db
      .prepare(
        `UPDATE import_batches
            SET status = 'expired', processing_lease_until = NULL,
                processing_lease_token = NULL,
                terminal_error_code = 'import_expired',
                terminal_error_message = 'The staged import expired.',
                completed_at = ?1, updated_at = ?1
          WHERE status IN ('pending', 'running') AND expires_at <= ?1`,
      )
      .bind(timestamp)
      .run();
    const recoverable = await this.dependencies.db
      .prepare(
        `SELECT id FROM import_batches
          WHERE status IN ('pending', 'running') AND expires_at > ?1
            AND (processing_lease_until IS NULL OR processing_lease_until <= ?1)
            AND (available_at IS NULL OR available_at <= ?1)
          ORDER BY created_at LIMIT 25`,
      )
      .bind(timestamp)
      .all<{ id: string }>();
    if (recoverable.results.length > 0) {
      await this.dependencies.queue.sendBatch(
        recoverable.results.map(({ id }) => ({
          body: { importBatchId: id },
        })),
      );
    }
    return {
      expired: expired.meta.changes,
      enqueued: recoverable.results.length,
    };
  }
}
