import type { CorporateActionRecord } from "../db/corporate-actions";
import type { InstrumentRecord } from "../db/instruments";
import type { LedgerTransaction } from "../domain/holdings";

export const instrumentsBySymbol = async (
  db: D1Database,
  symbols: readonly string[],
): Promise<Map<string, InstrumentRecord>> => {
  const result = new Map<string, InstrumentRecord>();
  const requestedSymbols = [...new Set(symbols.filter(Boolean))];
  if (requestedSymbols.length === 0) return result;
  const rows = await db
    .prepare(
      `SELECT instruments.id, instruments.symbol,
              instruments.company_name AS companyName, instruments.exchange,
              instruments.currency, instruments.security_type AS instrumentType,
              instruments.provider, instruments.provider_symbol AS providerSymbol,
              instruments.provider_metadata_json AS providerMetadataJson,
              instruments.created_at AS createdAt, instruments.updated_at AS updatedAt
       FROM instruments JOIN json_each(?1) AS requested
         ON instruments.symbol = requested.value`,
    )
    .bind(JSON.stringify(requestedSymbols))
    .all<InstrumentRecord>();
  for (const row of rows.results) result.set(row.symbol, row);
  return result;
};

export const transactionsByInstrument = async (
  db: D1Database,
  instrumentIds: readonly string[],
): Promise<Map<string, Array<LedgerTransaction & { accountId: string }>>> => {
  const result = new Map<
    string,
    Array<LedgerTransaction & { accountId: string }>
  >();
  const requestedIds = [...new Set(instrumentIds)];
  if (requestedIds.length === 0) return result;
  const rows = await db
    .prepare(
      `SELECT transactions.id, transactions.instrument_id,
              transactions.account_id, transactions.trade_date,
              transactions.side, transactions.quantity_decimal
       FROM transactions JOIN json_each(?1) AS requested
         ON transactions.instrument_id = requested.value
       ORDER BY transactions.instrument_id, transactions.trade_date,
                transactions.id`,
    )
    .bind(JSON.stringify(requestedIds))
    .all<{
      id: string;
      instrument_id: string;
      account_id: string | null;
      trade_date: string;
      side: "buy" | "sell";
      quantity_decimal: string;
    }>();
  for (const row of rows.results) {
    const transactions = result.get(row.instrument_id) ?? [];
    transactions.push({
      id: row.id,
      accountId: row.account_id ?? "account-default",
      tradeDate: row.trade_date,
      side: row.side,
      quantityDecimal: row.quantity_decimal,
    });
    result.set(row.instrument_id, transactions);
  }
  return result;
};

export const activeActionsByInstrument = async (
  db: D1Database,
  instrumentIds: readonly string[],
): Promise<Map<string, CorporateActionRecord[]>> => {
  const result = new Map<string, CorporateActionRecord[]>();
  const requestedIds = [...new Set(instrumentIds)];
  if (requestedIds.length === 0) return result;
  const rows = await db
    .prepare(
      `SELECT corporate_actions.id,
              corporate_actions.instrument_id AS instrumentId,
              corporate_actions.effective_date AS effectiveDate,
              corporate_actions.split_numerator AS splitNumerator,
              corporate_actions.split_denominator AS splitDenominator,
              corporate_actions.provider,
              corporate_actions.provider_event_id AS providerEventId,
              corporate_actions.provider_revision AS providerRevision,
              corporate_actions.retrieved_at AS retrievedAt,
              corporate_actions.revision, corporate_actions.status,
              corporate_actions.conflict_code AS conflictCode,
              corporate_actions.conflict_message AS conflictMessage,
              corporate_actions.created_at AS createdAt,
              corporate_actions.updated_at AS updatedAt
       FROM corporate_actions JOIN json_each(?1) AS requested
         ON corporate_actions.instrument_id = requested.value
       WHERE corporate_actions.status = 'active'
       ORDER BY corporate_actions.instrument_id,
                corporate_actions.effective_date, corporate_actions.id`,
    )
    .bind(JSON.stringify(requestedIds))
    .all<CorporateActionRecord>();
  for (const row of rows.results) {
    const actions = result.get(row.instrumentId) ?? [];
    actions.push(row);
    result.set(row.instrumentId, actions);
  }
  return result;
};
