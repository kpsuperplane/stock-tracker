import { canonicalizeDecimal, INPUT_DECIMAL_BOUNDS } from "../domain/decimal";
import { deriveHoldings } from "../domain/holdings";
import { instrumentTypeFromYahoo } from "../domain/instruments";
import type { CorporateActionProvider } from "../providers/corporate-actions";
import type { MarketDataProvider } from "../providers/market-data";
import { easternMarketDate } from "../shared/dates";
import {
  accountsByName,
  importChunks,
  isIsoDate,
  parseImportSource,
} from "./event-import-csv";
import { EventImportFinalizer } from "./event-import-finalizer";
import {
  activeActionsByInstrument,
  instrumentsBySymbol,
  transactionsByInstrument,
} from "./event-import-ledger";
import {
  isTransientProviderError,
  previousDays,
  providerErrorCode,
} from "./event-import-provider";
import { proposedSplits } from "./event-import-snapshots";

const LEASE_MS = 2 * 60 * 1_000;
const MAX_SYMBOL_ATTEMPTS = 5;
const SYMBOL_CONCURRENCY = 5;
const ROW_UPDATE_CHUNK = 500;
const BACKOFF_SECONDS = [30, 120, 300, 900, 1_800] as const;

interface ImportQueue {
  send(
    message: { importBatchId: string },
    options?: { delaySeconds?: number },
  ): Promise<unknown>;
}

interface JobDependencies {
  db: D1Database;
  queue: ImportQueue;
  marketDataProvider: MarketDataProvider;
  corporateActionProvider: CorporateActionProvider;
  now?: () => Date;
  newId?: () => string;
}

interface StagedRow {
  id: string;
  row_number: number;
  symbol: string;
  source_json: string | null;
}

interface PreparedRow {
  id: string;
  accountId: string | null;
  categoryName: string;
  accountName: string;
  tradeDate: string | null;
  side: "buy" | "sell" | null;
  quantityDecimal: string | null;
  priceDecimal: string | null;
  status: "valid" | "invalid";
  errors: string[];
  normalized: string | null;
}

interface SymbolTask {
  id: string;
  source_symbol: string;
  attempt_count: number;
  resolved_instrument_id: string | null;
  resolved_symbol: string | null;
  provider_symbol: string | null;
  instrument_metadata_json: string | null;
}

interface ValidRow {
  account_id: string;
  normalized_transaction_json: string;
}

interface NormalizedRow {
  tradeDate: string;
  side: "buy" | "sell";
  quantityDecimal: string;
  priceDecimal: string;
}

