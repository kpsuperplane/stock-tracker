import type { CorporateActionRecord } from "../db/corporate-actions";
import type { InstrumentRecord } from "../db/instruments";
import { deriveHoldings, type LedgerTransaction } from "../domain/holdings";
import type { SplitEventRange } from "../providers/corporate-actions";
import type { NormalizedImportTransaction } from "./event-import-csv";
import { proposedSplits, toActiveSplit } from "./event-import-snapshots";

const MAX_CURRENT_POSITIONS = 100;

export const toLedgerTransaction = (
  transaction: Pick<
    NormalizedImportTransaction,
    "instrumentId" | "tradeDate" | "side" | "quantityDecimal"
  >,
): LedgerTransaction => ({
  id: `preview:${transaction.instrumentId}:${transaction.tradeDate}:${transaction.side}`,
  tradeDate: transaction.tradeDate,
  side: transaction.side,
  quantityDecimal: transaction.quantityDecimal,
});

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
              instruments.currency, instruments.instrument_type AS instrumentType,
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

export const instrumentsById = async (
  db: D1Database,
  instrumentIds: readonly string[],
): Promise<Map<string, InstrumentRecord>> => {
  const result = new Map<string, InstrumentRecord>();
  const requestedIds = [...new Set(instrumentIds)];
  if (requestedIds.length === 0) return result;
  const rows = await db
    .prepare(
      `SELECT instruments.id, instruments.symbol,
              instruments.company_name AS companyName, instruments.exchange,
              instruments.currency, instruments.instrument_type AS instrumentType,
              instruments.provider, instruments.provider_symbol AS providerSymbol,
              instruments.provider_metadata_json AS providerMetadataJson,
              instruments.created_at AS createdAt, instruments.updated_at AS updatedAt
       FROM instruments JOIN json_each(?1) AS requested
         ON instruments.id = requested.value`,
    )
    .bind(JSON.stringify(requestedIds))
    .all<InstrumentRecord>();
  for (const row of rows.results) result.set(row.id, row);
  return result;
};

export const transactionsByInstrument = async (
  db: D1Database,
  instrumentIds: readonly string[],
  accountIds?: readonly string[],
): Promise<Map<string, Array<LedgerTransaction & { accountId: string }>>> => {
  const result = new Map<
    string,
    Array<LedgerTransaction & { accountId: string }>
  >();
  const requestedIds = [...new Set(instrumentIds)];
  if (requestedIds.length === 0) return result;
  const rows = await db
    .prepare(
      `SELECT transactions.id, transactions.instrument_id, transactions.account_id,
              transactions.trade_date, transactions.side,
              transactions.quantity_decimal
       FROM transactions JOIN json_each(?1) AS requested
         ON transactions.instrument_id = requested.value
       WHERE (?2 IS NULL OR transactions.account_id IN (
         SELECT value FROM json_each(?2)
       ))
       ORDER BY transactions.instrument_id, transactions.trade_date,
                transactions.id`,
    )
    .bind(
      JSON.stringify(requestedIds),
      accountIds ? JSON.stringify([...new Set(accountIds)]) : null,
    )
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
      `SELECT corporate_actions.id, corporate_actions.instrument_id AS instrumentId,
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

export const assertProjectedHoldings = (
  existing: LedgerTransaction[],
  active: CorporateActionRecord[],
  rows: NormalizedImportTransaction[],
  snapshot: SplitEventRange,
  today: string,
): void => {
  deriveHoldings({
    today,
    transactions: [...existing, ...rows.map(toLedgerTransaction)],
    activeSplits: proposedSplits(active, snapshot),
  });
};

export const withinPositionLimit = async (
  db: D1Database,
  imported: Map<string, NormalizedImportTransaction[]>,
  refreshed: { instrument: InstrumentRecord; snapshot: SplitEventRange }[],
  today: string,
): Promise<boolean> => {
  const snapshots = new Map(
    refreshed.map(({ instrument, snapshot }) => [instrument.id, snapshot]),
  );
  const instruments = await db
    .prepare("SELECT id FROM instruments ORDER BY id")
    .all<{ id: string }>();
  const instrumentIds = instruments.results.map(({ id }) => id);
  const existingByInstrument = await transactionsByInstrument(
    db,
    instrumentIds,
  );
  const actionsByInstrument = await activeActionsByInstrument(
    db,
    instrumentIds,
  );
  let currentPositions = 0;
  try {
    for (const { id } of instruments.results) {
      const actions = actionsByInstrument.get(id) ?? [];
      const snapshot = snapshots.get(id);
      const byAccount = new Map<string, LedgerTransaction[]>();
      for (const transaction of existingByInstrument.get(id) ?? []) {
        const rows = byAccount.get(transaction.accountId) ?? [];
        rows.push(transaction);
        byAccount.set(transaction.accountId, rows);
      }
      for (const importedRow of imported.get(id) ?? []) {
        const rows = byAccount.get(importedRow.accountId) ?? [];
        rows.push(toLedgerTransaction(importedRow));
        byAccount.set(importedRow.accountId, rows);
      }
      const activeSplits = snapshot
        ? proposedSplits(actions, snapshot)
        : actions.map(toActiveSplit);
      let instrumentHeld = false;
      for (const transactions of byAccount.values()) {
        const holdings = deriveHoldings({
          today,
          transactions,
          activeSplits,
        });
        if (holdings.currentQuantity() !== "0") instrumentHeld = true;
      }
      if (instrumentHeld) currentPositions += 1;
      if (currentPositions > MAX_CURRENT_POSITIONS) return false;
    }
  } catch {
    return false;
  }
  return true;
};
