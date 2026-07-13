-- Account ownership now belongs to each staged import row so one batch can
-- contain transactions for several accounts. Rebuild both staging tables to
-- remove the batch-level account and preserve already-staged previews.
DROP TRIGGER import_batches_account_insert_guard;
DROP TRIGGER import_batches_account_update_guard;

CREATE TABLE import_batches_next (
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
  status TEXT NOT NULL CHECK (status IN ('valid', 'invalid')),
  validation_errors_json TEXT,
  normalized_transaction_json TEXT,
  UNIQUE (import_batch_id, row_number),
  CHECK (status = 'invalid' OR account_id IS NOT NULL)
);

INSERT INTO import_batches_next
  (id, file_digest, original_filename, base_position_basis_revision,
   projected_holdings_json, status, result_pipeline_job_id, expires_at,
   committed_at, created_at, updated_at)
SELECT id, file_digest, original_filename, base_position_basis_revision,
       projected_holdings_json, status, result_pipeline_job_id, expires_at,
       committed_at, created_at, updated_at
  FROM import_batches;

INSERT INTO import_rows_next
  (id, import_batch_id, row_number, symbol, trade_date, side,
   quantity_decimal, price_decimal, account_id, category_name, account_name,
   status, validation_errors_json, normalized_transaction_json)
SELECT rows.id, rows.import_batch_id, rows.row_number, rows.symbol,
       rows.trade_date, rows.side, rows.quantity_decimal, rows.price_decimal,
       batches.account_id, categories.name, accounts.name, rows.status,
       rows.validation_errors_json, rows.normalized_transaction_json
  FROM import_rows AS rows
  JOIN import_batches AS batches ON batches.id = rows.import_batch_id
  JOIN accounts ON accounts.id = batches.account_id
  JOIN account_categories AS categories ON categories.id = accounts.category_id;

DROP TABLE import_rows;
DROP TABLE import_batches;
ALTER TABLE import_batches_next RENAME TO import_batches;
ALTER TABLE import_rows_next RENAME TO import_rows_copy;

-- Recreate the child after the parent has its final name. Some SQLite
-- runtimes retain the pre-rename parent name in foreign-key metadata.
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
  status TEXT NOT NULL CHECK (status IN ('valid', 'invalid')),
  validation_errors_json TEXT,
  normalized_transaction_json TEXT,
  UNIQUE (import_batch_id, row_number),
  CHECK (status = 'invalid' OR account_id IS NOT NULL)
);

INSERT INTO import_rows
  (id, import_batch_id, row_number, symbol, trade_date, side,
   quantity_decimal, price_decimal, account_id, category_name, account_name,
   status, validation_errors_json, normalized_transaction_json)
SELECT id, import_batch_id, row_number, symbol, trade_date, side,
       quantity_decimal, price_decimal, account_id, category_name, account_name,
       status, validation_errors_json, normalized_transaction_json
  FROM import_rows_copy;
DROP TABLE import_rows_copy;

CREATE INDEX import_batches_status_expiry_idx
  ON import_batches(status, expires_at);
CREATE INDEX import_rows_batch_status_idx
  ON import_rows(import_batch_id, status, row_number);
CREATE INDEX import_rows_account_batch_idx
  ON import_rows(account_id, import_batch_id, row_number);

CREATE TRIGGER import_rows_account_insert_guard
BEFORE INSERT ON import_rows
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts
   WHERE id = NEW.account_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'account_required');
END;

CREATE TRIGGER import_rows_account_update_guard
BEFORE UPDATE OF account_id ON import_rows
WHEN NEW.account_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM accounts
   WHERE id = NEW.account_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'account_required');
END;
