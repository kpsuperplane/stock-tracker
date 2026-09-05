-- A stale snapshot should refresh only itself. Family-wide refreshes are kept
-- for explicit mutation publication, where consumers select one recent
-- canonical target per family and stale variants refresh on demand.

ALTER TABLE read_model_refresh_outbox ADD COLUMN target_cache_key TEXT;
CREATE INDEX read_model_refresh_outbox_target_idx
  ON read_model_refresh_outbox(target_cache_key, state, updated_at);

UPDATE read_model_refresh_outbox
   SET deterministic_key = deterministic_key || ':canonical'
 WHERE deterministic_key = 'read-model-refresh:' || family;

-- The previous query shape is no longer representative. Keep its measured
-- daily charge, but discard it from the seven-day envelope estimator so the
-- optimized query can establish a new p99 immediately.
DELETE FROM resource_operation_observations
 WHERE operation_type = 'read_model_refresh'
   AND resource_type IN ('d1_rows_read', 'd1_rows_written');
