import type { ImportRowRecord } from "../db/imports";
import type { InstrumentRecord } from "../db/instruments";
import { canonicalizeDecimal, INPUT_DECIMAL_BOUNDS } from "../domain/decimal";
import type { SplitEventRange } from "../providers/corporate-actions";

export type ImportSide = "buy" | "sell";

export interface NormalizedImportTransaction {
  instrumentId: string;
  accountId: string;
  symbol: string;
  tradeDate: string;
  side: ImportSide;
  quantityDecimal: string;
  priceDecimal: string;
  snapshot: {
    provider: string;
    requestedStartDate: string;
    requestedEndDate: string;
    providerRevision: string;
  };
}

export interface PendingImportRow {
  instrumentId: string;
  accountId: string;
  categoryName: string;
  accountName: string;
  symbol: string;
  tradeDate: string;
  side: ImportSide;
  quantityDecimal: string;
  priceDecimal: string;
  errors: string[];
  snapshot?: SplitEventRange;
}

export interface PreliminaryImportRow {
  rowNumber: number;
  symbol: string;
  tradeDate: string | null;
  side: ImportSide | null;
  quantityDecimal: string | null;
  priceDecimal: string | null;
  accountId: string | null;
  categoryName: string;
  accountName: string;
  errors: string[];
  normalized: PendingImportRow | null;
  instrument: InstrumentRecord | null;
}

export interface ImportPreviewRow {
  rowNumber: number;
  symbol: string;
  tradeDate: string | null;
  side: ImportSide | null;
  quantityDecimal: string | null;
  priceDecimal: string | null;
  accountId: string | null;
  categoryName: string;
  accountName: string;
  status: "valid" | "invalid";
  errors: string[];
}

interface ResolvedImportAccount {
  id: string;
  categoryName: string;
  accountName: string;
}

export const isIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

const errorList = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) &&
      parsed.every((entry) => typeof entry === "string")
      ? parsed
      : ["invalid_staged_row"];
  } catch {
    return ["invalid_staged_row"];
  }
};

const accountNameKey = (categoryName: string, accountName: string): string =>
  `${categoryName.trim().toLowerCase()}\u0000${accountName.trim().toLowerCase()}`;

export const accountsByName = async (
  db: D1Database,
  references: readonly { categoryName: string; accountName: string }[],
): Promise<Map<string, ResolvedImportAccount>> => {
  const requested = [
    ...new Map(
      references
        .filter(
          (entry) =>
            entry.categoryName.length >= 1 &&
            entry.categoryName.length <= 120 &&
            entry.accountName.length >= 1 &&
            entry.accountName.length <= 120,
        )
        .map((entry) => [
          accountNameKey(entry.categoryName, entry.accountName),
          entry,
        ]),
    ).values(),
  ];
  if (requested.length === 0) return new Map();
  const requestedKeys = new Set(
    requested.map((entry) =>
      accountNameKey(entry.categoryName, entry.accountName),
    ),
  );
  const rows = await db
    .prepare(
      `SELECT accounts.id, accounts.name AS account_name,
              account_categories.name AS category_name
         FROM accounts
         JOIN account_categories ON account_categories.id = accounts.category_id
        WHERE accounts.archived_at IS NULL
          AND account_categories.archived_at IS NULL`,
    )
    .all<{ id: string; account_name: string; category_name: string }>();
  return new Map(
    rows.results.flatMap((row) => {
      const key = accountNameKey(row.category_name, row.account_name);
      return requestedKeys.has(key)
        ? [
            [
              key,
              {
                id: row.id,
                categoryName: row.category_name,
                accountName: row.account_name,
              },
            ] as const,
          ]
        : [];
    }),
  );
};

export const activeAccountIds = async (
  db: D1Database,
  accountIds: readonly string[],
): Promise<Set<string>> => {
  if (accountIds.length === 0) return new Set();
  const rows = await db
    .prepare(
      `SELECT accounts.id
         FROM accounts
         JOIN account_categories ON account_categories.id = accounts.category_id
         JOIN json_each(?1) AS requested ON accounts.id = requested.value
        WHERE accounts.archived_at IS NULL
          AND account_categories.archived_at IS NULL`,
    )
    .bind(JSON.stringify([...new Set(accountIds)]))
    .all<{ id: string }>();
  return new Set(rows.results.map((row) => row.id));
};

