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
}
