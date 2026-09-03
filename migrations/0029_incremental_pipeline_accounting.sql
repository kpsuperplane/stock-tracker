-- Keep pipeline bookkeeping proportional to changed work.  The previous
-- recovery path repeatedly joined every historical job link, which exhausted
-- D1's free daily row-read allowance once strict enforcement began.

ALTER TABLE pipeline_jobs
  ADD COLUMN market_work_pending INTEGER NOT NULL DEFAULT 0
    CHECK (market_work_pending >= 0);

ALTER TABLE pipeline_jobs
  ADD COLUMN analysis_work_pending INTEGER NOT NULL DEFAULT 0
    CHECK (analysis_work_pending >= 0);

ALTER TABLE dispatch_batches ADD COLUMN settled_at TEXT;

CREATE TABLE pipeline_planning_pages (
  pipeline_job_id TEXT NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
  phase TEXT NOT NULL,
  cursor_start TEXT NOT NULL,
  cursor_end TEXT,
  skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (pipeline_job_id, phase, cursor_start)
);

CREATE INDEX job_work_items_job_outcome_work_idx
  ON job_work_items(pipeline_job_id, outcome, work_item_id);
CREATE INDEX job_work_items_pending_work_idx
  ON job_work_items(work_item_id, pipeline_job_id)
  WHERE outcome = 'pending';
CREATE INDEX work_items_expired_dispatch_idx
  ON work_items(state, dispatch_lease_until, id)
  WHERE scope = 'global_fact';
CREATE INDEX work_items_state_completed_idx
  ON work_items(state, completed_at, id);
CREATE INDEX work_items_explicit_retention_idx
  ON work_items(retention_until, id)
  WHERE retention_until IS NOT NULL;
CREATE INDEX dispatch_batches_queued_recovery_idx
  ON dispatch_batches(state, updated_at, created_at, id);
CREATE INDEX dispatch_batches_dispatch_lease_idx
  ON dispatch_batches(state, dispatch_lease_until, id);
CREATE INDEX dispatch_batches_processing_lease_idx
  ON dispatch_batches(state, processing_lease_until, id);
CREATE INDEX dispatch_batches_unsettled_idx
  ON dispatch_batches(settled_at, completed_at, id)
  WHERE state IN ('complete', 'terminal');
CREATE INDEX dispatch_batches_state_completed_idx
  ON dispatch_batches(state, completed_at, id);
CREATE INDEX dispatch_batches_explicit_retention_idx
  ON dispatch_batches(retention_until, id)
  WHERE retention_until IS NOT NULL;
CREATE INDEX dispatch_batches_pending_dlq_idx
  ON dispatch_batches(dlq_state, dlq_lease_until, id)
  WHERE state = 'terminal';
CREATE INDEX dispatch_daily_reservations_expiry_idx
  ON dispatch_daily_reservations(expires_at, dispatch_batch_id);
CREATE INDEX dispatch_provider_reservations_expiry_idx
  ON dispatch_provider_reservations(expires_at, dispatch_batch_id);
CREATE INDEX pipeline_jobs_completed_retention_idx
  ON pipeline_jobs(status, completed_at, id);
CREATE INDEX legacy_dual_write_repairs_resolved_idx
  ON legacy_dual_write_repairs(state, updated_at, id);

-- The previous foreground planner stored numeric offsets into a candidate
-- list that shrank as facts arrived. Restart active foreground pages from the
-- frozen job domain; deterministic work keys make this replay idempotent.
UPDATE pipeline_jobs
   SET planner_cursor = CASE
         WHEN planner_cursor IS NOT NULL
          AND CASE WHEN json_valid(planner_cursor) = 0 THEN 1
                   ELSE json_type(planner_cursor) <> 'object' END
         THEN NULL ELSE planner_cursor END,
       planner_dividend_cursor = CASE
         WHEN planner_dividend_cursor IS NOT NULL
          AND CASE WHEN json_valid(planner_dividend_cursor) = 0 THEN 1
                   ELSE json_type(planner_dividend_cursor) <> 'object' END
         THEN NULL ELSE planner_dividend_cursor END
 WHERE sync_lane = 'current'
   AND status IN ('pending', 'planning', 'running');

-- Repair any link transition that completed before its queue delivery could
-- perform bookkeeping, then rebuild the counters once.  Runtime transitions
-- below are incremental after this migration.
UPDATE job_work_items
   SET outcome = CASE work.state
       WHEN 'complete' THEN 'processed'
       WHEN 'terminal' THEN 'failed'
       ELSE job_work_items.outcome
     END,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM work_items AS work
 WHERE outcome = 'pending'
   AND work.id = job_work_items.work_item_id
   AND work.scope = 'global_fact'
   AND work.state IN ('complete', 'terminal');