export const normalizeImportRow = (
  values: string[],
  rowNumber: number,
  today: string,
  instrumentsBySymbol: ReadonlyMap<string, InstrumentRecord>,
  resolvedAccounts: ReadonlyMap<string, ResolvedImportAccount>,
): PreliminaryImportRow => {
  const errors: string[] = [];
  if (values.length !== 7)
    return {
      rowNumber,
      symbol: "",
      tradeDate: null,
      side: null,
      quantityDecimal: null,
      priceDecimal: null,
      accountId: null,
      categoryName: "",
      accountName: "",
      errors: ["column_count"],
      normalized: null,
      instrument: null,
    };
  const [
    dateInput = "",
    symbolInput = "",
    sideInput = "",
    quantityInput = "",
    priceInput = "",
    categoryInput = "",
    accountInput = "",
  ] = values.map((value) => value.trim());
  const symbol = symbolInput.toUpperCase();
  const tradeDate = dateInput;
  const side = sideInput.toLowerCase() as ImportSide;
  if (!/^[A-Z0-9.^-]{1,32}$/.test(symbol)) errors.push("invalid_symbol");
  if (!isIsoDate(tradeDate) || tradeDate > today)
    errors.push("invalid_trade_date");
  if (side !== "buy" && side !== "sell") errors.push("invalid_side");
  if (categoryInput.length < 1 || categoryInput.length > 120)
    errors.push("invalid_category");
  if (accountInput.length < 1 || accountInput.length > 120)
    errors.push("invalid_account");
  let quantityDecimal: string | null = null;
  let priceDecimal: string | null = null;
  try {
    quantityDecimal = canonicalizeDecimal(quantityInput, INPUT_DECIMAL_BOUNDS);
    if (quantityDecimal === "0" || quantityDecimal.startsWith("-"))
      errors.push("invalid_quantity");
  } catch {
    errors.push("invalid_quantity");
  }
  try {
    priceDecimal = canonicalizeDecimal(priceInput, INPUT_DECIMAL_BOUNDS);
    if (priceDecimal.startsWith("-")) errors.push("invalid_price");
  } catch {
    errors.push("invalid_price");
  }
  const account =
    categoryInput.length >= 1 &&
    categoryInput.length <= 120 &&
    accountInput.length >= 1 &&
    accountInput.length <= 120
      ? (resolvedAccounts.get(accountNameKey(categoryInput, accountInput)) ??
        null)
      : null;
  if (
    !account &&
    !errors.includes("invalid_category") &&
    !errors.includes("invalid_account")
  )
    errors.push("unknown_account");
  const instrument = instrumentsBySymbol.get(symbol) ?? null;
  if (/^[A-Z0-9.^-]{1,32}$/.test(symbol) && !instrument)
    errors.push("unknown_symbol");
  const normalized =
    errors.length === 0 &&
    instrument &&
    account &&
    quantityDecimal &&
    priceDecimal
      ? {
          instrumentId: instrument.id,
          accountId: account.id,
          categoryName: account.categoryName,
          accountName: account.accountName,
          symbol,
          tradeDate,
          side,
          quantityDecimal,
          priceDecimal,
          errors,
          snapshot: undefined as unknown as SplitEventRange,
        }
      : null;
  return {
    rowNumber,
    symbol,
    tradeDate: tradeDate || null,
    side: side === "buy" || side === "sell" ? side : null,
    quantityDecimal,
    priceDecimal,
    accountId: account?.id ?? null,
    categoryName: account?.categoryName ?? categoryInput,
    accountName: account?.accountName ?? accountInput,
    errors,
    normalized,
    instrument,
  };
};

export const asNormalizedImport = (
  row: PendingImportRow,
): NormalizedImportTransaction => {
  if (!row.snapshot) throw new Error("missing_preview_snapshot");
  return {
    instrumentId: row.instrumentId,
    accountId: row.accountId,
    symbol: row.symbol,
    tradeDate: row.tradeDate,
    side: row.side,
    quantityDecimal: row.quantityDecimal,
    priceDecimal: row.priceDecimal,
    snapshot: {
      provider: row.snapshot.range.provider,
      requestedStartDate: row.snapshot.range.requestedStartDate,
      requestedEndDate: row.snapshot.range.requestedEndDate,
      providerRevision: row.snapshot.range.providerRevision,
    },
  };
};

export const toImportRow = (
  batchId: string,
  row: PreliminaryImportRow,
  newId: () => string,
): ImportRowRecord => {
  const valid = !!row.normalized && row.errors.length === 0;
  const normalized = valid
    ? asNormalizedImport(row.normalized as PendingImportRow)
    : null;
  return {
    id: newId(),
    importBatchId: batchId,
    rowNumber: row.rowNumber,
    symbol: row.symbol || "INVALID",
    tradeDate: row.tradeDate,
    side: row.side,
    quantityDecimal: row.quantityDecimal,
    priceDecimal: row.priceDecimal,
    accountId: row.accountId,
    categoryName: row.categoryName,
    accountName: row.accountName,
    status: valid ? "valid" : "invalid",
    validationErrorsJson: valid ? null : JSON.stringify(row.errors),
    normalizedTransactionJson: normalized ? JSON.stringify(normalized) : null,
  };
};

export const toPreviewRow = (row: ImportRowRecord): ImportPreviewRow => ({
  rowNumber: row.rowNumber,
  symbol: row.symbol,
  tradeDate: row.tradeDate,
  side: row.side,
  quantityDecimal: row.quantityDecimal,
  priceDecimal: row.priceDecimal,
  accountId: row.accountId,
  categoryName: row.categoryName,
  accountName: row.accountName,
  status: row.status,
  errors: errorList(row.validationErrorsJson),
});
