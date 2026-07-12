-- The normalized ledger uses instrument identities while the original product
-- stores the user's watchlist in tickers. Preserve those stable ticker IDs so
-- a symbol can be entered from the Events page without a separate setup step.
INSERT OR IGNORE INTO instruments
  (id, symbol, company_name, exchange, currency, instrument_type,
   provider, provider_symbol, provider_metadata_json, created_at, updated_at)
SELECT
  id,
  symbol,
  company_name,
  exchange,
  currency,
  'stock',
  'yahoo',
  symbol,
  NULL,
  created_at,
  updated_at
FROM tickers;
