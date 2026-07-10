CREATE TABLE daily_market_facts (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
  trading_date TEXT NOT NULL,
  previous_trading_date TEXT,
  previous_raw_close_decimal TEXT,
  current_raw_close_decimal TEXT NOT NULL CHECK (length(current_raw_close_decimal) > 0),
  crossing_split_numerator TEXT NOT NULL DEFAULT '1' CHECK (
    crossing_split_numerator GLOB '[1-9]*'
    AND crossing_split_numerator NOT GLOB '*[^0-9]*'
  ),
  crossing_split_denominator TEXT NOT NULL DEFAULT '1' CHECK (
    crossing_split_denominator GLOB '[1-9]*'
    AND crossing_split_denominator NOT GLOB '*[^0-9]*'
  ),
  split_adjusted_previous_close_decimal TEXT,
  movement_amount_decimal TEXT,
  movement_percent_decimal TEXT,
  raw_close_difference_decimal TEXT,
  movement_basis TEXT NOT NULL CHECK (
    movement_basis IN ('split_adjusted_price_return', 'legacy_migration')
  ),
  provider TEXT NOT NULL,
  provider_revision TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid', 'stale', 'error')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (instrument_id, trading_date),
  CHECK (
    (status = 'error' AND error_code IS NOT NULL)
    OR (status <> 'error' AND error_code IS NULL AND error_message IS NULL)
  ),
  CHECK (
    (previous_trading_date IS NULL AND previous_raw_close_decimal IS NULL
      AND split_adjusted_previous_close_decimal IS NULL
      AND movement_amount_decimal IS NULL AND movement_percent_decimal IS NULL)
    OR (previous_trading_date IS NOT NULL AND previous_raw_close_decimal IS NOT NULL
      AND split_adjusted_previous_close_decimal IS NOT NULL
      AND movement_amount_decimal IS NOT NULL AND movement_percent_decimal IS NOT NULL
      AND previous_trading_date < trading_date)
  )
);
CREATE INDEX daily_market_facts_instrument_date_idx
  ON daily_market_facts(instrument_id, trading_date DESC);
CREATE INDEX daily_market_facts_status_date_idx
  ON daily_market_facts(status, trading_date DESC);

CREATE TABLE movement_analyses (
  id TEXT PRIMARY KEY,
  daily_market_fact_id TEXT NOT NULL UNIQUE REFERENCES daily_market_facts(id) ON DELETE CASCADE,
  dependency_fingerprint TEXT NOT NULL,
  summary_zh_cn TEXT,
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'stale', 'error')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (status = 'complete' AND summary_zh_cn IS NOT NULL AND error_code IS NULL AND error_message IS NULL)
    OR (status = 'error' AND error_code IS NOT NULL)
    OR (status IN ('pending', 'stale') AND error_code IS NULL AND error_message IS NULL)
  )
);
CREATE INDEX movement_analyses_status_updated_idx
  ON movement_analyses(status, updated_at);

CREATE TABLE news_sources (
  id TEXT PRIMARY KEY,
  movement_analysis_id TEXT NOT NULL REFERENCES movement_analyses(id) ON DELETE CASCADE,
  source_order INTEGER NOT NULL CHECK (source_order >= 0),
  title TEXT NOT NULL,
  publisher TEXT,
  published_at TEXT,
  source_url TEXT NOT NULL,
  cited INTEGER NOT NULL DEFAULT 1 CHECK (cited IN (0, 1)),
  created_at TEXT NOT NULL,
  UNIQUE (movement_analysis_id, source_order),
  CHECK (source_url GLOB 'http://*' OR source_url GLOB 'https://*')
);
CREATE INDEX news_sources_analysis_idx ON news_sources(movement_analysis_id, source_order);

CREATE TABLE dividend_events (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
  ex_date TEXT NOT NULL,
  declaration_date TEXT,
  record_date TEXT,
  payment_date TEXT,
  amount_per_share_decimal TEXT NOT NULL CHECK (length(amount_per_share_decimal) > 0),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'CAD')),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_revision TEXT NOT NULL,
  source_url TEXT,
  announced_at TEXT,
  retrieved_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'stale', 'error')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (instrument_id, provider, provider_event_id, provider_revision),
  CHECK (source_url IS NULL OR source_url GLOB 'http://*' OR source_url GLOB 'https://*'),
  CHECK (
    (status = 'error' AND error_code IS NOT NULL)
    OR (status <> 'error' AND error_code IS NULL AND error_message IS NULL)
  )
);
CREATE INDEX dividend_events_instrument_ex_date_idx
  ON dividend_events(instrument_id, ex_date, status);
CREATE INDEX dividend_events_provider_identity_idx
  ON dividend_events(instrument_id, provider, provider_event_id, status);

CREATE TABLE fact_revision_buckets (
  bucket_key TEXT PRIMARY KEY CHECK (
    bucket_key = 'latest'
    OR (bucket_key GLOB '[0-9][0-9][0-9][0-9]-0[1-9]'
      OR bucket_key GLOB '[0-9][0-9][0-9][0-9]-1[0-2]')
  ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE dispatch_batches (
  id TEXT PRIMARY KEY,
  work_type TEXT NOT NULL,
  instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
  requested_start_date TEXT NOT NULL,
  requested_end_date TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('dispatching', 'queued', 'processing', 'complete', 'terminal')
  ),
  dispatch_lease_until TEXT,
  processing_lease_until TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  terminal_error_code TEXT,
  terminal_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  retention_until TEXT,
  CHECK (requested_start_date <= requested_end_date),
  CHECK (
    (state = 'terminal' AND terminal_error_code IS NOT NULL AND completed_at IS NOT NULL)
    OR (state = 'complete' AND terminal_error_code IS NULL AND terminal_error_message IS NULL AND completed_at IS NOT NULL)
    OR (state IN ('dispatching', 'queued', 'processing') AND terminal_error_code IS NULL AND terminal_error_message IS NULL AND completed_at IS NULL)
  )
);
CREATE INDEX dispatch_batches_state_lease_idx
  ON dispatch_batches(state, dispatch_lease_until, processing_lease_until, created_at);
CREATE INDEX dispatch_batches_compatibility_idx
  ON dispatch_batches(work_type, instrument_id, requested_start_date, requested_end_date, state);

CREATE TABLE dispatch_batch_items (
  dispatch_batch_id TEXT NOT NULL REFERENCES dispatch_batches(id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (dispatch_batch_id, work_item_id)
);
CREATE INDEX dispatch_batch_items_work_idx
  ON dispatch_batch_items(work_item_id, dispatch_batch_id);
