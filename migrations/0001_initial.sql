PRAGMA foreign_keys = ON;

CREATE TABLE tickers (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,
  exchange TEXT NOT NULL,
  currency TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX tickers_active_idx ON tickers(active, deleted_at);

CREATE TABLE backfill_jobs (
  id TEXT PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  reprocess_existing INTEGER NOT NULL CHECK (reprocess_existing IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'complete_with_errors', 'paused')),
  dates_total INTEGER NOT NULL DEFAULT 0,
  dates_processed INTEGER NOT NULL DEFAULT 0,
  ticker_jobs_total INTEGER NOT NULL DEFAULT 0,
  ticker_jobs_processed INTEGER NOT NULL DEFAULT 0,
  ticker_jobs_failed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE report_runs (
  id TEXT PRIMARY KEY,
  trading_date TEXT NOT NULL,
  generation INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('scheduled', 'backfill')),
  backfill_job_id TEXT REFERENCES backfill_jobs(id),
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'complete', 'complete_with_errors', 'no_market_data')),
  tickers_total INTEGER NOT NULL DEFAULT 0,
  tickers_processed INTEGER NOT NULL DEFAULT 0,
  tickers_qualified INTEGER NOT NULL DEFAULT 0,
  tickers_failed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  UNIQUE (trading_date, generation)
);
CREATE UNIQUE INDEX report_runs_one_published_date_idx
  ON report_runs(trading_date) WHERE published = 1;
CREATE UNIQUE INDEX report_runs_one_scheduled_date_idx
  ON report_runs(trading_date) WHERE origin = 'scheduled';
CREATE INDEX report_runs_history_idx ON report_runs(published, trading_date DESC);

CREATE TABLE screenings (
  id TEXT PRIMARY KEY,
  report_run_id TEXT NOT NULL REFERENCES report_runs(id) ON DELETE CASCADE,
  ticker_id TEXT NOT NULL REFERENCES tickers(id),
  symbol TEXT NOT NULL,
  company_name TEXT NOT NULL,
  exchange TEXT NOT NULL,
  currency TEXT NOT NULL,
  target_date TEXT NOT NULL,
  previous_bar_date TEXT,
  previous_price REAL,
  current_price REAL,
  change_amount REAL,
  change_pct REAL,
  price_basis TEXT CHECK (price_basis IN ('adjusted', 'close')),
  qualified INTEGER CHECK (qualified IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'processing', 'complete', 'no_trading_data', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT,
  processing_started_at TEXT,
  error_code TEXT,
  error_message TEXT,
  UNIQUE (report_run_id, ticker_id)
);
CREATE INDEX screenings_run_status_idx ON screenings(report_run_id, status);
CREATE INDEX screenings_lease_idx ON screenings(status, queued_at, processing_started_at);

CREATE TABLE analyses (
  id TEXT PRIMARY KEY,
  screening_id TEXT NOT NULL UNIQUE REFERENCES screenings(id) ON DELETE CASCADE,
  explanation_zh_cn TEXT,
  confidence TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  clear_catalyst INTEGER CHECK (clear_catalyst IN (0, 1)),
  model TEXT,
  status TEXT NOT NULL CHECK (status IN ('complete', 'unavailable')),
  created_at TEXT NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  screening_id TEXT NOT NULL REFERENCES screenings(id) ON DELETE CASCADE,
  source_index INTEGER NOT NULL,
  title TEXT NOT NULL,
  publisher TEXT NOT NULL,
  published_at TEXT NOT NULL,
  url TEXT NOT NULL,
  cited INTEGER NOT NULL DEFAULT 0 CHECK (cited IN (0, 1)),
  UNIQUE (screening_id, source_index)
);
CREATE INDEX sources_screening_idx ON sources(screening_id, source_index);
