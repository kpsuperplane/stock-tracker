-- SEC histories that produced no report events were previously marked current.
-- Re-run them through the foreign-filer and cross-list support shipped with
-- this migration. Existing events remain readable until the refreshed source
-- supersedes them.
UPDATE earnings_history_coverage
   SET status = 'pending', attempt_count = 0,
       next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       lease_until = NULL, last_error_code = NULL, last_error_message = NULL,
       completed_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status = 'retry'
    OR NOT EXISTS (
      SELECT 1
        FROM earnings_events event
       WHERE event.instrument_id = earnings_history_coverage.instrument_id
         AND event.status = 'active'
    );

-- These two dates were one-off US exchange closures. Preserve their terminal
-- work rows for audit, but remove them from the consolidated history repair
-- and count them as calendar skips instead of provider failures.
UPDATE pipeline_jobs
   SET work_skipped = work_skipped + (
         SELECT COUNT(*)
           FROM job_work_items link
           JOIN work_items work ON work.id = link.work_item_id
          WHERE link.pipeline_job_id = pipeline_jobs.id
            AND work.state = 'terminal'
            AND work.terminal_error_code = 'market_bar_missing'
            AND work.effective_date IN ('2018-12-05', '2025-01-09')
       )
 WHERE id = 'repair:0024:history';

DELETE FROM job_work_items
 WHERE pipeline_job_id = 'repair:0024:history'
   AND work_item_id IN (
     SELECT id
       FROM work_items
      WHERE state = 'terminal'
        AND terminal_error_code = 'market_bar_missing'
        AND effective_date IN ('2018-12-05', '2025-01-09')
   );

-- The remaining failures arrived portfolio-wide on otherwise valid trading
-- dates. They are provider snapshot incidents, not permanent symbol errors.
-- Reset only those known clusters and give the new progressive retry policy
-- enough attempts to span a transient upstream incident.
UPDATE work_items
   SET state = 'pending', attempt_count = 0, max_attempts = 5,
       dispatch_lease_until = NULL, processing_lease_until = NULL,
       result_revision = NULL, terminal_error_code = NULL,
       terminal_error_message = NULL,
       available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       completed_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE scope = 'global_fact' AND state = 'terminal'
   AND (
     (terminal_error_code = 'invalid_price'
       AND effective_date IN ('2026-07-14', '2026-07-27'))
     OR (terminal_error_code = 'market_bar_missing'
       AND effective_date = '2026-07-29')
   )
   AND EXISTS (
     SELECT 1
       FROM job_work_items link
      WHERE link.pipeline_job_id = 'repair:0024:history'
        AND link.work_item_id = work_items.id
   );

UPDATE job_work_items
   SET outcome = 'pending', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE pipeline_job_id = 'repair:0024:history'
   AND work_item_id IN (
     SELECT id
       FROM work_items
      WHERE state = 'pending'
        AND effective_date IN ('2026-07-14', '2026-07-27', '2026-07-29')
   );

UPDATE work_items
   SET state = 'pending', available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       dispatch_lease_until = NULL, processing_lease_until = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE pipeline_job_id = 'repair:0024:history'
   AND scope = 'job_planning';

UPDATE pipeline_jobs
   SET status = 'planning', planner_lease_until = NULL,
       work_total = (
         SELECT COUNT(*)
           FROM job_work_items link
           JOIN work_items work ON work.id = link.work_item_id
          WHERE link.pipeline_job_id = pipeline_jobs.id
            AND work.scope = 'global_fact'
       ) + work_skipped,
       work_fetched = (
         SELECT COUNT(*)
           FROM job_work_items link
           JOIN work_items work ON work.id = link.work_item_id
          WHERE link.pipeline_job_id = pipeline_jobs.id
            AND work.scope = 'global_fact' AND work.work_type = 'market_fact'
            AND work.state = 'complete' AND link.outcome = 'processed'
       ),
       work_analyzed = (
         SELECT COUNT(*)
           FROM job_work_items link
           JOIN work_items work ON work.id = link.work_item_id
          WHERE link.pipeline_job_id = pipeline_jobs.id
            AND work.scope = 'global_fact' AND work.work_type = 'analysis'
            AND work.state = 'complete' AND link.outcome = 'processed'
       ),
       work_processed = (
         SELECT COUNT(*)
           FROM job_work_items link
           JOIN work_items work ON work.id = link.work_item_id
          WHERE link.pipeline_job_id = pipeline_jobs.id
            AND work.scope = 'global_fact' AND work.state = 'complete'
       ) + work_skipped,
       work_failed = (
         SELECT COUNT(*)
           FROM job_work_items link
           JOIN work_items work ON work.id = link.work_item_id
          WHERE link.pipeline_job_id = pipeline_jobs.id
            AND work.scope = 'global_fact'
            AND (work.state = 'terminal' OR link.outcome = 'failed')
       ),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = 'repair:0024:history';
