-- Quota-aware scheduling stores compact coverage goals and only materializes
-- provider-sized slices after all daily resources have been reserved.

ALTER TABLE pipeline_jobs ADD COLUMN superseded_at TEXT;
ALTER TABLE pipeline_jobs
  ADD COLUMN sync_intents_pending INTEGER NOT NULL DEFAULT 0
    CHECK (sync_intents_pending >= 0);
ALTER TABLE pipeline_jobs
  ADD COLUMN sync_intents_failed INTEGER NOT NULL DEFAULT 0
    CHECK (sync_intents_failed >= 0);

CREATE TABLE resource_budget_days (
  usage_date TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('availability', 'foreground', 'history')),
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'd1_rows_read', 'd1_rows_written', 'provider_call', 'queue_send', 'kv_write'
  )),
  resource_key TEXT NOT NULL DEFAULT '',
  allocation_units INTEGER NOT NULL CHECK (allocation_units >= 0),
  reservable_units INTEGER NOT NULL CHECK (
    reservable_units >= 0 AND reservable_units <= allocation_units
  ),
  reserved_units INTEGER NOT NULL DEFAULT 0 CHECK (reserved_units >= 0),
  actual_units INTEGER NOT NULL DEFAULT 0 CHECK (actual_units >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, lane, resource_type, resource_key)
);

CREATE TABLE resource_reservations (
  id TEXT PRIMARY KEY,
  deterministic_key TEXT NOT NULL UNIQUE,
  usage_date TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('availability', 'foreground', 'history')),
  operation_type TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'consumed', 'released')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  consumed_at TEXT,
  released_at TEXT
);
CREATE INDEX resource_reservations_day_state_idx
  ON resource_reservations(usage_date, lane, state, created_at);

CREATE TABLE resource_operation_observations (
  id TEXT PRIMARY KEY,
  usage_date TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('availability', 'foreground', 'history')),
  operation_type TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'd1_rows_read', 'd1_rows_written', 'provider_call', 'queue_send', 'kv_write'
  )),
  resource_key TEXT NOT NULL DEFAULT '',
  actual_units INTEGER NOT NULL CHECK (actual_units >= 0),
  observed_at TEXT NOT NULL
);
CREATE INDEX resource_operation_observations_envelope_idx
  ON resource_operation_observations(
    lane, operation_type, resource_type, resource_key, observed_at
  );

CREATE TABLE resource_reservation_items (
  reservation_id TEXT NOT NULL
    REFERENCES resource_reservations(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN (
    'd1_rows_read', 'd1_rows_written', 'provider_call', 'queue_send', 'kv_write'
  )),
  resource_key TEXT NOT NULL DEFAULT '',
  reserved_units INTEGER NOT NULL CHECK (reserved_units > 0),
  actual_units INTEGER NOT NULL DEFAULT 0 CHECK (actual_units >= 0),
  PRIMARY KEY (reservation_id, resource_type, resource_key)
);

CREATE TRIGGER resource_reservation_items_budget_guard
BEFORE INSERT ON resource_reservation_items
BEGIN
  SELECT RAISE(ABORT, 'resource_budget_missing')
   WHERE NOT EXISTS (
     SELECT 1 FROM resource_budget_days budget
      JOIN resource_reservations reservation
        ON reservation.id = NEW.reservation_id
     WHERE budget.usage_date = reservation.usage_date
       AND budget.lane = reservation.lane
       AND budget.resource_type = NEW.resource_type
       AND budget.resource_key = NEW.resource_key
   );
  SELECT RAISE(ABORT, 'resource_budget_exhausted')
   WHERE EXISTS (
     SELECT 1 FROM resource_budget_days budget
      JOIN resource_reservations reservation
        ON reservation.id = NEW.reservation_id
     WHERE budget.usage_date = reservation.usage_date
       AND budget.lane = reservation.lane
       AND budget.resource_type = NEW.resource_type
       AND budget.resource_key = NEW.resource_key
       AND budget.reserved_units + NEW.reserved_units > budget.reservable_units
   );
END;

