-- Queue producer exhaustion terminalized foreground work before a provider
-- request began. Preserve the failed scheduled job for audit, create one
-- deterministic repair job, and return only transport-failed current work to
-- the durable pending state.

INSERT OR IGNORE INTO pipeline_jobs
  (id, trigger_type, requested_start_date, requested_end_date,
   affected_instruments_json, eligibility_intervals_json, priority, status,
   created_at, updated_at, sync_lane, job_group_id, planning_phase)
SELECT 'repair:0026:current', 'ledger_reconciliation',
       (
         SELECT MIN(work.effective_date)
           FROM work_items work
           JOIN job_work_items link ON link.work_item_id = work.id
           JOIN pipeline_jobs job ON job.id = link.pipeline_job_id
          WHERE job.sync_lane = 'current'
            AND work.state = 'terminal'
            AND work.terminal_error_code = 'dispatch_attempts_exhausted'
       ),
       (
         SELECT MAX(work.effective_date)
           FROM work_items work
           JOIN job_work_items link ON link.work_item_id = work.id
           JOIN pipeline_jobs job ON job.id = link.pipeline_job_id
          WHERE job.sync_lane = 'current'
            AND work.state = 'terminal'
            AND work.terminal_error_code = 'dispatch_attempts_exhausted'
       ),
       (
         SELECT json_group_array(instrument_id)
           FROM (
             SELECT DISTINCT work.instrument_id
               FROM work_items work
               JOIN job_work_items link ON link.work_item_id = work.id
               JOIN pipeline_jobs job ON job.id = link.pipeline_job_id
              WHERE job.sync_lane = 'current'
                AND work.state = 'terminal'
                AND work.terminal_error_code = 'dispatch_attempts_exhausted'
                AND work.instrument_id IS NOT NULL
              ORDER BY work.instrument_id
           )
       ),
       (
         SELECT json_group_array(json_object(
           'instrumentId', instrument_id,
           'startDate', start_date,
           'endDate', end_date
         ))
           FROM (
             SELECT work.instrument_id,
                    MIN(work.effective_date) AS start_date,
                    MAX(work.effective_date) AS end_date
               FROM work_items work
               JOIN job_work_items link ON link.work_item_id = work.id
               JOIN pipeline_jobs job ON job.id = link.pipeline_job_id
              WHERE job.sync_lane = 'current'
                AND work.state = 'terminal'
                AND work.terminal_error_code = 'dispatch_attempts_exhausted'
                AND work.instrument_id IS NOT NULL
                AND work.effective_date IS NOT NULL
              GROUP BY work.instrument_id
              ORDER BY work.instrument_id
           )
       ),
       400, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'current',
       'repair:0026', 'market'
 WHERE EXISTS (
   SELECT 1
     FROM work_items work
     JOIN job_work_items link ON link.work_item_id = work.id
     JOIN pipeline_jobs job ON job.id = link.pipeline_job_id
    WHERE job.sync_lane = 'current'
      AND work.state = 'terminal'
      AND work.terminal_error_code = 'dispatch_attempts_exhausted'
 );

INSERT OR IGNORE INTO work_items
  (id, scope, pipeline_job_id, work_type, deterministic_key, state,
   priority, attempt_count, max_attempts, available_at, created_at, updated_at)
SELECT id || ':planner', 'job_planning', id, 'ledger_reconciliation_plan',
       'job:' || id || ':ledger_reconciliation_plan', 'pending', priority,
       0, 10, created_at, created_at, updated_at
  FROM pipeline_jobs
 WHERE id = 'repair:0026:current';

INSERT OR IGNORE INTO job_work_items
  (pipeline_job_id, work_item_id, relationship, outcome, created_at, updated_at)
SELECT id, id || ':planner', 'required', 'pending', created_at, updated_at
  FROM pipeline_jobs
 WHERE id = 'repair:0026:current';

UPDATE work_items
   SET state = 'pending', attempt_count = 0,
       dispatch_lease_until = NULL, processing_lease_until = NULL,
       result_revision = NULL, terminal_error_code = NULL,
       terminal_error_message = NULL, available_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       completed_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE scope = 'global_fact'
   AND state = 'terminal'
   AND terminal_error_code = 'dispatch_attempts_exhausted'
   AND EXISTS (
     SELECT 1
       FROM job_work_items link
       JOIN pipeline_jobs job ON job.id = link.pipeline_job_id
      WHERE link.work_item_id = work_items.id
        AND job.sync_lane = 'current'
   );

-- Re-run the small set of incomplete financial histories through the SEC
-- periodic-filing fallback shipped with this migration. Alpha remains the
-- fallback only for issuers outside SEC coverage.
UPDATE earnings_history_coverage
   SET status = 'pending', attempt_count = 0,
       next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       lease_until = NULL, last_error_code = NULL, last_error_message = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status = 'retry';