-- Aggregate the historical links once. Eight correlated scans per job made
-- this migration capable of consuming the same quota that it is meant to
-- protect, especially for the consolidated history repair job.
CREATE TABLE migration_0029_job_progress (
  pipeline_job_id TEXT PRIMARY KEY,
  linked_total INTEGER NOT NULL,
  linked_reused INTEGER NOT NULL,
  linked_fetched INTEGER NOT NULL,
  linked_analyzed INTEGER NOT NULL,
  linked_processed INTEGER NOT NULL,
  linked_failed INTEGER NOT NULL,
  market_pending INTEGER NOT NULL,
  analysis_pending INTEGER NOT NULL
);

INSERT INTO migration_0029_job_progress
  (pipeline_job_id, linked_total, linked_reused, linked_fetched,
   linked_analyzed, linked_processed, linked_failed, market_pending,
   analysis_pending)
SELECT link.pipeline_job_id,
       COUNT(*),
       SUM(link.outcome = 'reused'),
       SUM(link.outcome = 'processed' AND work.work_type = 'market_fact'),
       SUM(link.outcome = 'processed' AND work.work_type = 'analysis'),
       SUM(link.outcome IN ('reused', 'skipped', 'processed')),
       SUM(link.outcome = 'failed'),
       SUM(link.outcome = 'pending' AND work.work_type = 'market_fact'),
       SUM(link.outcome = 'pending' AND work.work_type = 'analysis')
  FROM job_work_items AS link
  JOIN work_items AS work ON work.id = link.work_item_id
 WHERE work.scope = 'global_fact'
 GROUP BY link.pipeline_job_id;

UPDATE pipeline_jobs
   SET work_total = work_skipped + COALESCE(progress.linked_total, 0),
       work_reused = COALESCE(progress.linked_reused, 0),
       work_fetched = COALESCE(progress.linked_fetched, 0),
       work_analyzed = COALESCE(progress.linked_analyzed, 0),
       work_processed = work_skipped +
         COALESCE(progress.linked_processed, 0),
       work_failed = COALESCE(progress.linked_failed, 0),
       market_work_pending = COALESCE(progress.market_pending, 0),
       analysis_work_pending = COALESCE(progress.analysis_pending, 0)
  FROM (
    SELECT job.id,
           aggregate.linked_total,
           aggregate.linked_reused,
           aggregate.linked_fetched,
           aggregate.linked_analyzed,
           aggregate.linked_processed,
           aggregate.linked_failed,
           aggregate.market_pending,
           aggregate.analysis_pending
      FROM pipeline_jobs AS job
      LEFT JOIN migration_0029_job_progress AS aggregate
        ON aggregate.pipeline_job_id = job.id
  ) AS progress
 WHERE pipeline_jobs.id = progress.id;

DROP TABLE migration_0029_job_progress;

UPDATE dispatch_batches
   SET settled_at = COALESCE(completed_at, updated_at)
 WHERE state IN ('complete', 'terminal')
   AND NOT EXISTS (
     SELECT 1
       FROM dispatch_batch_items item
       JOIN work_items work ON work.id = item.work_item_id
      WHERE item.dispatch_batch_id = dispatch_batches.id
        AND work.state NOT IN ('complete', 'terminal')
   )
   AND NOT EXISTS (
     SELECT 1
       FROM dispatch_batch_items item
       JOIN job_work_items link ON link.work_item_id = item.work_item_id
      WHERE item.dispatch_batch_id = dispatch_batches.id
        AND link.outcome = 'pending'
   );

CREATE TRIGGER job_work_items_progress_insert
AFTER INSERT ON job_work_items
BEGIN
  UPDATE pipeline_jobs
     SET work_total = work_total + 1,
         work_reused = work_reused + (NEW.outcome = 'reused'),
         work_skipped = work_skipped + (NEW.outcome = 'skipped'),
         work_fetched = work_fetched +
           (NEW.outcome = 'processed' AND work.work_type = 'market_fact'),
         work_analyzed = work_analyzed +
           (NEW.outcome = 'processed' AND work.work_type = 'analysis'),
         work_processed = work_processed +
           (NEW.outcome IN ('reused', 'skipped', 'processed')),
         work_failed = work_failed + (NEW.outcome = 'failed'),
         market_work_pending = market_work_pending +
           (NEW.outcome = 'pending' AND work.work_type = 'market_fact'),
         analysis_work_pending = analysis_work_pending +
           (NEW.outcome = 'pending' AND work.work_type = 'analysis'),
         updated_at = COALESCE(NEW.updated_at, NEW.created_at)
    FROM work_items AS work
   WHERE pipeline_jobs.id = NEW.pipeline_job_id
     AND work.id = NEW.work_item_id AND work.scope = 'global_fact'
     AND pipeline_jobs.status IN ('pending', 'planning', 'running');
