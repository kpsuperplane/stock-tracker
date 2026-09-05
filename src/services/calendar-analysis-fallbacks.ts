import type { CompleteAnalysisRow } from "./calendar-read-model-types";

export const readCalendarAnalysisFallbacks = async (
  db: D1Database,
  instrumentIds: readonly string[],
  startDate: string,
  endDate: string,
): Promise<CompleteAnalysisRow[]> => {
  return (
    await db
      .prepare(
        `WITH complete AS MATERIALIZED (
           SELECT f.instrument_id, f.trading_date, a.id,
                  a.daily_market_fact_id, a.summary_zh_cn, a.status,
                  a.error_code, a.error_message,
                  EXISTS (
                    SELECT 1 FROM news_sources source
                     WHERE source.movement_analysis_id = a.id
                  ) AS has_sources
             FROM movement_analyses a
               INDEXED BY movement_analyses_status_updated_idx
             JOIN daily_market_facts f ON f.id = a.daily_market_fact_id
            WHERE a.status = 'complete'
              AND f.instrument_id IN (
                SELECT CAST(value AS TEXT) FROM json_each(?1)
              )
              AND f.movement_basis <> 'legacy_migration'
              AND f.trading_date <= ?3
         ),
         prior_summary AS (
           SELECT instrument_id, MAX(trading_date) AS trading_date
             FROM complete
            WHERE trading_date < ?2 AND summary_zh_cn IS NOT NULL
            GROUP BY instrument_id
         ),
         prior_source AS (
           SELECT instrument_id, MAX(trading_date) AS trading_date
             FROM complete
            WHERE trading_date < ?2 AND has_sources = 1
            GROUP BY instrument_id
         )
         SELECT instrument_id, trading_date, id, daily_market_fact_id,
                summary_zh_cn, status, error_code, error_message
           FROM complete WHERE trading_date >= ?2
         UNION
         SELECT complete.instrument_id, complete.trading_date, complete.id,
                complete.daily_market_fact_id, complete.summary_zh_cn,
                complete.status, complete.error_code, complete.error_message
           FROM complete JOIN prior_summary USING (instrument_id, trading_date)
         UNION
         SELECT complete.instrument_id, complete.trading_date, complete.id,
                complete.daily_market_fact_id, complete.summary_zh_cn,
                complete.status, complete.error_code, complete.error_message
           FROM complete JOIN prior_source USING (instrument_id, trading_date)
         ORDER BY instrument_id, trading_date, id`,
      )
      .bind(JSON.stringify(instrumentIds), startDate, endDate)
      .all<CompleteAnalysisRow>()
  ).results;
};
