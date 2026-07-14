-- Persist the normalized security kind without rebuilding the original
-- instruments table, whose legacy check constraint predates warrant support.
ALTER TABLE tickers ADD COLUMN security_type TEXT NOT NULL DEFAULT 'stock'
  CHECK (security_type IN ('stock', 'etf', 'warrant'));

ALTER TABLE instruments ADD COLUMN security_type TEXT NOT NULL DEFAULT 'stock'
  CHECK (security_type IN ('stock', 'etf', 'warrant'));

UPDATE instruments SET security_type = instrument_type;

-- Yahoo currently labels these listed warrants as EQUITY, so preserve their
-- actual kind explicitly for both existing and newly materialized identities.
UPDATE tickers
   SET security_type = 'warrant'
 WHERE symbol IN ('OPENW', 'OPENL', 'OPENZ');

UPDATE instruments
   SET security_type = 'warrant'
 WHERE symbol IN ('OPENW', 'OPENL', 'OPENZ');

-- These refresh queues are stock-only. Remove any work that may have been
-- staged while an existing warrant was still classified as a stock.
DELETE FROM dividend_refresh_state
 WHERE instrument_id IN (
   SELECT id FROM instruments WHERE security_type = 'warrant'
 );

DELETE FROM earnings_history_coverage
 WHERE instrument_id IN (
   SELECT id FROM instruments WHERE security_type = 'warrant'
 );