export class EventImportJobProcessor {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly dependencies: JobDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
  }

  async process(importBatchId: string): Promise<void> {
    const timestamp = this.now().toISOString();
    const leaseUntil = new Date(this.now().valueOf() + LEASE_MS).toISOString();
    const leaseToken = this.newId();
    const claimed = await this.dependencies.db
      .prepare(
        `UPDATE import_batches
            SET status = 'running', processing_lease_until = ?1,
                processing_lease_token = ?3,
                attempt_count = attempt_count + 1, updated_at = ?2
          WHERE id = ?4 AND status IN ('pending', 'running')
            AND expires_at > ?2 AND (available_at IS NULL OR available_at <= ?2)
            AND (processing_lease_until IS NULL OR processing_lease_until <= ?2)`,
      )
      .bind(leaseUntil, timestamp, leaseToken, importBatchId)
      .run();
    if (claimed.meta.changes !== 1) return;

    const batch = await this.dependencies.db
      .prepare("SELECT prepared_at FROM import_batches WHERE id = ?1")
      .bind(importBatchId)
      .first<{ prepared_at: string | null }>();
    if (!batch) return;
    await this.dependencies.db
      .prepare(
        `UPDATE import_symbols SET state = 'retry', processing_token = NULL,
                available_at = ?2, updated_at = ?2
          WHERE import_batch_id = ?1 AND state = 'processing'`,
      )
      .bind(importBatchId, timestamp)
      .run();
    if (!batch.prepared_at) await this.prepareRows(importBatchId, timestamp);

    const tasks = await this.dependencies.db
      .prepare(
        `SELECT id, source_symbol, attempt_count, resolved_instrument_id,
                resolved_symbol, provider_symbol, instrument_metadata_json
           FROM import_symbols
          WHERE import_batch_id = ?1 AND state IN ('pending', 'retry')
            AND (available_at IS NULL OR available_at <= ?2)
          ORDER BY source_symbol LIMIT ?3`,
      )
      .bind(importBatchId, timestamp, SYMBOL_CONCURRENCY)
      .all<SymbolTask>();
    await Promise.all(
      tasks.results.map((task) =>
        this.processSymbol(importBatchId, task, leaseToken),
      ),
    );
    await this.settle(importBatchId, leaseToken);
  }

  private async prepareRows(batchId: string, timestamp: string): Promise<void> {
    const staged = await this.dependencies.db
      .prepare(
        `SELECT id, row_number, symbol, source_json FROM import_rows
          WHERE import_batch_id = ?1 ORDER BY row_number`,
      )
      .bind(batchId)
      .all<StagedRow>();
    const sourceRows = staged.results.map((row) => ({
      row,
      values: parseImportSource(row.source_json),
    }));
    const accounts = await accountsByName(
      this.dependencies.db,
      sourceRows.flatMap(({ values }) =>
        values
          ? [
              {
                categoryName: (values[5] ?? "").trim(),
                accountName: (values[6] ?? "").trim(),
              },
            ]
          : [],
      ),
    );
    const accountKey = (category: string, account: string) =>
      `${category.trim().toLowerCase()}\u0000${account.trim().toLowerCase()}`;
    const today = easternMarketDate(timestamp);
    const prepared: PreparedRow[] = sourceRows.map(({ row, values }) => {
      if (!values) {
        return {
          id: row.id,
          accountId: null,
          categoryName: "",
          accountName: "",
          tradeDate: null,
          side: null,
          quantityDecimal: null,
          priceDecimal: null,
          status: "invalid",
          errors: ["invalid_staged_row"],
          normalized: null,
        };
      }
      const [
        dateRaw = "",
        symbolRaw = "",
        sideRaw = "",
        quantityRaw = "",
        priceRaw = "",
        categoryRaw = "",
        accountRaw = "",
      ] = values.map((value) => value.trim());
      const symbol = symbolRaw.toUpperCase();
      const side = sideRaw.toLowerCase();
      const errors: string[] = [];
      if (!/^[A-Z0-9.^-]{1,32}$/.test(symbol)) errors.push("invalid_symbol");
      if (!isIsoDate(dateRaw) || dateRaw > today)
        errors.push("invalid_trade_date");
      if (side !== "buy" && side !== "sell") errors.push("invalid_side");
      if (categoryRaw.length < 1 || categoryRaw.length > 120)
        errors.push("invalid_category");
      if (accountRaw.length < 1 || accountRaw.length > 120)
        errors.push("invalid_account");
      let quantity: string | null = null;
      let price: string | null = null;
      try {
        quantity = canonicalizeDecimal(quantityRaw, INPUT_DECIMAL_BOUNDS);
        if (quantity === "0" || quantity.startsWith("-"))
          errors.push("invalid_quantity");
      } catch {
        errors.push("invalid_quantity");
      }
      try {
        price = canonicalizeDecimal(priceRaw, INPUT_DECIMAL_BOUNDS);
        if (price.startsWith("-")) errors.push("invalid_price");
      } catch {
        errors.push("invalid_price");
      }
      const resolvedAccount = accounts.get(accountKey(categoryRaw, accountRaw));
      if (
        !resolvedAccount &&
        !errors.includes("invalid_category") &&
        !errors.includes("invalid_account")
      ) {
        errors.push("unknown_account");
      }
      const normalized =
        errors.length === 0 && resolvedAccount && quantity && price
          ? JSON.stringify({
              accountId: resolvedAccount.id,
              symbol,
              tradeDate: dateRaw,
              side,
              quantityDecimal: quantity,
              priceDecimal: price,
            })
          : null;
      return {
        id: row.id,
        accountId: resolvedAccount?.id ?? null,
        categoryName: resolvedAccount?.categoryName ?? categoryRaw,
        accountName: resolvedAccount?.accountName ?? accountRaw,
        tradeDate: dateRaw || null,
        side: side === "buy" || side === "sell" ? side : null,
        quantityDecimal: quantity,
        priceDecimal: price,
        status: errors.length === 0 ? "valid" : "invalid",
        errors,
        normalized,
      };
    });
    const statements = importChunks(prepared, ROW_UPDATE_CHUNK).map((chunk) =>
      this.dependencies.db
        .prepare(
          `UPDATE import_rows
              SET account_id = json_extract(source.value, '$.accountId'),
                  category_name = json_extract(source.value, '$.categoryName'),
                  account_name = json_extract(source.value, '$.accountName'),
                  trade_date = json_extract(source.value, '$.tradeDate'),
                  side = json_extract(source.value, '$.side'),
                  quantity_decimal = json_extract(source.value, '$.quantityDecimal'),
                  price_decimal = json_extract(source.value, '$.priceDecimal'),
                  status = json_extract(source.value, '$.status'),
                  validation_errors_json = CASE
                    WHEN json_extract(source.value, '$.status') = 'invalid'
                    THEN json_extract(source.value, '$.errorsJson') ELSE NULL END,
                  normalized_transaction_json = json_extract(source.value, '$.normalized')
             FROM json_each(?1) source
            WHERE import_rows.id = json_extract(source.value, '$.id')`,
        )
        .bind(
          JSON.stringify(
            chunk.map((row) => ({
              ...row,
              errorsJson: JSON.stringify(row.errors),
            })),
          ),
        ),
    );
    statements.push(
      this.dependencies.db
        .prepare(
          `UPDATE import_symbols
              SET resolved_instrument_id = instruments.id,
                  resolved_symbol = instruments.symbol,
                  provider_symbol = instruments.provider_symbol,
                  instrument_metadata_json = json_object(
                    'companyName', instruments.company_name,
                    'exchange', instruments.exchange,
                    'currency', instruments.currency,
                    'instrumentType', instruments.security_type
                  ),
                  updated_at = ?2
             FROM instruments
            WHERE import_symbols.import_batch_id = ?1
              AND import_symbols.source_symbol = instruments.symbol`,
        )
        .bind(batchId, timestamp),
      this.dependencies.db
        .prepare(
          `UPDATE import_batches
              SET prepared_at = ?2,
                  failed_rows = (SELECT COUNT(*) FROM import_rows
                                  WHERE import_batch_id = ?1 AND status = 'invalid'),
                  updated_at = ?2
            WHERE id = ?1 AND prepared_at IS NULL`,
        )
        .bind(batchId, timestamp),
    );
    await this.dependencies.db.batch(statements);
  }

  private async processSymbol(
    batchId: string,
    task: SymbolTask,
    leaseToken: string,
  ): Promise<void> {
    const timestamp = this.now().toISOString();
    const attempt = task.attempt_count + 1;
    const claimed = await this.dependencies.db
      .prepare(
        `UPDATE import_symbols SET state = 'processing', attempt_count = ?1,
                processing_token = ?3, available_at = NULL, updated_at = ?2
          WHERE id = ?4 AND state IN ('pending', 'retry')
            AND EXISTS (
              SELECT 1 FROM import_batches
               WHERE id = ?5 AND processing_lease_token = ?3
            )`,
      )
      .bind(attempt, timestamp, leaseToken, task.id, batchId)
      .run();
    if (claimed.meta.changes !== 1) return;
    const rows = await this.dependencies.db
      .prepare(
        `SELECT account_id, normalized_transaction_json FROM import_rows
          WHERE import_batch_id = ?1 AND symbol = ?2 AND status = 'valid'
          ORDER BY row_number`,
      )
      .bind(batchId, task.source_symbol)
      .all<ValidRow>();
    if (rows.results.length === 0) {
      await this.completeSymbol(task.id, "complete", timestamp, leaseToken);
      return;
    }

    try {
      const today = easternMarketDate(timestamp);
      let instrumentId = task.resolved_instrument_id;
      let resolvedSymbol = task.resolved_symbol;
      let providerSymbol = task.provider_symbol;
      let metadataJson = task.instrument_metadata_json;
      if (!resolvedSymbol || !providerSymbol || !metadataJson) {
        const start = previousDays(today, 10);
        const series = await this.dependencies.marketDataProvider.getInstrument(
          task.source_symbol,
          start,
          today,
        );
        const hasRecentBar = series.bars.some(
          (bar) =>
            bar.date >= start &&
            bar.date <= today &&
            (bar.adjustedClose ?? bar.close ?? 0) > 0,
        );
        if (!hasRecentBar) throw new Error("provider_symbol_unavailable");
        if (
          !["EQUITY", "ETF", "WARRANT"].includes(
            series.metadata.instrumentType,
          ) ||
          !["USD", "CAD"].includes(series.metadata.currency)
        ) {
          await this.failRows(
            batchId,
            task.id,
            task.source_symbol,
            "unsupported_instrument",
            timestamp,
            leaseToken,
          );
          await this.completeSymbol(
            task.id,
            "failed",
            timestamp,
            leaseToken,
            "unsupported_instrument",
            "The provider returned an unsupported instrument.",
          );
          return;
        }
        resolvedSymbol = series.metadata.symbol.toUpperCase();
        providerSymbol = resolvedSymbol;
        const existing = await instrumentsBySymbol(this.dependencies.db, [
          resolvedSymbol,
        ]);
        const existingInstrument = existing.get(resolvedSymbol);
        instrumentId = existingInstrument?.id ?? null;
        metadataJson = JSON.stringify({
          companyName: series.metadata.companyName,
          exchange: series.metadata.exchange,
          currency: series.metadata.currency,
          instrumentType: instrumentTypeFromYahoo(
            resolvedSymbol,
            series.metadata.instrumentType,
          ),
        });
      }
      const normalizedRows = rows.results.map((row) => ({
        accountId: row.account_id,
        value: JSON.parse(row.normalized_transaction_json) as NormalizedRow,
      }));
      const existingMinimum = instrumentId
        ? await this.dependencies.db
            .prepare(
              "SELECT MIN(trade_date) AS startDate FROM transactions WHERE instrument_id = ?1",
            )
            .bind(instrumentId)
            .first<{ startDate: string | null }>()
        : null;
      const startDate = [
        ...normalizedRows.map((row) => row.value.tradeDate),
        ...(existingMinimum?.startDate ? [existingMinimum.startDate] : []),
      ].sort()[0];
      if (!startDate) throw new Error("invalid_import_rows");
      const snapshot =
        await this.dependencies.corporateActionProvider.getSplits(
          providerSymbol,
          startDate,
          today,
        );
      if (
        snapshot.symbol !== providerSymbol.toUpperCase() ||
        snapshot.range.requestedStartDate !== startDate ||
        snapshot.range.requestedEndDate !== today
      ) {
        throw new Error("provider_snapshot_mismatch");
      }
      const existingTransactions = await transactionsByInstrument(
        this.dependencies.db,
        instrumentId ? [instrumentId] : [],
      );
      const activeActions = await activeActionsByInstrument(
        this.dependencies.db,
        instrumentId ? [instrumentId] : [],
      );
      const holdings: Array<{ accountId: string; quantityDecimal: string }> =
        [];
      let hasNonzero = false;
      for (const accountId of [
        ...new Set(normalizedRows.map((row) => row.accountId)),
      ]) {
        const imported = normalizedRows
          .filter((row) => row.accountId === accountId)
          .map((row, index) => ({
            id: `import:${task.id}:${index}`,
            tradeDate: row.value.tradeDate,
            side: row.value.side,
            quantityDecimal: row.value.quantityDecimal,
          }));
        try {
          const result = deriveHoldings({
            today,
            transactions: [
              ...(instrumentId
                ? (existingTransactions.get(instrumentId) ?? []).filter(
                    (row) => row.accountId === accountId,
                  )
                : []),
              ...imported,
            ],
            activeSplits: proposedSplits(
              instrumentId ? (activeActions.get(instrumentId) ?? []) : [],
              snapshot,
            ),
          }).currentQuantity();
          holdings.push({ accountId, quantityDecimal: result });
          if (result !== "0") hasNonzero = true;
        } catch {
          // Canonical aliases can split one instrument's rows across symbol
          // tasks. The finalizer folds all aliases together before committing.
        }
      }
      await this.dependencies.db
        .prepare(
          `UPDATE import_symbols
              SET state = 'complete', resolved_instrument_id = ?1,
                  resolved_symbol = ?2, provider_symbol = ?3,
                  instrument_metadata_json = ?4, split_snapshot_json = ?5,
                  projected_holdings_json = ?6, has_nonzero_holdings = ?7,
                  error_code = NULL, error_message = NULL,
                  processing_token = NULL, completed_at = ?8, updated_at = ?8
            WHERE id = ?9 AND state = 'processing'
              AND processing_token = ?10`,
        )
        .bind(
          instrumentId,
          resolvedSymbol,
          providerSymbol,
          metadataJson,
          JSON.stringify(snapshot),
          JSON.stringify(holdings),
          hasNonzero ? 1 : 0,
          timestamp,
          task.id,
          leaseToken,
        )
        .run();
    } catch (error) {
      const code = providerErrorCode(error);
      if (code === "provider_symbol_unavailable") {
        await this.failRows(
          batchId,
          task.id,
          task.source_symbol,
          "symbol_unavailable",
          timestamp,
          leaseToken,
        );
        await this.completeSymbol(
          task.id,
          "failed",
          timestamp,
          leaseToken,
          "symbol_unavailable",
          "The symbol is unavailable from the market-data provider.",
        );
        return;
      }
      const transient = isTransientProviderError(error);
      if (transient && attempt < MAX_SYMBOL_ATTEMPTS) {
        const delay =
          BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)] ??
          1_800;
        const availableAt = new Date(
          this.now().valueOf() + delay * 1_000,
        ).toISOString();
        await this.dependencies.db
          .prepare(
            `UPDATE import_symbols SET state = 'retry', available_at = ?1,
                    processing_token = NULL, error_code = ?2,
                    error_message = ?3, updated_at = ?4
              WHERE id = ?5 AND state = 'processing'
                AND processing_token = ?6`,
          )
          .bind(
            availableAt,
            code,
            String(error),
            timestamp,
            task.id,
            leaseToken,
          )
          .run();
        return;
      }
      if (!transient) {
        await this.failRows(
          batchId,
          task.id,
          task.source_symbol,
          code,
          timestamp,
          leaseToken,
        );
        await this.completeSymbol(
          task.id,
          "failed",
          timestamp,
          leaseToken,
          code,
          String(error),
        );
        return;
      }
      await this.completeSymbol(
        task.id,
        "terminal",
        timestamp,
        leaseToken,
        "provider_retry_exhausted",
        String(error),
      );
    }
  }

  private async failRows(
    batchId: string,
    taskId: string,
    symbol: string,
    code: string,
    timestamp: string,
    leaseToken: string,
  ): Promise<void> {
    await this.dependencies.db
      .prepare(
        `UPDATE import_rows SET status = 'invalid',
                validation_errors_json = json_array(?1),
                normalized_transaction_json = NULL
          WHERE import_batch_id = ?2 AND symbol = ?3 AND status = 'valid'
            AND EXISTS (
              SELECT 1 FROM import_symbols
               WHERE id = ?4 AND state = 'processing'
                 AND processing_token = ?5
            )`,
      )
      .bind(code, batchId, symbol, taskId, leaseToken)
      .run();
    await this.dependencies.db
      .prepare(
        `UPDATE import_batches SET failed_rows = (
           SELECT COUNT(*) FROM import_rows
            WHERE import_batch_id = ?1 AND status = 'invalid'
         ), updated_at = ?2 WHERE id = ?1 AND processing_lease_token = ?3`,
      )
      .bind(batchId, timestamp, leaseToken)
      .run();
  }

  private async completeSymbol(
    id: string,
    state: "complete" | "failed" | "terminal",
    timestamp: string,
    leaseToken: string,
    code?: string,
    message?: string,
  ): Promise<void> {
    await this.dependencies.db
      .prepare(
        `UPDATE import_symbols SET state = ?1, error_code = ?2,
                error_message = ?3, processing_token = NULL,
                completed_at = ?4, updated_at = ?4
          WHERE id = ?5 AND state = 'processing' AND processing_token = ?6`,
      )
      .bind(state, code ?? null, message ?? null, timestamp, id, leaseToken)
      .run();
  }

  private async settle(batchId: string, leaseToken: string): Promise<void> {
    const timestamp = this.now().toISOString();
    const summary = await this.dependencies.db
      .prepare(
        `SELECT
           SUM(CASE WHEN state IN ('complete', 'failed', 'terminal') THEN 1 ELSE 0 END) AS processed,
           SUM(CASE WHEN state = 'terminal' THEN 1 ELSE 0 END) AS terminal,
           SUM(CASE WHEN state IN ('pending', 'retry', 'processing') THEN 1 ELSE 0 END) AS remaining,
           MIN(CASE WHEN state = 'pending' THEN ?2
                    WHEN state = 'retry' THEN available_at
                    WHEN state = 'processing' THEN ?2 END) AS next_available
         FROM import_symbols WHERE import_batch_id = ?1`,
      )
      .bind(batchId, timestamp)
      .first<{
        processed: number | null;
        terminal: number | null;
        remaining: number | null;
        next_available: string | null;
      }>();
    const processed = summary?.processed ?? 0;
    const terminal = summary?.terminal ?? 0;
    const remaining = summary?.remaining ?? 0;
    if (terminal > 0) {
      const failure = await this.dependencies.db
        .prepare(
          `SELECT error_code, error_message FROM import_symbols
            WHERE import_batch_id = ?1 AND state = 'terminal'
            ORDER BY source_symbol LIMIT 1`,
        )
        .bind(batchId)
        .first<{ error_code: string | null; error_message: string | null }>();
      await this.dependencies.db
        .prepare(
          `UPDATE import_batches SET status = 'terminal',
                  terminal_error_code = ?1, terminal_error_message = ?2,
                  processed_symbols = ?3, completed_at = ?4, updated_at = ?4,
                  processing_lease_until = NULL,
                  processing_lease_token = NULL
            WHERE id = ?5 AND status = 'running'
              AND processing_lease_token = ?6`,
        )
        .bind(
          failure?.error_code ?? "provider_retry_exhausted",
          failure?.error_message ?? "Provider retries were exhausted.",
          processed,
          timestamp,
          batchId,
          leaseToken,
        )
        .run();
      return;
    }
    if (remaining > 0) {
      const released = await this.dependencies.db
        .prepare(
          `UPDATE import_batches SET processed_symbols = ?1,
                  processing_lease_until = NULL,
                  processing_lease_token = NULL, available_at = ?2,
                  updated_at = ?3
            WHERE id = ?4 AND status = 'running'
              AND processing_lease_token = ?5`,
        )
        .bind(
          processed,
          summary?.next_available ?? timestamp,
          timestamp,
          batchId,
          leaseToken,
        )
        .run();
      if (released.meta.changes !== 1) return;
      const next = summary?.next_available
        ? Math.max(0, Date.parse(summary.next_available) - this.now().valueOf())
        : 0;
      try {
        await this.dependencies.queue.send(
          { importBatchId: batchId },
          next > 0 ? { delaySeconds: Math.ceil(next / 1_000) } : undefined,
        );
      } catch {
        // The scheduler recovers unsent continuations from D1.
      }
      return;
    }
    const owned = await this.dependencies.db
      .prepare(
        `UPDATE import_batches SET processed_symbols = ?1,
                available_at = ?2, updated_at = ?2
          WHERE id = ?3 AND status = 'running'
            AND processing_lease_token = ?4`,
      )
      .bind(processed, timestamp, batchId, leaseToken)
      .run();
    if (owned.meta.changes !== 1) return;
    await new EventImportFinalizer({
      db: this.dependencies.db,
      now: this.now,
      newId: this.newId,
    }).finalize(batchId);
  }
}
