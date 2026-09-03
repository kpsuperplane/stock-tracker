-- Legacy identities were initially seeded as stocks before Yahoo security
-- kinds were persisted. Repair the known ETF identities so they do not enter
-- company-earnings coverage, while newly imported ETFs continue to use Yahoo's
-- normalized instrument type.
UPDATE tickers
   SET security_type = 'etf'
 WHERE symbol IN (
   'BTCC.TO', 'GLTR', 'HXS.TO', 'IBIT', 'KWEB', 'QQC.TO', 'QQQ', 'VFV.TO'
 );

UPDATE instruments
   SET instrument_type = 'etf', security_type = 'etf'
 WHERE instrument_type = 'etf'
    OR json_extract(provider_metadata_json, '$.instrumentType') = 'etf'
    OR symbol IN (
      'BTCC.TO', 'GLTR', 'HXS.TO', 'IBIT', 'KWEB', 'QQC.TO', 'QQQ', 'VFV.TO'
    );

DELETE FROM earnings_history_coverage
 WHERE instrument_id IN (
   SELECT id FROM instruments WHERE security_type = 'etf'
 );

-- Provider prose has historically included credentials in formats that the
-- old sanitizer did not recognize. Remove those stored messages during the
-- same repair; future writes are redacted before persistence.
UPDATE earnings_history_coverage
   SET last_error_message = last_error_code
 WHERE lower(last_error_message) LIKE '%api key%';

UPDATE earnings_calendar_coverage
   SET error_message = error_code
 WHERE lower(error_message) LIKE '%api key%';
