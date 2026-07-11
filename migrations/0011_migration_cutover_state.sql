CREATE TABLE portfolio_migration_state (
  id TEXT PRIMARY KEY CHECK (id = 'legacy-published'),
  cursor_trading_date TEXT,
  cursor_run_id TEXT,
  cursor_generation INTEGER,
  cursor_screening_id TEXT,
  high_water_trading_date TEXT,
  high_water_generation INTEGER,
  high_water_run_id TEXT,
  pass_number INTEGER NOT NULL DEFAULT 0 CHECK (pass_number >= 0),
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle', 'running', 'complete', 'failed')),
  lease_owner TEXT,
  lease_until TEXT,
  examined_count INTEGER NOT NULL DEFAULT 0 CHECK (examined_count >= 0),
  inserted_count INTEGER NOT NULL DEFAULT 0 CHECK (inserted_count >= 0),
  updated_count INTEGER NOT NULL DEFAULT 0 CHECK (updated_count >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  mismatched_count INTEGER NOT NULL DEFAULT 0 CHECK (mismatched_count >= 0),
  error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  last_error_code TEXT,
  last_error_message TEXT,
  last_audit_hash TEXT,
  pass_unexplained_count INTEGER NOT NULL DEFAULT 0 CHECK (pass_unexplained_count >= 0),
  consecutive_clean_passes INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_clean_passes >= 0),
  last_started_at TEXT,
  last_completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO portfolio_migration_state
  (id, status, created_at, updated_at)
VALUES ('legacy-published', 'idle', datetime('now'), datetime('now'));

CREATE TABLE portfolio_migration_audit (
  id TEXT PRIMARY KEY,
  migration_id TEXT NOT NULL REFERENCES portfolio_migration_state(id) ON DELETE CASCADE,
  legacy_run_id TEXT NOT NULL,
  legacy_screening_id TEXT NOT NULL,
  legacy_generation INTEGER NOT NULL CHECK (legacy_generation >= 1),
  trading_date TEXT NOT NULL,
  ticker_id TEXT,
  instrument_id TEXT,
  content_hash TEXT NOT NULL,
  provenance_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('inserted', 'updated', 'unchanged', 'skipped', 'mismatched', 'error')
  ),
  reason_code TEXT,
  reason_message TEXT,
  examined_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (migration_id, legacy_run_id, legacy_screening_id,
          legacy_generation, content_hash)
);
CREATE INDEX portfolio_migration_audit_screening_idx
  ON portfolio_migration_audit(legacy_screening_id, legacy_generation, examined_at DESC);
CREATE INDEX portfolio_migration_audit_outcome_idx
  ON portfolio_migration_audit(outcome, examined_at DESC);
