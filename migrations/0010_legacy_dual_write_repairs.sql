CREATE TABLE legacy_dual_write_repairs (
  id TEXT PRIMARY KEY,
  legacy_run_id TEXT NOT NULL,
  legacy_screening_id TEXT NOT NULL,
  legacy_generation INTEGER NOT NULL CHECK (legacy_generation >= 1),
  trading_date TEXT NOT NULL,
  ticker_id TEXT,
  instrument_id TEXT,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'resolved', 'skipped', 'failed')
  ),
  failure_code TEXT,
  failure_message TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  first_attempted_at TEXT NOT NULL,
  last_attempted_at TEXT NOT NULL,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (legacy_screening_id),
  CHECK (
    (state IN ('failed', 'skipped') AND failure_code IS NOT NULL)
    OR (state IN ('pending', 'resolved') AND failure_code IS NULL)
  ),
  CHECK (
    (state = 'resolved' AND resolved_at IS NOT NULL)
    OR (state <> 'resolved' AND resolved_at IS NULL)
  )
);

CREATE INDEX legacy_dual_write_repairs_state_idx
  ON legacy_dual_write_repairs(state, last_attempted_at);
CREATE INDEX legacy_dual_write_repairs_run_idx
  ON legacy_dual_write_repairs(legacy_run_id, legacy_generation);
