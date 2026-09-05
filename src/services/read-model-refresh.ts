import type {
  ReadModelFreshnessDto,
  ReadModelRefreshMessage,
} from "../shared/contracts";
import type { ReadModelFamily } from "./read-model-cache";

interface RefreshRow {
  id: string;
  family: ReadModelFamily | "all";
  requestedRevision: string;
  state: string;
  leaseToken: string | null;
  leaseUntil: string | null;
  attemptCount: number;
  targetCacheKey: string | null;
}

export interface ReadModelPublicationTarget {
  cacheKey: string;
  family: ReadModelFamily;
  requestUrl: string;
}

export class ReadModelRefreshOutbox {
  constructor(
    private readonly db: D1Database,
    private readonly queue: Queue<ReadModelRefreshMessage>,
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  async request(
    family: ReadModelFamily | "all",
    requestedRevision: string,
    targetCacheKey: string | null = null,
  ): Promise<boolean> {
    const timestamp = this.now().toISOString();
    const deterministicKey = `read-model-refresh:${family}:${targetCacheKey ?? "canonical"}`;
    await this.db
      .prepare(
        `INSERT INTO read_model_refresh_outbox
         (id, deterministic_key, family, requested_revision, target_cache_key,
          state, attempt_count, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?6)
         ON CONFLICT(deterministic_key) DO UPDATE SET
           requested_revision = excluded.requested_revision,
           target_cache_key = excluded.target_cache_key,
           state = CASE
             WHEN read_model_refresh_outbox.requested_revision = excluded.requested_revision
              AND read_model_refresh_outbox.state IN
                ('dispatching', 'queued', 'processing')
             THEN read_model_refresh_outbox.state ELSE 'pending' END,
           lease_token = CASE
             WHEN read_model_refresh_outbox.requested_revision = excluded.requested_revision
              AND read_model_refresh_outbox.state IN
                ('dispatching', 'queued', 'processing')
             THEN read_model_refresh_outbox.lease_token ELSE NULL END,
           lease_until = CASE
             WHEN read_model_refresh_outbox.requested_revision = excluded.requested_revision
              AND read_model_refresh_outbox.state IN
                ('dispatching', 'queued', 'processing')
             THEN read_model_refresh_outbox.lease_until ELSE NULL END,
           next_attempt_at = CASE
             WHEN read_model_refresh_outbox.requested_revision = excluded.requested_revision
              AND read_model_refresh_outbox.state IN
                ('dispatching', 'queued', 'processing')
             THEN read_model_refresh_outbox.next_attempt_at ELSE NULL END,
           completed_at = CASE
             WHEN read_model_refresh_outbox.requested_revision = excluded.requested_revision
              AND read_model_refresh_outbox.state IN
                ('dispatching', 'queued', 'processing')
             THEN read_model_refresh_outbox.completed_at ELSE NULL END,
           updated_at = excluded.updated_at
         WHERE read_model_refresh_outbox.requested_revision <> excluded.requested_revision
            OR read_model_refresh_outbox.state NOT IN
              ('dispatching', 'queued', 'processing')`,
      )
      .bind(
        this.newId(),
        deterministicKey,
        family,
        requestedRevision,
        targetCacheKey,
        timestamp,
      )
      .run();
    const row = await this.db
      .prepare(
        `SELECT id FROM read_model_refresh_outbox
          WHERE deterministic_key = ?1`,
      )
      .bind(deterministicKey)
      .first<{ id: string }>();
    if (!row) return false;
    return this.dispatch(row.id);
  }

  async recover(limit = 20): Promise<number> {
    const timestamp = this.now().toISOString();
    await this.db
      .prepare(
        `UPDATE read_model_refresh_outbox
            SET state = 'retry', lease_token = NULL, lease_until = NULL,
                next_attempt_at = ?1, updated_at = ?1
          WHERE state IN ('dispatching', 'queued', 'processing')
            AND lease_until IS NOT NULL AND lease_until <= ?1`,
      )
      .bind(timestamp)
      .run();
    const rows = await this.db
      .prepare(
        `SELECT id FROM read_model_refresh_outbox
          WHERE state IN ('pending', 'retry')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
          ORDER BY updated_at, id LIMIT ?2`,
      )
      .bind(timestamp, Math.max(1, Math.min(100, Math.floor(limit))))
      .all<{ id: string }>();
    let sent = 0;
    for (const row of rows.results) {
      if (await this.dispatch(row.id)) sent += 1;
    }
    return sent;
  }

  private async dispatch(id: string): Promise<boolean> {
    const timestamp = this.now().toISOString();
    const leaseToken = this.newId();
    const leaseUntil = new Date(
      Date.parse(timestamp) + 5 * 60_000,
    ).toISOString();
    const claim = await this.db
      .prepare(
        `UPDATE read_model_refresh_outbox
            SET state = 'dispatching', lease_token = ?1, lease_until = ?2,
                updated_at = ?3
          WHERE id = ?4 AND state IN ('pending', 'retry')
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?3)`,
      )
      .bind(leaseToken, leaseUntil, timestamp, id)
      .run();
    if (claim.meta.changes !== 1) return false;
    try {
      await this.queue.send({ readModelRefreshId: id, leaseToken });
    } catch {
      await this.db
        .prepare(
          `UPDATE read_model_refresh_outbox
              SET state = 'pending', lease_token = NULL, lease_until = NULL,
                  updated_at = ?1
            WHERE id = ?2 AND state = 'dispatching' AND lease_token = ?3`,
        )
        .bind(timestamp, id, leaseToken)
        .run();
      return false;
    }
    await this.db
      .prepare(
        `UPDATE read_model_refresh_outbox SET state = 'queued', updated_at = ?1
          WHERE id = ?2 AND state = 'dispatching' AND lease_token = ?3`,
      )
      .bind(timestamp, id, leaseToken)
      .run();
    return true;
  }

  async claim(message: ReadModelRefreshMessage): Promise<RefreshRow | null> {
    const timestamp = this.now().toISOString();
    const leaseUntil = new Date(
      Date.parse(timestamp) + 5 * 60_000,
    ).toISOString();
    const claimed = await this.db
      .prepare(
        `UPDATE read_model_refresh_outbox
            SET state = 'processing', lease_until = ?1,
                attempt_count = attempt_count + 1, updated_at = ?2
          WHERE id = ?3 AND state = 'queued' AND lease_token = ?4
            AND lease_until > ?2`,
      )
      .bind(
        leaseUntil,
        timestamp,
        message.readModelRefreshId,
        message.leaseToken,
      )
      .run();
    if (claimed.meta.changes !== 1) return null;
    return this.db
      .prepare(
        `SELECT id, family, requested_revision AS requestedRevision, state,
                lease_token AS leaseToken, lease_until AS leaseUntil,
                attempt_count AS attemptCount,
                target_cache_key AS targetCacheKey
           FROM read_model_refresh_outbox WHERE id = ?1`,
      )
      .bind(message.readModelRefreshId)
      .first<RefreshRow>();
  }

  async targets(
    family: ReadModelFamily | "all",
    limit = 50,
    targetCacheKey: string | null = null,
  ): Promise<ReadModelPublicationTarget[]> {
    const rows = await this.db
      .prepare(
        `WITH ranked AS (
           SELECT cache_key AS cacheKey, family, request_url AS requestUrl,
                  updated_at AS updatedAt,
                  ROW_NUMBER() OVER (
                    PARTITION BY family ORDER BY updated_at DESC, cache_key
                  ) AS familyRank
             FROM read_model_publications
            WHERE (?1 = 'all' OR family = ?1)
              AND (?2 IS NULL OR cache_key = ?2)
         )
         SELECT cacheKey, family, requestUrl FROM ranked
          WHERE ?2 IS NOT NULL OR ?1 <> 'all' OR familyRank = 1
          ORDER BY updatedAt DESC, cacheKey LIMIT ?3`,
      )
      .bind(
        family,
        targetCacheKey,
        Math.max(1, Math.min(100, Math.floor(limit))),
      )
      .all<ReadModelPublicationTarget>();
    return rows.results;
  }

  async complete(row: RefreshRow): Promise<boolean> {
    const timestamp = this.now().toISOString();
    const result = await this.db
      .prepare(
        `UPDATE read_model_refresh_outbox
            SET state = 'complete', completed_at = ?1, updated_at = ?1,
                lease_token = NULL, lease_until = NULL, next_attempt_at = NULL
          WHERE id = ?2 AND state = 'processing' AND lease_token = ?3
            AND requested_revision = ?4`,
      )
      .bind(timestamp, row.id, row.leaseToken, row.requestedRevision)
      .run();
    return result.meta.changes === 1;
  }

  async retry(
    row: RefreshRow,
    reason: ReadModelFreshnessDto["reason"],
  ): Promise<void> {
    const timestamp = this.now().toISOString();
    const nextAttemptAt = new Date(
      Date.parse(timestamp) + Math.min(60, 2 ** row.attemptCount) * 60_000,
    ).toISOString();
    await this.db
      .prepare(
        `UPDATE read_model_refresh_outbox
            SET state = 'retry', next_attempt_at = ?1, updated_at = ?2,
                lease_token = NULL, lease_until = NULL
          WHERE id = ?3 AND state = 'processing' AND lease_token = ?4`,
      )
      .bind(nextAttemptAt, timestamp, row.id, row.leaseToken)
      .run();
    console.warn(
      JSON.stringify({ event: "read_model_refresh_retry", id: row.id, reason }),
    );
  }
}
