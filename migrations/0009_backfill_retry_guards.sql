-- A forced-refresh generation is a durable reservation on the pipeline job,
-- not a value derived only from currently materialized work.  The unique
-- index makes the reservation race-safe when two no-work/concurrent
-- reprocess requests select the same next candidate.
CREATE UNIQUE INDEX pipeline_jobs_backfill_generation_unique_idx
  ON pipeline_jobs(backfill_forced_refresh_generation)
  WHERE backfill_forced_refresh_generation IS NOT NULL;

-- A manual retry is a new dispatch attempt.  Remove links owned by old
-- terminal batches in the same state transition so dispatcher recovery can
-- never terminalize the reset work item again.
CREATE TRIGGER work_items_retry_detach_terminal_batches
AFTER UPDATE OF state ON work_items
WHEN OLD.state = 'terminal' AND NEW.state = 'pending'
BEGIN
  DELETE FROM dispatch_batch_items
   WHERE work_item_id = NEW.id
     AND dispatch_batch_id IN (
       SELECT id FROM dispatch_batches WHERE state = 'terminal'
     );
END;