CREATE TRIGGER resource_reservation_items_reserve
AFTER INSERT ON resource_reservation_items
BEGIN
  UPDATE resource_budget_days
     SET reserved_units = reserved_units + NEW.reserved_units,
         updated_at = (
           SELECT updated_at FROM resource_reservations
            WHERE id = NEW.reservation_id
         )
   WHERE usage_date = (
           SELECT usage_date FROM resource_reservations
            WHERE id = NEW.reservation_id
         )
     AND lane = (
           SELECT lane FROM resource_reservations
            WHERE id = NEW.reservation_id
         )
     AND resource_type = NEW.resource_type
     AND resource_key = NEW.resource_key;
END;

CREATE TRIGGER resource_reservations_release
AFTER UPDATE OF state ON resource_reservations
WHEN OLD.state = 'reserved' AND NEW.state = 'released'
BEGIN
  UPDATE resource_budget_days
     SET reserved_units = MAX(0, reserved_units - COALESCE((
           SELECT item.reserved_units FROM resource_reservation_items item
            WHERE item.reservation_id = NEW.id
              AND item.resource_type = resource_budget_days.resource_type
              AND item.resource_key = resource_budget_days.resource_key
         ), 0)),
         updated_at = NEW.updated_at
   WHERE usage_date = NEW.usage_date AND lane = NEW.lane;
END;

CREATE TRIGGER resource_reservations_reactivate_guard
BEFORE UPDATE OF state ON resource_reservations
WHEN OLD.state = 'released' AND NEW.state = 'reserved'
BEGIN
  SELECT RAISE(ABORT, 'resource_budget_exhausted')
   WHERE EXISTS (
     SELECT 1 FROM resource_reservation_items item
     JOIN resource_budget_days budget
       ON budget.usage_date = NEW.usage_date
      AND budget.lane = NEW.lane
      AND budget.resource_type = item.resource_type
      AND budget.resource_key = item.resource_key
    WHERE item.reservation_id = NEW.id
      AND budget.reserved_units + item.reserved_units > budget.reservable_units
   );
END;

CREATE TRIGGER resource_reservations_reactivate
AFTER UPDATE OF state ON resource_reservations
WHEN OLD.state = 'released' AND NEW.state = 'reserved'
BEGIN
  UPDATE resource_budget_days
     SET reserved_units = reserved_units + COALESCE((
           SELECT item.reserved_units FROM resource_reservation_items item
            WHERE item.reservation_id = NEW.id
              AND item.resource_type = resource_budget_days.resource_type
              AND item.resource_key = resource_budget_days.resource_key
         ), 0),
         updated_at = NEW.updated_at
   WHERE usage_date = NEW.usage_date AND lane = NEW.lane;
END;

CREATE TABLE sync_intents (
  id TEXT PRIMARY KEY,
  deterministic_key TEXT NOT NULL UNIQUE,
  pipeline_job_id TEXT REFERENCES pipeline_jobs(id) ON DELETE SET NULL,
  instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  dataset TEXT NOT NULL CHECK (dataset IN (
    'market', 'analysis', 'dividends', 'earnings', 'portfolio_history'
  )),
  priority_class TEXT NOT NULL CHECK (priority_class IN (
    'current', 'future', 'recent', 'history'
  )),
  target_start_date TEXT NOT NULL,
  target_end_date TEXT NOT NULL,
  cursor_end_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'waiting', 'dispatching', 'active', 'current', 'blocked',
    'superseded'
  )),
  priority INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  next_attempt_at TEXT,
  last_served_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (target_start_date <= target_end_date),
  CHECK (cursor_end_date >= target_start_date AND cursor_end_date <= target_end_date)
);
CREATE INDEX sync_intents_due_idx
  ON sync_intents(status, priority_class, priority DESC, next_attempt_at,
                  last_served_at, id);
CREATE INDEX sync_intents_job_idx
  ON sync_intents(pipeline_job_id, status, id);
CREATE INDEX sync_intents_instrument_dataset_idx
  ON sync_intents(instrument_id, dataset, priority_class, status);

CREATE TABLE coverage_intervals (
  instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE CASCADE,
  dataset TEXT NOT NULL CHECK (dataset IN (
    'market', 'analysis', 'dividends', 'earnings', 'portfolio_history'
  )),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  source_revision TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (instrument_id, dataset, start_date),
  CHECK (start_date <= end_date)
);
CREATE INDEX coverage_intervals_lookup_idx
  ON coverage_intervals(instrument_id, dataset, end_date, start_date);

