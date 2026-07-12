-- 0012 was an additive compatibility bridge. New ledger entries now
-- materialize identities on demand, so remove only still-unreferenced rows
-- that the eager bridge created. Any row already used by normalized work is
-- retained by the foreign-key guards below.
DELETE FROM instruments
 WHERE id IN (SELECT id FROM tickers)
   AND NOT EXISTS (
     SELECT 1 FROM transactions WHERE transactions.instrument_id = instruments.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM corporate_actions
      WHERE corporate_actions.instrument_id = instruments.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM corporate_action_coverage
      WHERE corporate_action_coverage.instrument_id = instruments.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM daily_market_facts
      WHERE daily_market_facts.instrument_id = instruments.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM dividend_events
      WHERE dividend_events.instrument_id = instruments.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM work_items
      WHERE work_items.instrument_id = instruments.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM dispatch_batches
      WHERE dispatch_batches.instrument_id = instruments.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM pipeline_job_dividend_recalculations
      WHERE pipeline_job_dividend_recalculations.instrument_id = instruments.id
   );
