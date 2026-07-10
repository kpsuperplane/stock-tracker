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

  upsertStatement(analysis: MovementAnalysisRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO movement_analyses
         (id, daily_market_fact_id, dependency_fingerprint, summary_zh_cn,
          model, status, error_code, error_message, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(daily_market_fact_id) DO UPDATE SET
          dependency_fingerprint = excluded.dependency_fingerprint,
          summary_zh_cn = excluded.summary_zh_cn, model = excluded.model,
          status = excluded.status, error_code = excluded.error_code,
          error_message = excluded.error_message, updated_at = excluded.updated_at`,
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
      );
  }

  replaceSourcesStatements(input: {
    movementAnalysisId: string;
    sources: readonly NewsSourceRecord[];
  }): D1PreparedStatement[] {
    return [
      this.db
        .prepare("DELETE FROM news_sources WHERE movement_analysis_id = ?1")
        .bind(input.movementAnalysisId),
      ...input.sources.map((source) =>
        this.db
          .prepare(
            `INSERT INTO news_sources
             (id, movement_analysis_id, source_order, title, publisher,
              published_at, source_url, cited, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
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
          ),
      ),
    ];
  }
}
