ALTER TABLE pipeline_jobs
  ADD COLUMN backfill_reprocess_existing INTEGER NOT NULL DEFAULT 0
    CHECK (backfill_reprocess_existing IN (0, 1));

ALTER TABLE pipeline_jobs
  ADD COLUMN planner_cursor TEXT;

ALTER TABLE pipeline_jobs
  ADD COLUMN planner_dividend_cursor TEXT;

ALTER TABLE pipeline_jobs
  ADD COLUMN planner_lease_until TEXT;

ALTER TABLE pipeline_jobs
  ADD COLUMN backfill_forced_refresh_generation INTEGER
    CHECK (backfill_forced_refresh_generation IS NULL
      OR backfill_forced_refresh_generation >= 1);

CREATE TABLE pipeline_job_dividend_recalculations (
  pipeline_job_id TEXT NOT NULL REFERENCES pipeline_jobs(id) ON DELETE CASCADE,
  instrument_id TEXT NOT NULL REFERENCES instruments(id) ON DELETE RESTRICT,
  ex_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (pipeline_job_id, instrument_id, ex_date)
);

CREATE INDEX pipeline_job_dividend_recalculations_date_idx
  ON pipeline_job_dividend_recalculations(pipeline_job_id, ex_date, instrument_id);