END;

CREATE TRIGGER job_work_items_progress_update
AFTER UPDATE OF outcome ON job_work_items
WHEN OLD.outcome IS NOT NEW.outcome
BEGIN
  UPDATE pipeline_jobs
     SET work_reused = MAX(0, work_reused
           - (OLD.outcome = 'reused') + (NEW.outcome = 'reused')),
         work_skipped = MAX(0, work_skipped
           - (OLD.outcome = 'skipped') + (NEW.outcome = 'skipped')),
         work_fetched = MAX(0, work_fetched
           - (OLD.outcome = 'processed' AND work.work_type = 'market_fact')
           + (NEW.outcome = 'processed' AND work.work_type = 'market_fact')),
         work_analyzed = MAX(0, work_analyzed
           - (OLD.outcome = 'processed' AND work.work_type = 'analysis')
           + (NEW.outcome = 'processed' AND work.work_type = 'analysis')),
         work_processed = MAX(0, work_processed
           - (OLD.outcome IN ('reused', 'skipped', 'processed'))
           + (NEW.outcome IN ('reused', 'skipped', 'processed'))),
         work_failed = MAX(0, work_failed
           - (OLD.outcome = 'failed') + (NEW.outcome = 'failed')),
         market_work_pending = MAX(0, market_work_pending
           - (OLD.outcome = 'pending' AND work.work_type = 'market_fact')
           + (NEW.outcome = 'pending' AND work.work_type = 'market_fact')),
         analysis_work_pending = MAX(0, analysis_work_pending
           - (OLD.outcome = 'pending' AND work.work_type = 'analysis')
           + (NEW.outcome = 'pending' AND work.work_type = 'analysis')),
         updated_at = COALESCE(NEW.updated_at, pipeline_jobs.updated_at)
    FROM work_items AS work
   WHERE pipeline_jobs.id = NEW.pipeline_job_id
     AND work.id = NEW.work_item_id AND work.scope = 'global_fact'
     AND pipeline_jobs.status IN ('pending', 'planning', 'running');
END;

CREATE TRIGGER job_work_items_progress_delete
AFTER DELETE ON job_work_items
BEGIN
  UPDATE pipeline_jobs
     SET work_total = MAX(0, work_total - 1),
         work_reused = MAX(0, work_reused - (OLD.outcome = 'reused')),
         work_skipped = MAX(0, work_skipped - (OLD.outcome = 'skipped')),
         work_fetched = MAX(0, work_fetched
           - (OLD.outcome = 'processed' AND work.work_type = 'market_fact')),
         work_analyzed = MAX(0, work_analyzed
           - (OLD.outcome = 'processed' AND work.work_type = 'analysis')),
         work_processed = MAX(0, work_processed
           - (OLD.outcome IN ('reused', 'skipped', 'processed'))),
         work_failed = MAX(0, work_failed - (OLD.outcome = 'failed')),
         market_work_pending = MAX(0, market_work_pending
           - (OLD.outcome = 'pending' AND work.work_type = 'market_fact')),
         analysis_work_pending = MAX(0, analysis_work_pending
           - (OLD.outcome = 'pending' AND work.work_type = 'analysis'))
    FROM work_items AS work
   WHERE pipeline_jobs.id = OLD.pipeline_job_id
     AND work.id = OLD.work_item_id AND work.scope = 'global_fact'
     AND pipeline_jobs.status IN ('pending', 'planning', 'running');
END;

CREATE TRIGGER pipeline_planning_pages_progress_insert
AFTER INSERT ON pipeline_planning_pages
WHEN NEW.skipped_count > 0
BEGIN
  UPDATE pipeline_jobs
     SET work_total = work_total + NEW.skipped_count,
         work_skipped = work_skipped + NEW.skipped_count,
         work_processed = work_processed + NEW.skipped_count,
         updated_at = NEW.created_at
   WHERE id = NEW.pipeline_job_id
     AND status IN ('pending', 'planning', 'running');
END;

PRAGMA optimize;
