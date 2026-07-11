ALTER TABLE dispatch_batches
  ADD COLUMN dispatch_attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE dispatch_batches
  ADD COLUMN dispatch_max_attempts INTEGER NOT NULL DEFAULT 3;

ALTER TABLE dispatch_batches
  ADD COLUMN dlq_state TEXT NOT NULL DEFAULT 'none'
    CHECK (dlq_state IN ('none', 'pending', 'sending', 'delivered'));

ALTER TABLE dispatch_batches
  ADD COLUMN dlq_attempt_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE dispatch_batches
  ADD COLUMN dlq_lease_until TEXT;

ALTER TABLE dispatch_batches
  ADD COLUMN dlq_last_error TEXT;

ALTER TABLE dispatch_batches
  ADD COLUMN dlq_delivered_at TEXT;

CREATE TABLE dispatch_daily_reservations (
  dispatch_batch_id TEXT PRIMARY KEY,
  reservation_day TEXT NOT NULL,
  work_count INTEGER NOT NULL CHECK (work_count > 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX dispatch_daily_reservations_day_idx
  ON dispatch_daily_reservations(reservation_day, expires_at);
