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

  upsertStatement(fact: DailyMarketFactRecord): D1PreparedStatement {
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
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
                 ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)
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
          updated_at = excluded.updated_at`,
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
      );
  }
}
