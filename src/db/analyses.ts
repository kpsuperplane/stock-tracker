export interface MovementAnalysisRecord {
  id: string;
  dailyMarketFactId: string;
  dependencyFingerprint: string;
  summaryZhCn: string | null;
  model: string | null;
  status: "pending" | "complete" | "stale" | "error";
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewsSourceRecord {
  id: string;
  movementAnalysisId: string;
  sourceOrder: number;
  title: string;
  publisher: string | null;
  publishedAt: string | null;
  sourceUrl: string;
  cited: boolean;
  createdAt: string;
}

export class MovementAnalysisRepository {
  constructor(private readonly db: D1Database) {}

  upsertStatement(
    analysis: MovementAnalysisRecord,
    publicationGuard?: { tradingDate: string; generation: number },
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO movement_analyses
         (id, daily_market_fact_id, dependency_fingerprint, summary_zh_cn,
          model, status, error_code, error_message, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
          WHERE ?11 IS NULL OR EXISTS (
            SELECT 1 FROM report_runs winner
             WHERE winner.trading_date = ?11
               AND winner.published = 1
               AND winner.generation = ?12
          )
         ON CONFLICT(daily_market_fact_id) DO UPDATE SET
          dependency_fingerprint = excluded.dependency_fingerprint,
          summary_zh_cn = excluded.summary_zh_cn, model = excluded.model,
          status = excluded.status, error_code = excluded.error_code,
          error_message = excluded.error_message, updated_at = excluded.updated_at
          WHERE ?11 IS NULL OR EXISTS (
            SELECT 1 FROM report_runs winner
             WHERE winner.trading_date = ?11
               AND winner.published = 1
               AND winner.generation = ?12
          )`,
      )
      .bind(
        analysis.id,
        analysis.dailyMarketFactId,
        analysis.dependencyFingerprint,
        analysis.summaryZhCn,
        analysis.model,
        analysis.status,
        analysis.errorCode,
        analysis.errorMessage,
        analysis.createdAt,
        analysis.updatedAt,
        publicationGuard?.tradingDate ?? null,
        publicationGuard?.generation ?? null,
      );
  }

  replaceSourcesStatements(
    input: {
      movementAnalysisId: string;
      sources: readonly NewsSourceRecord[];
    },
    publicationGuard?: { tradingDate: string; generation: number },
    dailyMarketFactId?: string,
  ): D1PreparedStatement[] {
    return [
      this.db
        .prepare(
          `DELETE FROM news_sources
            WHERE movement_analysis_id = COALESCE(
              (SELECT id FROM movement_analyses
                WHERE daily_market_fact_id = ?2), ?1)
              AND (?3 IS NULL OR EXISTS (
                SELECT 1 FROM report_runs winner
                 WHERE winner.trading_date = ?3
                   AND winner.published = 1
                   AND winner.generation = ?4
              ))`,
        )
        .bind(
          input.movementAnalysisId,
          dailyMarketFactId ?? null,
          publicationGuard?.tradingDate ?? null,
          publicationGuard?.generation ?? null,
        ),
      ...input.sources.map((source) =>
        this.db
          .prepare(
            `INSERT INTO news_sources
             (id, movement_analysis_id, source_order, title, publisher,
              published_at, source_url, cited, created_at)
             SELECT ?1,
                    COALESCE(
                      (SELECT id FROM movement_analyses
                        WHERE daily_market_fact_id = ?10), ?2),
                    ?3, ?4, ?5, ?6, ?7, ?8, ?9
              WHERE ?11 IS NULL OR EXISTS (
                SELECT 1 FROM report_runs winner
                 WHERE winner.trading_date = ?11
                   AND winner.published = 1
                   AND winner.generation = ?12
              )`,
          )
          .bind(
            source.id,
            source.movementAnalysisId,
            source.sourceOrder,
            source.title,
            source.publisher,
            source.publishedAt,
            source.sourceUrl,
            source.cited ? 1 : 0,
            source.createdAt,
            dailyMarketFactId ?? null,
            publicationGuard?.tradingDate ?? null,
            publicationGuard?.generation ?? null,
          ),
      ),
    ];
  }

  async findByFact(
    dailyMarketFactId: string,
  ): Promise<MovementAnalysisRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, daily_market_fact_id AS dailyMarketFactId,
                dependency_fingerprint AS dependencyFingerprint,
                summary_zh_cn AS summaryZhCn, model, status,
                error_code AS errorCode, error_message AS errorMessage,
                created_at AS createdAt, updated_at AS updatedAt
         FROM movement_analyses WHERE daily_market_fact_id = ?1`,
      )
      .bind(dailyMarketFactId)
      .first<MovementAnalysisRecord>();
    return row ?? null;
  }

  async listSources(movementAnalysisId: string): Promise<NewsSourceRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT id, movement_analysis_id AS movementAnalysisId,
                source_order AS sourceOrder, title, publisher,
                published_at AS publishedAt, source_url AS sourceUrl,
                cited, created_at AS createdAt
         FROM news_sources WHERE movement_analysis_id = ?1
         ORDER BY source_order`,
      )
      .bind(movementAnalysisId)
      .all<Omit<NewsSourceRecord, "cited"> & { cited: number }>();
    return result.results.map((source) => ({
      ...source,
      cited: Boolean(source.cited),
    }));
  }
}
