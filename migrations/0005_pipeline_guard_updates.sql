CREATE TRIGGER work_items_planning_owner_update_guard
BEFORE UPDATE OF pipeline_job_id, scope ON work_items
WHEN (
  OLD.scope = 'job_planning'
  AND (
    NEW.scope <> 'job_planning'
    OR NEW.pipeline_job_id IS NULL
    OR EXISTS (
      SELECT 1 FROM job_work_items
      WHERE work_item_id = OLD.id
        AND pipeline_job_id IS NOT NEW.pipeline_job_id
    )
  )
)
OR (
  NEW.scope = 'job_planning'
  AND (
    NEW.pipeline_job_id IS NULL
    OR EXISTS (
      SELECT 1 FROM job_work_items
      WHERE work_item_id = OLD.id
        AND pipeline_job_id IS NOT NEW.pipeline_job_id
    )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'job_planning_owner_mismatch');
END;

CREATE TRIGGER dispatch_batch_items_compatibility_update_guard
BEFORE UPDATE OF dispatch_batch_id, work_item_id ON dispatch_batch_items
WHEN NOT EXISTS (
  SELECT 1
  FROM dispatch_batches AS batch
  JOIN work_items AS work ON work.id = NEW.work_item_id
  WHERE batch.id = NEW.dispatch_batch_id
    AND batch.state = 'dispatching'
    AND work.scope = 'global_fact'
    AND work.state = 'dispatching'
    AND work.work_type = batch.work_type
    AND work.instrument_id = batch.instrument_id
    AND work.effective_date BETWEEN batch.requested_start_date AND batch.requested_end_date
)
BEGIN
  SELECT RAISE(ABORT, 'dispatch_batch_incompatible_work');
END;
