-- Nicknames are presentation-only labels. The bank-issued account name stays
-- stable for CSV matching and uniqueness checks, while an optional nickname
-- can be changed without disturbing that identity.
ALTER TABLE accounts
  ADD COLUMN nickname TEXT
  CHECK (
    nickname IS NULL
    OR (nickname = trim(nickname) AND length(nickname) BETWEEN 1 AND 120)
  );

DROP TRIGGER accounts_structure_update_revision;

CREATE TRIGGER accounts_structure_update_revision
AFTER UPDATE OF category_id, name, nickname, owner, sort_order, revision, archived_at ON accounts
BEGIN
  UPDATE account_structure_state
     SET revision = revision + 1,
         updated_at = NEW.updated_at,
         last_mutation_id = NEW.id
   WHERE id = 1;
END;
