-- Existing planners may have consumed their small retry budget while remote
-- D1 page materialization was still issuing one round trip per candidate.
-- Give active resumable planners enough recovery attempts for the batched
-- implementation to finish them after this deployment.
UPDATE work_items
   SET max_attempts = 10
 WHERE scope = 'job_planning'
   AND state IN ('pending', 'processing')
   AND max_attempts < 10;
