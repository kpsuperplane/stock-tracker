CREATE TABLE earnings_events (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
  report_date TEXT NOT NULL,
  fiscal_date_ending TEXT NOT NULL,
  eps_estimate_decimal TEXT,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'CAD')),
  time_of_day TEXT,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_revision TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'superseded', 'stale')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (instrument_id, provider, provider_event_id, provider_revision),
  CHECK (eps_estimate_decimal IS NULL OR length(eps_estimate_decimal) > 0),
  CHECK (time_of_day IS NULL OR length(time_of_day) <= 40)
);
CREATE INDEX earnings_events_instrument_report_date_idx
  ON earnings_events(instrument_id, report_date, status);
CREATE INDEX earnings_events_report_date_instrument_idx
  ON earnings_events(report_date, instrument_id, status);
CREATE INDEX earnings_events_provider_identity_idx
  ON earnings_events(instrument_id, provider, provider_event_id, status);

CREATE TABLE earnings_calendar_coverage (
  provider TEXT PRIMARY KEY,
  coverage_start_date TEXT,
  coverage_end_date TEXT,
  horizon TEXT NOT NULL CHECK (horizon = '3month'),
  provider_revision TEXT,
  observed_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('current', 'stale', 'unavailable')),
  error_code TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL,
  CHECK (
    (coverage_start_date IS NULL AND coverage_end_date IS NULL)
    OR (coverage_start_date IS NOT NULL AND coverage_end_date IS NOT NULL
      AND coverage_start_date <= coverage_end_date)
  ),
  CHECK (
    status = 'current'
      AND coverage_start_date IS NOT NULL
      AND coverage_end_date IS NOT NULL
      AND provider_revision IS NOT NULL
      AND observed_at IS NOT NULL
      AND error_code IS NULL
      AND error_message IS NULL
    OR status <> 'current'
  )
);