CREATE TABLE sync_slices (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  intent_id TEXT NOT NULL REFERENCES sync_intents(id) ON DELETE CASCADE,
  reservation_id TEXT NOT NULL UNIQUE
    REFERENCES resource_reservations(id) ON DELETE RESTRICT,
  requested_start_date TEXT NOT NULL,
  requested_end_date TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'dispatching', 'queued', 'processing', 'complete', 'retry', 'blocked',
    'cancelled'
  )),
  lease_token TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts > 0),
  result_revision TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK (requested_start_date <= requested_end_date)
);
CREATE UNIQUE INDEX sync_slices_one_active_intent_idx
  ON sync_slices(intent_id)
  WHERE state IN ('dispatching', 'queued', 'processing');
CREATE INDEX sync_slices_state_lease_idx
  ON sync_slices(state, lease_until, id);

CREATE TABLE sync_queue_limits (
  lane TEXT PRIMARY KEY CHECK (lane IN ('foreground', 'history')),
  high_water_mark INTEGER NOT NULL CHECK (high_water_mark > 0)
);
INSERT INTO sync_queue_limits(lane, high_water_mark)
VALUES ('foreground', 12), ('history', 4);

CREATE TRIGGER sync_slices_queue_depth_guard
BEFORE INSERT ON sync_slices
WHEN NEW.state IN ('dispatching', 'queued', 'processing')
BEGIN
  SELECT RAISE(ABORT, 'sync_queue_full')
   WHERE (
     SELECT COUNT(*) FROM sync_slices existing
      JOIN sync_intents intent ON intent.id = existing.intent_id
     WHERE existing.state IN ('dispatching', 'queued', 'processing')
       AND CASE WHEN intent.priority_class = 'history'
                THEN 'history' ELSE 'foreground' END = (
         SELECT CASE WHEN candidate.priority_class = 'history'
                     THEN 'history' ELSE 'foreground' END
           FROM sync_intents candidate WHERE candidate.id = NEW.intent_id
       )
   ) >= (
     SELECT high_water_mark FROM sync_queue_limits
      WHERE lane = (
        SELECT CASE WHEN candidate.priority_class = 'history'
                    THEN 'history' ELSE 'foreground' END
          FROM sync_intents candidate WHERE candidate.id = NEW.intent_id
      )
   );
END;

CREATE TRIGGER sync_slices_queue_depth_update_guard
BEFORE UPDATE OF state ON sync_slices
WHEN OLD.state NOT IN ('dispatching', 'queued', 'processing')
 AND NEW.state IN ('dispatching', 'queued', 'processing')
BEGIN
  SELECT RAISE(ABORT, 'sync_queue_full')
   WHERE (
     SELECT COUNT(*) FROM sync_slices existing
      JOIN sync_intents intent ON intent.id = existing.intent_id
     WHERE existing.state IN ('dispatching', 'queued', 'processing')
       AND CASE WHEN intent.priority_class = 'history'
                THEN 'history' ELSE 'foreground' END = (
         SELECT CASE WHEN candidate.priority_class = 'history'
                     THEN 'history' ELSE 'foreground' END
           FROM sync_intents candidate WHERE candidate.id = NEW.intent_id
       )
   ) >= (
     SELECT high_water_mark FROM sync_queue_limits
      WHERE lane = (
        SELECT CASE WHEN candidate.priority_class = 'history'
                    THEN 'history' ELSE 'foreground' END
          FROM sync_intents candidate WHERE candidate.id = NEW.intent_id
      )
   );
END;

CREATE TRIGGER sync_intents_progress_insert
AFTER INSERT ON sync_intents
WHEN NEW.pipeline_job_id IS NOT NULL
BEGIN
  UPDATE pipeline_jobs
     SET sync_intents_pending = sync_intents_pending +
           (NEW.status IN ('pending', 'waiting', 'dispatching', 'active')),
         sync_intents_failed = sync_intents_failed + (NEW.status = 'blocked'),
         updated_at = NEW.updated_at
   WHERE id = NEW.pipeline_job_id AND superseded_at IS NULL;
END;

