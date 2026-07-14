const heldStockCount = async (db: D1Database): Promise<number> => {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT i.id) AS count
         FROM instruments i
         JOIN transactions t ON t.instrument_id = i.id
        WHERE i.security_type = 'stock'`,
    )
    .first<{ count: number }>();
  return row?.count ?? 0;
};

export const reconcileDividendCoverage = async (
  db: D1Database,
  timestamp: string,
): Promise<number> => {
  await db
    .prepare(
      `INSERT INTO dividend_refresh_state
       (instrument_id, requested_start_date, status, attempt_count,
        next_attempt_at, created_at, updated_at)
       SELECT i.id, MIN(t.trade_date), 'pending', 0, ?1, ?1, ?1
         FROM instruments i
         JOIN transactions t ON t.instrument_id = i.id
        WHERE i.security_type = 'stock'
        GROUP BY i.id
       ON CONFLICT(instrument_id) DO UPDATE SET
         requested_start_date = MIN(
           dividend_refresh_state.requested_start_date,
           excluded.requested_start_date
         ),
         status = CASE
           WHEN excluded.requested_start_date
                  < dividend_refresh_state.requested_start_date
           THEN 'pending'
           ELSE dividend_refresh_state.status
         END,
         next_attempt_at = CASE
           WHEN excluded.requested_start_date
                  < dividend_refresh_state.requested_start_date
           THEN excluded.next_attempt_at
           ELSE dividend_refresh_state.next_attempt_at
         END,
         updated_at = ?1`,
    )
    .bind(timestamp)
    .run();
  return heldStockCount(db);
};

export const reconcileEarningsHistoryCoverage = async (
  db: D1Database,
  timestamp: string,
): Promise<number> => {
  await db
    .prepare(
      `INSERT INTO earnings_history_coverage
       (instrument_id, requested_start_date, status, attempt_count,
        next_attempt_at, created_at, updated_at)
       SELECT i.id, MIN(t.trade_date), 'pending', 0, ?1, ?1, ?1
         FROM instruments i
         JOIN transactions t ON t.instrument_id = i.id
        WHERE i.security_type = 'stock'
        GROUP BY i.id
       ON CONFLICT(instrument_id) DO UPDATE SET
         requested_start_date = MIN(
           earnings_history_coverage.requested_start_date,
           excluded.requested_start_date
         ),
         status = CASE
           WHEN excluded.requested_start_date
                  < earnings_history_coverage.requested_start_date
           THEN 'pending'
           ELSE earnings_history_coverage.status
         END,
         next_attempt_at = CASE
           WHEN excluded.requested_start_date
                  < earnings_history_coverage.requested_start_date
           THEN excluded.next_attempt_at
           ELSE earnings_history_coverage.next_attempt_at
         END,
         updated_at = ?1`,
    )
    .bind(timestamp)
    .run();
  return heldStockCount(db);
};

export const reconcileEventCoverage = async (
  db: D1Database,
  timestamp: string,
): Promise<{
  dividendInstruments: number;
  earningsHistoryInstruments: number;
}> => {
  const [dividendInstruments, earningsHistoryInstruments] = await Promise.all([
    reconcileDividendCoverage(db, timestamp),
    reconcileEarningsHistoryCoverage(db, timestamp),
  ]);
  return { dividendInstruments, earningsHistoryInstruments };
};
