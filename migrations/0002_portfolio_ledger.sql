CREATE TABLE instruments (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,
  exchange TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'CAD')),
  instrument_type TEXT NOT NULL CHECK (instrument_type IN ('stock', 'etf')),
  provider TEXT NOT NULL,
  provider_symbol TEXT NOT NULL,
  provider_metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_symbol)
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
  trade_date TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quantity_decimal TEXT NOT NULL CHECK (length(quantity_decimal) > 0),
  price_decimal TEXT NOT NULL CHECK (length(price_decimal) > 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX transactions_instrument_date_idx
  ON transactions(instrument_id, trade_date, id);
CREATE INDEX transactions_events_idx
  ON transactions(trade_date DESC, id DESC);

CREATE TABLE corporate_actions (
  id TEXT PRIMARY KEY,
  instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
  action_type TEXT NOT NULL CHECK (action_type = 'split'),
  effective_date TEXT NOT NULL,
  split_numerator TEXT NOT NULL CHECK (length(split_numerator) > 0),
  split_denominator TEXT NOT NULL CHECK (length(split_denominator) > 0),
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  provider_revision TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  status TEXT NOT NULL CHECK (
    status IN ('candidate', 'active', 'superseded', 'quarantined')
  ),
  conflict_code TEXT,
  conflict_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (instrument_id, provider, provider_event_id, provider_revision),
  CHECK (
    (status = 'quarantined' AND conflict_code IS NOT NULL)
    OR (status <> 'quarantined' AND conflict_code IS NULL AND conflict_message IS NULL)
  )
);
CREATE INDEX corporate_actions_instrument_date_idx
  ON corporate_actions(instrument_id, effective_date, id);
CREATE INDEX corporate_actions_status_idx
  ON corporate_actions(instrument_id, status, effective_date);

CREATE TABLE corporate_action_coverage (
  instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL,
  requested_start_date TEXT NOT NULL,
  requested_end_date TEXT NOT NULL,
  snapshot_provider_revision TEXT,
  retrieved_at TEXT,
  confirmed_start_date TEXT,
  confirmed_end_date TEXT,
  confirmed_provider_revision TEXT,
  confirmed_at TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('review_required', 'confirmed', 'refreshing', 'unavailable', 'conflict')
  ),
  error_code TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (instrument_id, provider),
  CHECK (requested_start_date <= requested_end_date),
  CHECK (
    (snapshot_provider_revision IS NULL AND retrieved_at IS NULL)
    OR (snapshot_provider_revision IS NOT NULL AND retrieved_at IS NOT NULL)
  ),
  CHECK (
    (confirmed_start_date IS NULL AND confirmed_end_date IS NULL
      AND confirmed_provider_revision IS NULL AND confirmed_at IS NULL)
    OR (confirmed_start_date IS NOT NULL AND confirmed_end_date IS NOT NULL
      AND confirmed_provider_revision IS NOT NULL AND confirmed_at IS NOT NULL
      AND confirmed_start_date <= confirmed_end_date)
  ),
  CHECK (
    status <> 'confirmed'
    OR (snapshot_provider_revision IS NOT NULL
      AND retrieved_at IS NOT NULL
      AND confirmed_start_date IS NOT NULL
      AND confirmed_end_date IS NOT NULL
      AND confirmed_provider_revision IS NOT NULL
      AND confirmed_at IS NOT NULL
      AND confirmed_provider_revision = snapshot_provider_revision
      AND confirmed_start_date = requested_start_date
      AND confirmed_end_date = requested_end_date)
  )
);
CREATE INDEX corporate_action_coverage_status_idx
  ON corporate_action_coverage(status, updated_at);

CREATE TABLE position_basis_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT,
  last_mutation_id TEXT
);
INSERT INTO position_basis_state (id, revision) VALUES (1, 0);

CREATE TABLE ledger_mutations (
  id TEXT PRIMARY KEY,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  resulting_revision INTEGER NOT NULL CHECK (resulting_revision >= 1),
  mutation_kind TEXT NOT NULL CHECK (
    mutation_kind IN (
      'transaction_create', 'transaction_update', 'transaction_delete',
      'import_commit', 'candidate_refresh', 'action_confirmation',
      'action_invalidation', 'action_quarantine', 'action_promotion'
    )
  ),
  created_at TEXT NOT NULL,
  CHECK (resulting_revision = expected_revision + 1)
);

CREATE TRIGGER ledger_mutations_revision_guard
BEFORE INSERT ON ledger_mutations
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM position_basis_state WHERE id = 1)
      OR NEW.expected_revision IS NOT (SELECT revision FROM position_basis_state WHERE id = 1)
    THEN RAISE(ABORT, 'ledger_conflict')
  END;
END;

