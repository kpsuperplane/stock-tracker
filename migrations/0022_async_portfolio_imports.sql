-- Portfolio imports are durable queue jobs. Existing uncommitted previews are
-- expired; committed imports and their transactions remain untouched.
DROP TRIGGER IF EXISTS tickers_active_limit_insert;
DROP TRIGGER IF EXISTS tickers_active_limit_update;

CREATE TABLE import_batches_next (
  id TEXT PRIMARY KEY,
  file_digest TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  base_position_basis_revision INTEGER NOT NULL CHECK (base_position_basis_revision >= 0),
  projected_holdings_json TEXT,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'running', 'committed', 'complete_with_errors', 'terminal',
    'expired'
  )),
  result_pipeline_job_id TEXT REFERENCES pipeline_jobs(id) ON DELETE SET NULL,
  expires_at TEXT NOT NULL,
  committed_at TEXT,
  total_rows INTEGER NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  total_symbols INTEGER NOT NULL DEFAULT 0 CHECK (total_symbols >= 0),
  processed_symbols INTEGER NOT NULL DEFAULT 0 CHECK (processed_symbols >= 0),
  failed_rows INTEGER NOT NULL DEFAULT 0 CHECK (failed_rows >= 0),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  processing_lease_until TEXT,
  processing_lease_token TEXT,
  available_at TEXT,
  prepared_at TEXT,
  terminal_error_code TEXT,
  terminal_error_message TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status <> 'committed' OR committed_at IS NOT NULL),
  CHECK (processed_symbols <= total_symbols)
);

CREATE TABLE import_rows_next (
  id TEXT PRIMARY KEY,
  import_batch_id TEXT NOT NULL REFERENCES import_batches_next(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL CHECK (row_number >= 2),
  symbol TEXT NOT NULL,
  trade_date TEXT,
  side TEXT CHECK (side IN ('buy', 'sell')),
  quantity_decimal TEXT,
  price_decimal TEXT,
  account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  category_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'valid', 'invalid')),
  validation_errors_json TEXT,
  normalized_transaction_json TEXT,
  source_json TEXT,
  UNIQUE (import_batch_id, row_number),
  CHECK (status <> 'valid' OR account_id IS NOT NULL)
);

INSERT INTO import_batches_next
  (id, file_digest, original_filename, base_position_basis_revision,
   projected_holdings_json, status, result_pipeline_job_id, expires_at,
   committed_at, total_rows, total_symbols, processed_symbols, failed_rows,
   completed_at, created_at, updated_at)
SELECT id, file_digest, original_filename, base_position_basis_revision,
       projected_holdings_json,
       CASE status
         WHEN 'preview' THEN 'expired'
         WHEN 'rejected' THEN 'complete_with_errors'
         ELSE status
       END,
       result_pipeline_job_id, expires_at, committed_at,
       (SELECT COUNT(*) FROM import_rows WHERE import_batch_id = import_batches.id),
       (SELECT COUNT(DISTINCT symbol) FROM import_rows WHERE import_batch_id = import_batches.id),
       (SELECT COUNT(DISTINCT symbol) FROM import_rows WHERE import_batch_id = import_batches.id),
       (SELECT COUNT(*) FROM import_rows WHERE import_batch_id = import_batches.id AND status = 'invalid'),
       CASE WHEN status = 'preview' THEN updated_at ELSE committed_at END,
       created_at, updated_at
  FROM import_batches;

INSERT INTO import_rows_next
  (id, import_batch_id, row_number, symbol, trade_date, side,
   quantity_decimal, price_decimal, account_id, category_name, account_name,
   status, validation_errors_json, normalized_transaction_json, source_json)
SELECT id, import_batch_id, row_number, symbol, trade_date, side,
       quantity_decimal, price_decimal, account_id, category_name, account_name,
       status, validation_errors_json, normalized_transaction_json, NULL
  FROM import_rows;

DROP TABLE import_rows;
DROP TABLE import_batches;
ALTER TABLE import_batches_next RENAME TO import_batches;
ALTER TABLE import_rows_next RENAME TO import_rows_copy;

CREATE TABLE import_rows (
  id TEXT PRIMARY KEY,
  import_batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  row_number INTEGER NOT NULL CHECK (row_number >= 2),
  symbol TEXT NOT NULL,
  trade_date TEXT,
  side TEXT CHECK (side IN ('buy', 'sell')),
  quantity_decimal TEXT,
  price_decimal TEXT,
  account_id TEXT REFERENCES accounts(id) ON DELETE RESTRICT,
  category_name TEXT NOT NULL,
  account_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'valid', 'invalid')),
  validation_errors_json TEXT,
  normalized_transaction_json TEXT,
  source_json TEXT,
  UNIQUE (import_batch_id, row_number),
  CHECK (status <> 'valid' OR account_id IS NOT NULL)
);

INSERT INTO import_rows
SELECT * FROM import_rows_copy;
DROP TABLE import_rows_copy;

CREATE TABLE import_symbols (
  id TEXT PRIMARY KEY,
  import_batch_id TEXT NOT NULL REFERENCES import_batches(id) ON DELETE CASCADE,
  source_symbol TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'processing', 'retry', 'complete', 'failed', 'terminal')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  processing_token TEXT,
  available_at TEXT,
  resolved_instrument_id TEXT,
  resolved_symbol TEXT,
  provider_symbol TEXT,
  instrument_metadata_json TEXT,
  split_snapshot_json TEXT,
  projected_holdings_json TEXT,
  has_nonzero_holdings INTEGER NOT NULL DEFAULT 0 CHECK (has_nonzero_holdings IN (0, 1)),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (import_batch_id, source_symbol)
);

CREATE INDEX import_batches_status_available_idx
  ON import_batches(status, available_at, processing_lease_until, created_at);
CREATE INDEX import_batches_created_idx
  ON import_batches(created_at DESC, id DESC);
CREATE INDEX import_rows_batch_status_idx
  ON import_rows(import_batch_id, status, row_number);
CREATE INDEX import_rows_account_batch_idx
  ON import_rows(account_id, import_batch_id, row_number);
CREATE INDEX import_symbols_batch_state_idx
  ON import_symbols(import_batch_id, state, available_at, source_symbol);

CREATE TRIGGER import_rows_account_insert_guard
BEFORE INSERT ON import_rows
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts WHERE id = NEW.account_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'account_required');
END;

CREATE TRIGGER import_rows_account_update_guard
BEFORE UPDATE OF account_id ON import_rows
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts WHERE id = NEW.account_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'account_required');
END;
