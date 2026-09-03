-- The legacy current-lane planner also inspected historical first-buy dates.
-- Remove those leaked links from the deterministic foreground repair; the
-- history sibling remains the sole owner of historical reconstruction.

DELETE FROM job_work_items
 WHERE pipeline_job_id = 'repair:0026:current'
   AND work_item_id IN (
     SELECT work.id
       FROM work_items work
       JOIN pipeline_jobs job ON job.id = 'repair:0026:current'
      WHERE work.scope = 'global_fact'
        AND work.effective_date IS NOT NULL
        AND (
          work.effective_date < job.requested_start_date
          OR work.effective_date > job.requested_end_date
        )
   );

UPDATE pipeline_jobs
   SET work_total = (
         SELECT COUNT(*)
           FROM job_work_items link
           JOIN work_items work ON work.id = link.work_item_id
          WHERE link.pipeline_job_id = pipeline_jobs.id
            AND work.scope = 'global_fact'
       ),
       work_skipped = 0,
       work_failed = (
         SELECT COUNT(*)
           FROM job_work_items link
           JOIN work_items work ON work.id = link.work_item_id
          WHERE link.pipeline_job_id = pipeline_jobs.id
            AND work.scope = 'global_fact'
            AND (link.outcome = 'failed' OR work.state = 'terminal')
       ),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE id = 'repair:0026:current';
