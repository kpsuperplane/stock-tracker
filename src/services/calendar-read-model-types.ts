export interface TransactionRow {
  instrument_id: string;
  trade_date: string;
  quantity_decimal: string;
  side: "buy" | "sell";
  id: string;
}

export interface SplitRow {
  instrument_id: string;
  effective_date: string;
  split_numerator: string;
  split_denominator: string;
  id: string;
}

export interface FactRow {
  id: string;
  instrument_id: string;
  symbol: string;
  company_name: string;
  exchange: string;
  currency: "USD" | "CAD";
  trading_date: string;
  previous_trading_date: string | null;
  previous_raw_close_decimal: string | null;
  current_raw_close_decimal: string;
  split_adjusted_previous_close_decimal: string | null;
  movement_amount_decimal: string | null;
  movement_percent_decimal: string | null;
  raw_close_difference_decimal: string | null;
  movement_basis: "split_adjusted_price_return" | "legacy_migration";
  status: "valid" | "stale" | "error";
  error_code: string | null;
  error_message: string | null;
}

export interface AnalysisRow {
  id: string;
  daily_market_fact_id: string;
  summary_zh_cn: string | null;
  status: "pending" | "complete" | "stale" | "error";
  error_code: string | null;
  error_message: string | null;
}

export interface CompleteAnalysisRow extends AnalysisRow {
  instrument_id: string;
  trading_date: string;
}

export interface SourceRow {
  movement_analysis_id: string;
  title: string;
  publisher: string | null;
  published_at: string | null;
  source_url: string;
  cited: number;
}

export interface DividendRow {
  id: string;
  instrument_id: string;
  symbol: string;
  company_name: string;
  currency: "USD" | "CAD";
  ex_date: string;
  payment_date: string | null;
  amount_per_share_decimal: string;
  status: "active" | "stale" | "error" | "superseded";
  error_code: string | null;
  error_message: string | null;
  source_url: string | null;
  provider: string;
}

export interface EarningsRow {
  id: string;
  instrument_id: string;
  symbol: string;
  company_name: string;
  report_date: string;
  fiscal_date_ending: string;
  eps_estimate_decimal: string | null;
  currency: "USD" | "CAD";
  time_of_day: string | null;
  status: "active" | "stale";
  provider: string;
}

export interface EarningsCoverageRow {
  coverage_start_date: string | null;
  coverage_end_date: string | null;
  status: "current" | "stale" | "unavailable";
}
