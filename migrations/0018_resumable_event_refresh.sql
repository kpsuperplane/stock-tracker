CREATE TABLE earnings_history_coverage (
  instrument_id TEXT PRIMARY KEY REFERENCES instruments(id) ON DELETE CASCADE,
  requested_start_date TEXT NOT NULL,
  coverage_start_date TEXT,
  coverage_end_date TEXT,
  provider TEXT,
  sec_cik TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'retry', 'current')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  last_attempted_at TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    status <> 'current'
    OR (
      coverage_start_date IS NOT NULL
      AND coverage_end_date IS NOT NULL
      AND coverage_start_date <= coverage_end_date
      AND provider IS NOT NULL
      AND completed_at IS NOT NULL
      AND last_error_code IS NULL
      AND last_error_message IS NULL
    )
  )
);
CREATE INDEX earnings_history_coverage_due_idx
  ON earnings_history_coverage(status, next_attempt_at, lease_until, updated_at);

CREATE TABLE dividend_refresh_state (
  instrument_id TEXT PRIMARY KEY REFERENCES instruments(id) ON DELETE CASCADE,
  requested_start_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'retry', 'current')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  last_attempted_at TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX dividend_refresh_state_due_idx
  ON dividend_refresh_state(status, next_attempt_at, lease_until, updated_at);

CREATE TABLE alpha_vantage_daily_usage (
  usage_date TEXT PRIMARY KEY,
  requests_used INTEGER NOT NULL CHECK (requests_used BETWEEN 0 AND 25),
  earnings_calendar_requests INTEGER NOT NULL DEFAULT 0
    CHECK (earnings_calendar_requests >= 0),
  earnings_history_requests INTEGER NOT NULL DEFAULT 0
    CHECK (earnings_history_requests >= 0),
  dividend_requests INTEGER NOT NULL DEFAULT 0
    CHECK (dividend_requests >= 0),
  updated_at TEXT NOT NULL,
  CHECK (
    requests_used = earnings_calendar_requests
      + earnings_history_requests
      + dividend_requests
  )
);
