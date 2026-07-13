ALTER TABLE accounts
  ADD COLUMN owner TEXT NOT NULL DEFAULT ''
  CHECK (owner = trim(owner) AND length(owner) <= 120);

CREATE INDEX accounts_owner_idx
  ON accounts(owner, archived_at, category_id, sort_order, id)
  WHERE owner <> '';

DROP TRIGGER accounts_structure_update_revision;

CREATE TRIGGER accounts_structure_update_revision
AFTER UPDATE OF category_id, name, owner, sort_order, revision, archived_at ON accounts
BEGIN
  UPDATE account_structure_state
     SET revision = revision + 1,
         updated_at = NEW.updated_at,
         last_mutation_id = NEW.id
   WHERE id = 1;
END;