CREATE TRIGGER sync_intents_progress_update
AFTER UPDATE OF status ON sync_intents
WHEN OLD.status IS NOT NEW.status AND NEW.pipeline_job_id IS NOT NULL
BEGIN
  UPDATE pipeline_jobs
     SET sync_intents_pending = MAX(0, sync_intents_pending
           - (OLD.status IN ('pending', 'waiting', 'dispatching', 'active'))
           + (NEW.status IN ('pending', 'waiting', 'dispatching', 'active'))),
         sync_intents_failed = MAX(0, sync_intents_failed
           - (OLD.status = 'blocked') + (NEW.status = 'blocked')),
         updated_at = NEW.updated_at
   WHERE id = NEW.pipeline_job_id AND superseded_at IS NULL;
END;

CREATE TABLE read_model_refresh_outbox (
  id TEXT PRIMARY KEY,
  deterministic_key TEXT NOT NULL UNIQUE,
  family TEXT NOT NULL CHECK (family IN (
    'accounts', 'portfolio', 'portfolio_history', 'calendar', 'status', 'all'
  )),
  requested_revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'dispatching', 'queued', 'processing', 'complete', 'retry'
  )),
  lease_token TEXT,
  lease_until TEXT,
  next_attempt_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX read_model_refresh_outbox_due_idx
  ON read_model_refresh_outbox(state, next_attempt_at, lease_until, updated_at);

CREATE TABLE read_model_publications (
  cache_key TEXT PRIMARY KEY,
  family TEXT NOT NULL,
  request_url TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Establish the release boundary without touching the legacy per-date rows.
-- Their parent jobs remain queryable for audit, while paused legacy queues can
-- no longer make them operational work.
UPDATE pipeline_jobs
   SET superseded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status IN ('pending', 'planning', 'running');

INSERT INTO pipeline_jobs
  (id, trigger_type, requested_start_date, requested_end_date,
   affected_instruments_json, eligibility_intervals_json, priority, status,
   created_at, updated_at, sync_lane, job_group_id, planning_phase)
SELECT 'repair:0030:current', 'ledger_reconciliation', date('now'), date('now'),
       json_group_array(id),
       json_group_array(json_object(
         'instrumentId', id, 'startDate', date('now'), 'endDate', date('now')
       )),
       100, 'running', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'current',
       'repair:0030', 'market'
  FROM (SELECT DISTINCT instrument_id AS id FROM transactions ORDER BY id)
HAVING COUNT(*) > 0;

INSERT INTO pipeline_jobs
  (id, trigger_type, requested_start_date, requested_end_date,
   affected_instruments_json, eligibility_intervals_json, priority, status,
   created_at, updated_at, sync_lane, job_group_id, planning_phase)
SELECT 'repair:0030:history', 'backfill', MIN(start_date), date('now'),
       json_group_array(id),
       json_group_array(json_object(
         'instrumentId', id, 'startDate', start_date, 'endDate', date('now')
       )),
       10, 'running', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'history',
       'repair:0030', 'market'
  FROM (
    SELECT instrument_id AS id, MIN(trade_date) AS start_date
      FROM transactions GROUP BY instrument_id ORDER BY instrument_id
  )
HAVING COUNT(*) > 0;

INSERT INTO sync_intents
  (id, deterministic_key, pipeline_job_id, instrument_id, dataset,
   priority_class, target_start_date, target_end_date, cursor_end_date,
   status, priority, attempt_count, max_attempts, created_at, updated_at)
SELECT 'repair:0030:current:' || instrument_id,
       'repair:0030:current:' || instrument_id,
       'repair:0030:current', instrument_id, 'market', 'current',
       date('now'), date('now'), date('now'), 'pending', 100, 0, 5,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM (SELECT DISTINCT instrument_id FROM transactions ORDER BY instrument_id)
 WHERE EXISTS (SELECT 1 FROM pipeline_jobs WHERE id = 'repair:0030:current');

INSERT INTO sync_intents
  (id, deterministic_key, pipeline_job_id, instrument_id, dataset,
   priority_class, target_start_date, target_end_date, cursor_end_date,
   status, priority, attempt_count, max_attempts, created_at, updated_at)
SELECT 'repair:0030:history:' || instrument_id,
       'repair:0030:history:' || instrument_id,
       'repair:0030:history', instrument_id, 'market', 'history',
       MIN(trade_date), date('now'), date('now'), 'pending', 10, 0, 5,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM transactions
 WHERE EXISTS (SELECT 1 FROM pipeline_jobs WHERE id = 'repair:0030:history')
 GROUP BY instrument_id;
