CREATE INDEX IF NOT EXISTS daily_market_facts_date_instrument_idx
  ON daily_market_facts(trading_date, instrument_id);

CREATE INDEX IF NOT EXISTS dividend_events_ex_date_instrument_idx
  ON dividend_events(ex_date, instrument_id, status);

CREATE INDEX IF NOT EXISTS work_items_fact_date_idx
  ON work_items(effective_date, instrument_id, work_type, state)
  WHERE scope = 'global_fact';