CREATE TRIGGER ledger_mutations_advance_revision
AFTER INSERT ON ledger_mutations
BEGIN
  UPDATE position_basis_state
  SET revision = NEW.resulting_revision,
      updated_at = NEW.created_at,
      last_mutation_id = NEW.id
  WHERE id = 1;
  SELECT CASE
    WHEN changes() <> 1 THEN RAISE(ABORT, 'ledger_state_missing')
  END;
END;

CREATE TABLE pipeline_jobs (
  id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL CHECK (
    trigger_type IN ('scheduled', 'ledger_reconciliation', 'backfill')
  ),
  requested_start_date TEXT,
  requested_end_date TEXT,
  affected_instruments_json TEXT NOT NULL DEFAULT '[]',
  eligibility_intervals_json TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'planning', 'running', 'complete', 'complete_with_errors', 'terminal')
  ),
  work_total INTEGER NOT NULL DEFAULT 0 CHECK (work_total >= 0),
  work_reused INTEGER NOT NULL DEFAULT 0 CHECK (work_reused >= 0),
  work_skipped INTEGER NOT NULL DEFAULT 0 CHECK (work_skipped >= 0),
  work_fetched INTEGER NOT NULL DEFAULT 0 CHECK (work_fetched >= 0),
  work_analyzed INTEGER NOT NULL DEFAULT 0 CHECK (work_analyzed >= 0),
  work_processed INTEGER NOT NULL DEFAULT 0 CHECK (work_processed >= 0),
  work_failed INTEGER NOT NULL DEFAULT 0 CHECK (work_failed >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  retention_until TEXT,
  CHECK (
    (requested_start_date IS NULL AND requested_end_date IS NULL)
    OR (requested_start_date IS NOT NULL AND requested_end_date IS NOT NULL
      AND requested_start_date <= requested_end_date)
  )
);
CREATE INDEX pipeline_jobs_status_priority_idx
  ON pipeline_jobs(status, priority DESC, created_at);

CREATE TABLE import_batches (
  id TEXT PRIMARY KEY,
  file_digest TEXT NOT NULL UNIQUE,
  original_filename TEXT NOT NULL,
  base_position_basis_revision INTEGER NOT NULL CHECK (base_position_basis_revision >= 0),
  projected_holdings_json TEXT,
  status TEXT NOT NULL CHECK (status IN ('preview', 'committed', 'expired', 'rejected')),
  result_pipeline_job_id TEXT REFERENCES pipeline_jobs(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  committed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((status = 'committed') = (committed_at IS NOT NULL))
);
CREATE INDEX import_batches_status_expiry_idx ON import_batches(status, expires_at);

CREATE TABLE import_rows (
  id TEXT PRIMARY KEY,
  import_batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL CHECK (row_number >= 2),
  symbol TEXT NOT NULL,
  trade_date TEXT,
  side TEXT CHECK (side IN ('buy', 'sell')),
  quantity_decimal TEXT,
  price_decimal TEXT,
  status TEXT NOT NULL CHECK (status IN ('valid', 'invalid')),
  validation_errors_json TEXT,
  normalized_transaction_json TEXT,
  UNIQUE (import_batch_id, row_number)
);
CREATE INDEX import_rows_batch_status_idx ON import_rows(import_batch_id, status, row_number);

CREATE TABLE work_items (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('job_planning', 'global_fact')),
  pipeline_job_id TEXT REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
  work_type TEXT NOT NULL,
  instrument_id TEXT REFERENCES instruments(id) ON DELETE RESTRICT,
  effective_date TEXT,
  dependency_revision TEXT,
  forced_refresh_generation INTEGER CHECK (forced_refresh_generation >= 0),
  deterministic_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (
    state IN ('pending', 'dispatching', 'queued', 'processing', 'complete', 'terminal')
  ),
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  dispatch_lease_until TEXT,
  processing_lease_until TEXT,
  result_revision TEXT,
  terminal_error_code TEXT,
  terminal_error_message TEXT,
  available_at TEXT,
  retention_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (
    (scope = 'job_planning' AND pipeline_job_id IS NOT NULL)
    OR (scope = 'global_fact' AND pipeline_job_id IS NULL)
  )
);
CREATE INDEX work_items_state_priority_idx
  ON work_items(state, priority DESC, available_at, created_at);
CREATE INDEX work_items_job_idx ON work_items(pipeline_job_id, state);
CREATE UNIQUE INDEX work_items_one_planner_per_job_idx
  ON work_items(pipeline_job_id) WHERE scope = 'job_planning';
CREATE INDEX work_items_fact_idx
  ON work_items(instrument_id, effective_date, work_type) WHERE scope = 'global_fact';

CREATE TABLE job_work_items (
  pipeline_job_id TEXT NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
  work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  relationship TEXT NOT NULL CHECK (relationship IN ('required', 'optional')),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('pending', 'reused', 'skipped', 'processed', 'failed')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT,
  PRIMARY KEY (pipeline_job_id, work_item_id)
);
CREATE INDEX job_work_items_work_idx ON job_work_items(work_item_id, pipeline_job_id);
