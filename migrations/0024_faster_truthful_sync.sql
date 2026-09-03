-- Truthful operational states, foreground/background reconciliation lanes,
-- and the metadata required for durable queue continuations.

ALTER TABLE pipeline_jobs
  ADD COLUMN sync_lane TEXT NOT NULL DEFAULT 'current'
    CHECK (sync_lane IN ('current', 'history'));

ALTER TABLE pipeline_jobs
  ADD COLUMN job_group_id TEXT;

ALTER TABLE pipeline_jobs
  ADD COLUMN planning_phase TEXT NOT NULL DEFAULT 'market'
    CHECK (planning_phase IN ('market', 'analysis', 'dividends', 'complete'));

UPDATE pipeline_jobs
   SET sync_lane = 'history'
 WHERE trigger_type = 'backfill';

CREATE INDEX pipeline_jobs_lane_status_idx
  ON pipeline_jobs(sync_lane, status, priority DESC, created_at);
CREATE INDEX pipeline_jobs_group_idx
  ON pipeline_jobs(job_group_id, sync_lane, created_at);

CREATE TABLE dispatch_provider_reservations (
  dispatch_batch_id TEXT PRIMARY KEY,
  reservation_day TEXT NOT NULL,
  budget_kind TEXT NOT NULL CHECK (budget_kind IN (
    'foreground_market', 'history_market', 'analysis'
  )),
  units INTEGER NOT NULL DEFAULT 1 CHECK (units > 0),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX dispatch_provider_reservations_day_kind_idx
  ON dispatch_provider_reservations(reservation_day, budget_kind, expires_at);

ALTER TABLE import_batches
  ADD COLUMN history_pipeline_job_id TEXT
    REFERENCES pipeline_jobs(id) ON DELETE SET NULL;

CREATE TABLE dividend_refresh_state_next (
  instrument_id TEXT PRIMARY KEY REFERENCES instruments(id) ON DELETE CASCADE,
  requested_start_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'retry', 'dispatching', 'queued', 'in_progress', 'current',
    'blocked'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TEXT NOT NULL,
  lease_until TEXT,
  dispatch_token TEXT,
  provider TEXT,
  last_attempted_at TEXT,
  completed_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO dividend_refresh_state_next
  (instrument_id, requested_start_date, status, attempt_count,
   next_attempt_at, lease_until, dispatch_token, provider, last_attempted_at,
   completed_at, last_error_code, last_error_message, created_at, updated_at)
SELECT instrument_id, requested_start_date,
       CASE
         WHEN status = 'in_progress' THEN 'retry'
         WHEN status = 'retry' AND last_error_code IN
           ('provider_daily_limit', 'provider_entitlement') THEN 'pending'
         ELSE status
       END,
       CASE
         WHEN status = 'retry' AND last_error_code IN
           ('provider_daily_limit', 'provider_entitlement') THEN 0
         ELSE attempt_count
       END,
       CASE
         WHEN status = 'in_progress'
           OR (status = 'retry' AND last_error_code IN
             ('provider_daily_limit', 'provider_entitlement'))
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ELSE next_attempt_at
       END,
       NULL, NULL, NULL, last_attempted_at, completed_at,
       CASE
         WHEN status = 'retry' AND last_error_code IN
           ('provider_daily_limit', 'provider_entitlement') THEN NULL
         ELSE last_error_code
       END,
       CASE
         WHEN status = 'retry' AND last_error_code IN
           ('provider_daily_limit', 'provider_entitlement') THEN NULL
         ELSE last_error_message
       END,
       created_at,
       CASE
         WHEN status = 'in_progress'
           OR (status = 'retry' AND last_error_code IN
             ('provider_daily_limit', 'provider_entitlement'))
         THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ELSE updated_at
       END
  FROM dividend_refresh_state;

DROP TABLE dividend_refresh_state;
ALTER TABLE dividend_refresh_state_next RENAME TO dividend_refresh_state;
CREATE INDEX dividend_refresh_state_due_idx
  ON dividend_refresh_state(status, next_attempt_at, lease_until, updated_at);

ALTER TABLE alpha_vantage_daily_usage
  ADD COLUMN dividend_fallback_disabled INTEGER NOT NULL DEFAULT 0
    CHECK (dividend_fallback_disabled IN (0, 1));
ALTER TABLE alpha_vantage_daily_usage
  ADD COLUMN dividend_fallback_error TEXT;

-- Bootstrap current coverage immediately and leave old terminal jobs intact.
INSERT INTO pipeline_jobs
  (id, trigger_type, requested_start_date, requested_end_date,
   affected_instruments_json, eligibility_intervals_json, priority, status,
   created_at, updated_at, sync_lane, job_group_id, planning_phase)
SELECT 'repair:0024:current', 'ledger_reconciliation', date('now'), date('now'),
       (SELECT json_group_array(id) FROM (
          SELECT DISTINCT i.id FROM instruments i JOIN transactions tx
            ON tx.instrument_id = i.id
           WHERE i.security_type = 'stock' ORDER BY i.id
       )),
       (SELECT json_group_array(json_object(
          'instrumentId', id, 'startDate', date('now'), 'endDate', date('now')
        )) FROM (
          SELECT DISTINCT i.id FROM instruments i JOIN transactions tx
            ON tx.instrument_id = i.id
           WHERE i.security_type = 'stock' ORDER BY i.id
       )),
       100, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'current',
       'repair:0024', 'market'
 WHERE EXISTS (
   SELECT 1 FROM transactions tx JOIN instruments i
     ON i.id = tx.instrument_id WHERE i.security_type = 'stock'
 );

INSERT INTO pipeline_jobs
  (id, trigger_type, requested_start_date, requested_end_date,
   affected_instruments_json, eligibility_intervals_json, priority, status,
   created_at, updated_at, sync_lane, job_group_id, planning_phase)
SELECT 'repair:0024:history', 'backfill',
       (SELECT MIN(trade_date) FROM transactions), date('now'),
       (SELECT json_group_array(id) FROM (
          SELECT DISTINCT i.id FROM instruments i JOIN transactions tx
            ON tx.instrument_id = i.id
           WHERE i.security_type = 'stock' ORDER BY i.id
       )),
       '[]', 20, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'history',
       'repair:0024', 'market'
 WHERE EXISTS (
   SELECT 1 FROM transactions tx JOIN instruments i
     ON i.id = tx.instrument_id WHERE i.security_type = 'stock'
 );

INSERT INTO work_items
  (id, scope, pipeline_job_id, work_type, deterministic_key, state,
   priority, attempt_count, max_attempts, created_at, updated_at)
SELECT id || ':planner', 'job_planning', id, 'ledger_reconciliation_plan',
       'job:' || id || ':ledger_reconciliation_plan', 'pending', priority,
       0, 10, created_at, updated_at
  FROM pipeline_jobs WHERE id IN ('repair:0024:current', 'repair:0024:history');

INSERT INTO job_work_items
  (pipeline_job_id, work_item_id, relationship, outcome, created_at)
SELECT id, id || ':planner', 'required', 'pending', created_at
  FROM pipeline_jobs WHERE id IN ('repair:0024:current', 'repair:0024:history');
