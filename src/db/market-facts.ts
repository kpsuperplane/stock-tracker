export type DailyMarketFactStatus = "valid" | "stale" | "error";
export type MovementBasis = "split_adjusted_price_return" | "legacy_migration";

export interface DailyMarketFactRecord {
  id: string;
  instrumentId: string;
  tradingDate: string;
  previousTradingDate: string | null;
  previousRawCloseDecimal: string | null;
  currentRawCloseDecimal: string;
  crossingSplitNumerator: string;
  crossingSplitDenominator: string;
  splitAdjustedPreviousCloseDecimal: string | null;
  movementAmountDecimal: string | null;
  movementPercentDecimal: string | null;
  rawCloseDifferenceDecimal: string | null;
  movementBasis: MovementBasis;
  provider: string;
  providerRevision: string;
  retrievedAt: string;
  status: DailyMarketFactStatus;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export class MarketFactRepository {
  constructor(private readonly db: D1Database) {}

  upsertStatement(
    fact: DailyMarketFactRecord,
    publicationGuard?: { tradingDate: string; generation: number },
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO daily_market_facts
         (id, instrument_id, trading_date, previous_trading_date,
          previous_raw_close_decimal, current_raw_close_decimal,
          crossing_split_numerator, crossing_split_denominator,
          split_adjusted_previous_close_decimal, movement_amount_decimal,
          movement_percent_decimal, raw_close_difference_decimal, movement_basis,
          provider, provider_revision, retrieved_at, status, error_code,
          error_message, created_at, updated_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21
          WHERE ?22 IS NULL OR EXISTS (
            SELECT 1 FROM report_runs winner
             WHERE winner.trading_date = ?22
               AND winner.published = 1
               AND winner.generation = ?23
          )
         ON CONFLICT(instrument_id, trading_date) DO UPDATE SET
          previous_trading_date = excluded.previous_trading_date,
          previous_raw_close_decimal = excluded.previous_raw_close_decimal,
          current_raw_close_decimal = excluded.current_raw_close_decimal,
          crossing_split_numerator = excluded.crossing_split_numerator,
          crossing_split_denominator = excluded.crossing_split_denominator,
          split_adjusted_previous_close_decimal = excluded.split_adjusted_previous_close_decimal,
          movement_amount_decimal = excluded.movement_amount_decimal,
          movement_percent_decimal = excluded.movement_percent_decimal,
          raw_close_difference_decimal = excluded.raw_close_difference_decimal,
          movement_basis = excluded.movement_basis, provider = excluded.provider,
          provider_revision = excluded.provider_revision,
          retrieved_at = excluded.retrieved_at, status = excluded.status,
          error_code = excluded.error_code, error_message = excluded.error_message,
          updated_at = excluded.updated_at
          WHERE ?22 IS NULL OR EXISTS (
            SELECT 1 FROM report_runs winner
             WHERE winner.trading_date = ?22
               AND winner.published = 1
               AND winner.generation = ?23
          )`,
      )
      .bind(
        fact.id,
        fact.instrumentId,
        fact.tradingDate,
        fact.previousTradingDate,
        fact.previousRawCloseDecimal,
        fact.currentRawCloseDecimal,
        fact.crossingSplitNumerator,
        fact.crossingSplitDenominator,
        fact.splitAdjustedPreviousCloseDecimal,
        fact.movementAmountDecimal,
        fact.movementPercentDecimal,
        fact.rawCloseDifferenceDecimal,
        fact.movementBasis,
        fact.provider,
        fact.providerRevision,
        fact.retrievedAt,
        fact.status,
        fact.errorCode,
        fact.errorMessage,
        fact.createdAt,
        fact.updatedAt,
        publicationGuard?.tradingDate ?? null,
        publicationGuard?.generation ?? null,
      );
  }

  async listDatesForInstrument(input: {
    instrumentId: string;
    provider?: string;
  }): Promise<string[]> {
    const result = await this.db
      .prepare(
        `SELECT trading_date AS tradingDate FROM daily_market_facts
         WHERE instrument_id = ?1
           AND (?2 IS NULL OR provider = ?2)
         ORDER BY trading_date`,
      )
      .bind(input.instrumentId, input.provider ?? null)
      .all<{ tradingDate: string }>();
    return result.results.map((row) => row.tradingDate);
  }

  markErrorStatement(input: {
    instrumentId: string;
    tradingDate?: string;
    provider: string;
    providerRevision: string;
    retrievedAt: string;
    errorCode: string;
    errorMessage: string;
    updatedAt: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE daily_market_facts
         SET provider = ?1, provider_revision = ?2, retrieved_at = ?3,
             status = 'error', error_code = ?4, error_message = ?5,
             updated_at = ?6
         WHERE instrument_id = ?7
           AND (?8 IS NULL OR trading_date = ?8)
           AND (?8 IS NOT NULL OR provider = ?9)`,
      )
      .bind(
        input.provider,
        input.providerRevision,
        input.retrievedAt,
        input.errorCode,
        input.errorMessage,
        input.updatedAt,
        input.instrumentId,
        input.tradingDate ?? null,
        input.provider,
      );
  }
}
