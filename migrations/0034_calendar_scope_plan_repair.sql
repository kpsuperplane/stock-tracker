-- The join form caused SQLite to scan the JSON account scope once per
-- complete analysis. The application now uses a membership semijoin, so the
-- single pre-fix measurement must not inflate the adaptive envelope.
DELETE FROM resource_operation_observations
 WHERE operation_type = 'read_model_refresh'
   AND resource_type IN ('d1_rows_read', 'd1_rows_written');
