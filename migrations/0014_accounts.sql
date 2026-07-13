-- Accounts are the ownership boundary for ledger transactions.  The seeded
-- category/account lets existing rows and older clients continue to work
-- while callers migrate to explicit account selection.
CREATE TABLE account_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX account_categories_active_name_idx
  ON account_categories(lower(name))
  WHERE archived_at IS NULL;
CREATE INDEX account_categories_order_idx
  ON account_categories(archived_at, sort_order, lower(name), id);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL REFERENCES account_categories(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX accounts_active_category_name_idx
  ON accounts(category_id, lower(name))
  WHERE archived_at IS NULL;
CREATE INDEX accounts_category_order_idx
  ON accounts(category_id, archived_at, sort_order, lower(name), id);
CREATE INDEX accounts_active_idx
  ON accounts(archived_at, category_id, sort_order, id);

CREATE TABLE account_structure_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT,
  last_mutation_id TEXT
);
INSERT INTO account_structure_state (id, revision) VALUES (1, 0);

-- Stable IDs make the compatibility backfill idempotent across local and
-- remote databases.  New application-created rows use generated IDs.
INSERT INTO account_categories
  (id, name, sort_order, revision, created_at, updated_at)
VALUES
  ('account-category-uncategorized', 'Uncategorized', 0, 1,
   datetime('now'), datetime('now'));
INSERT INTO accounts
  (id, category_id, name, sort_order, revision, created_at, updated_at)
VALUES
  ('account-default', 'account-category-uncategorized', 'Default Account', 0, 1,
   datetime('now'), datetime('now'));

-- Existing deployments already have the two tables.  Adding a NOT NULL
-- default preserves old inserts while making every stored row account-owned.
ALTER TABLE transactions
  ADD COLUMN account_id TEXT NOT NULL DEFAULT 'account-default';
ALTER TABLE import_batches
  ADD COLUMN account_id TEXT NOT NULL DEFAULT 'account-default';

CREATE INDEX transactions_account_instrument_date_idx
  ON transactions(account_id, instrument_id, trade_date, id);
CREATE INDEX transactions_account_events_idx
  ON transactions(account_id, trade_date DESC, id DESC);
CREATE INDEX import_batches_account_created_idx
  ON import_batches(account_id, created_at DESC, id DESC);

-- Foreign-key references cannot be added to an existing table with SQLite's
-- ALTER TABLE without rebuilding it.  These guards provide the same invariant
-- for both legacy writes and future writes, including archived-account checks.
CREATE TRIGGER transactions_account_insert_guard
BEFORE INSERT ON transactions
WHEN NOT EXISTS (
  SELECT 1 FROM accounts
   WHERE id = NEW.account_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'account_required');
END;

CREATE TRIGGER transactions_account_update_guard
BEFORE UPDATE OF account_id ON transactions
WHEN NOT EXISTS (
  SELECT 1 FROM accounts
   WHERE id = NEW.account_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'account_required');
END;

CREATE TRIGGER import_batches_account_insert_guard
BEFORE INSERT ON import_batches
WHEN NOT EXISTS (
  SELECT 1 FROM accounts
   WHERE id = NEW.account_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'account_required');
END;

CREATE TRIGGER import_batches_account_update_guard
BEFORE UPDATE OF account_id ON import_batches
WHEN NOT EXISTS (
  SELECT 1 FROM accounts
   WHERE id = NEW.account_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'account_required');
END;

CREATE TRIGGER accounts_active_category_insert_guard
BEFORE INSERT ON accounts
WHEN NOT EXISTS (
  SELECT 1 FROM account_categories
   WHERE id = NEW.category_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'category_required');
END;

CREATE TRIGGER accounts_active_category_update_guard
BEFORE UPDATE OF category_id, archived_at ON accounts
WHEN NEW.archived_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM account_categories
   WHERE id = NEW.category_id AND archived_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'category_required');
END;

-- Every hierarchy write advances one shared revision used by read-model ETags.
-- The row-level trigger is intentionally independent of application code so
-- direct maintenance writes cannot leave a stale structure revision behind.
CREATE TRIGGER account_categories_structure_insert_revision
AFTER INSERT ON account_categories
BEGIN
  UPDATE account_structure_state
     SET revision = revision + 1,
         updated_at = NEW.updated_at,
         last_mutation_id = NEW.id
   WHERE id = 1;
END;

CREATE TRIGGER account_categories_structure_update_revision
AFTER UPDATE OF name, sort_order, revision, archived_at ON account_categories
BEGIN
  UPDATE account_structure_state
     SET revision = revision + 1,
         updated_at = NEW.updated_at,
         last_mutation_id = NEW.id
   WHERE id = 1;
END;

CREATE TRIGGER account_categories_structure_delete_revision
AFTER DELETE ON account_categories
BEGIN
  UPDATE account_structure_state
     SET revision = revision + 1,
         updated_at = datetime('now'),
         last_mutation_id = OLD.id
   WHERE id = 1;
END;

CREATE TRIGGER accounts_structure_insert_revision
AFTER INSERT ON accounts
BEGIN
  UPDATE account_structure_state
     SET revision = revision + 1,
         updated_at = NEW.updated_at,
         last_mutation_id = NEW.id
   WHERE id = 1;
END;

CREATE TRIGGER accounts_structure_update_revision
AFTER UPDATE OF category_id, name, sort_order, revision, archived_at ON accounts
BEGIN
  UPDATE account_structure_state
     SET revision = revision + 1,
         updated_at = NEW.updated_at,
         last_mutation_id = NEW.id
   WHERE id = 1;
END;

CREATE TRIGGER accounts_structure_delete_revision
AFTER DELETE ON accounts
BEGIN
  UPDATE account_structure_state
     SET revision = revision + 1,
         updated_at = datetime('now'),
         last_mutation_id = OLD.id
   WHERE id = 1;
END;
