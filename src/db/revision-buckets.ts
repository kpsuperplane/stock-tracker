export class FactRevisionBucketRepository {
  constructor(private readonly db: D1Database) {}

  bumpStatement(bucketKey: string, updatedAt: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
         VALUES (?1, 1, ?2)
         ON CONFLICT(bucket_key) DO UPDATE SET
          revision = fact_revision_buckets.revision + 1,
          updated_at = excluded.updated_at`,
      )
      .bind(bucketKey, updatedAt);
  }

  async revision(bucketKey: string): Promise<number> {
    const row = await this.db
      .prepare(
        "SELECT revision FROM fact_revision_buckets WHERE bucket_key = ?1",
      )
      .bind(bucketKey)
      .first<{ revision: number }>();
    return row?.revision ?? 0;
  }

  /**
   * Bump every calendar month intersecting a coverage/action range.  This is
   * intentionally a write-side operation: read-model ETags can then inspect
   * only the requested bucket rows instead of scanning mutable state tables.
   */
  bumpRangeStatement(
    startDate: string,
    endDate: string,
    updatedAt: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
         WITH RECURSIVE months(bucket_key) AS (
           SELECT substr(?1, 1, 7)
           UNION ALL
           SELECT strftime('%Y-%m', date(bucket_key || '-01', '+1 month'))
           FROM months
           WHERE bucket_key < substr(?2, 1, 7)
         )
         SELECT bucket_key, 1, ?3 FROM months WHERE true
         ON CONFLICT(bucket_key) DO UPDATE SET
           revision = fact_revision_buckets.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(startDate, endDate, updatedAt);
  }

  bumpRangesStatement(
    ranges: readonly { startDate: string; endDate: string }[],
    updatedAt: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
         WITH RECURSIVE ranges(start_date, end_date) AS (
           SELECT json_extract(value, '$.startDate'),
                  json_extract(value, '$.endDate')
           FROM json_each(?1)
         ), months(start_date, end_date, bucket_key) AS (
           SELECT start_date, end_date, substr(start_date, 1, 7)
           FROM ranges
           UNION ALL
           SELECT start_date, end_date,
                  strftime('%Y-%m', date(bucket_key || '-01', '+1 month'))
           FROM months
           WHERE bucket_key < substr(end_date, 1, 7)
         )
         SELECT DISTINCT bucket_key, 1, ?2 FROM months WHERE true
         ON CONFLICT(bucket_key) DO UPDATE SET
           revision = fact_revision_buckets.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(ranges), updatedAt);
  }

  /** Bump the latest bucket when a mutation can affect the latest fact date. */
  bumpLatestForRangeStatement(
    startDate: string,
    endDate: string,
    updatedAt: string,
    marketDate: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
         SELECT 'latest', 1, ?3
         WHERE (SELECT MAX(trading_date) FROM daily_market_facts
                WHERE trading_date <= ?4) BETWEEN ?1 AND ?2
         ON CONFLICT(bucket_key) DO UPDATE SET
           revision = fact_revision_buckets.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(startDate, endDate, updatedAt, marketDate);
  }

  bumpLatestForRangesStatement(
    ranges: readonly { startDate: string; endDate: string }[],
    updatedAt: string,
    marketDate: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
         WITH ranges(start_date, end_date) AS (
           SELECT json_extract(value, '$.startDate'),
                  json_extract(value, '$.endDate')
           FROM json_each(?1)
         )
         SELECT 'latest', 1, ?2
         WHERE EXISTS (
           SELECT 1 FROM ranges
           WHERE (SELECT MAX(trading_date) FROM daily_market_facts
                  WHERE trading_date <= ?3)
                 BETWEEN start_date AND end_date
         )
         ON CONFLICT(bucket_key) DO UPDATE SET
           revision = fact_revision_buckets.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify(ranges), updatedAt, marketDate);
  }

  /** Bump the month containing a work item after a state transition. */
  bumpWorkItemStatement(id: string, updatedAt: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
         SELECT substr(effective_date, 1, 7), 1, ?2
         FROM work_items
         WHERE id = ?1 AND scope = 'global_fact' AND effective_date IS NOT NULL
         ON CONFLICT(bucket_key) DO UPDATE SET
           revision = fact_revision_buckets.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(id, updatedAt);
  }

  bumpLatestForWorkItemStatement(
    id: string,
    updatedAt: string,
    marketDate: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
         SELECT 'latest', 1, ?2
         WHERE EXISTS (
           SELECT 1 FROM work_items
           WHERE id = ?1 AND scope = 'global_fact'
             AND effective_date = (SELECT MAX(trading_date)
                                   FROM daily_market_facts
                                   WHERE trading_date <= ?3)
         )
         ON CONFLICT(bucket_key) DO UPDATE SET
           revision = fact_revision_buckets.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(id, updatedAt, marketDate);
  }

  bumpWorkItemsForBatchStatement(
    dispatchBatchId: string,
    updatedAt: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
         SELECT DISTINCT substr(work.effective_date, 1, 7), 1, ?2
         FROM work_items work
         JOIN dispatch_batch_items item ON item.work_item_id = work.id
         WHERE item.dispatch_batch_id = ?1
           AND work.scope = 'global_fact' AND work.effective_date IS NOT NULL
         ON CONFLICT(bucket_key) DO UPDATE SET
           revision = fact_revision_buckets.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(dispatchBatchId, updatedAt);
  }

  bumpLatestForWorkItemsForBatchStatement(
    dispatchBatchId: string,
    updatedAt: string,
    marketDate: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
         SELECT 'latest', 1, ?2
         WHERE EXISTS (
           SELECT 1
           FROM work_items work
           JOIN dispatch_batch_items item ON item.work_item_id = work.id
           WHERE item.dispatch_batch_id = ?1
             AND work.scope = 'global_fact'
             AND work.effective_date = (SELECT MAX(trading_date)
                                        FROM daily_market_facts
                                        WHERE trading_date <= ?3)
         )
         ON CONFLICT(bucket_key) DO UPDATE SET
           revision = fact_revision_buckets.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(dispatchBatchId, updatedAt, marketDate);
  }

  bumpWorkItemsUpdatedAtStatement(updatedAt: string): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
         SELECT DISTINCT substr(effective_date, 1, 7), 1, ?1
         FROM work_items
         WHERE scope = 'global_fact' AND effective_date IS NOT NULL
           AND updated_at = ?1
         ON CONFLICT(bucket_key) DO UPDATE SET
           revision = fact_revision_buckets.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(updatedAt);
  }

  bumpLatestForWorkItemsUpdatedAtStatement(
    updatedAt: string,
    marketDate: string,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
         SELECT 'latest', 1, ?1
         WHERE EXISTS (
           SELECT 1 FROM work_items
           WHERE scope = 'global_fact' AND updated_at = ?1
             AND effective_date = (SELECT MAX(trading_date)
                                   FROM daily_market_facts
                                   WHERE trading_date <= ?2)
         )
         ON CONFLICT(bucket_key) DO UPDATE SET
           revision = fact_revision_buckets.revision + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(updatedAt, marketDate);
  }
}
