import { PipelineJobRepository } from "../db/pipeline-jobs";
import { FactRevisionBucketRepository } from "../db/revision-buckets";
import {
  RESUMABLE_PLANNING_MAX_ATTEMPTS,
  WorkItemRepository,
} from "../db/work-items";
import { deriveHoldings } from "../domain/holdings";
import type { SplitEventRange } from "../providers/corporate-actions";
import { easternMarketDate } from "../shared/dates";
import {
  activeActionsByInstrument,
  transactionsByInstrument,
} from "./event-import-ledger";
import { proposedSplits } from "./event-import-snapshots";

interface FinalizerDependencies {
  db: D1Database;
  now?: () => Date;
  newId?: () => string;
}

interface BatchRow {
  id: string;
  base_position_basis_revision: number;
  failed_rows: number;
  status: string;
}

interface SymbolRow {
  resolved_instrument_id: string | null;
  resolved_symbol: string | null;
  split_snapshot_json: string | null;
}

interface FinalValidationRow {
  id: string;
  account_id: string;
  source_symbol: string;
  resolved_symbol: string;
  resolved_instrument_id: string | null;
  normalized_transaction_json: string;
  split_snapshot_json: string;
}

interface FinalNormalizedRow {
  tradeDate: string;
  side: "buy" | "sell";
  quantityDecimal: string;
}

const finishWithError = async (
  db: D1Database,
  batchId: string,
  status: "complete_with_errors" | "terminal",
  code: string,
  message: string,
  now: string,
): Promise<void> => {
  await db
    .prepare(
      `UPDATE import_batches
          SET status = ?1, terminal_error_code = ?2,
              terminal_error_message = ?3, completed_at = ?4,
              processing_lease_until = NULL, processing_lease_token = NULL,
              updated_at = ?4
        WHERE id = ?5 AND status IN ('pending', 'running')`,
    )
    .bind(status, code, message, now, batchId)
    .run();
};

export class EventImportFinalizer {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly dependencies: FinalizerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
  }

  async finalize(batchId: string): Promise<void> {
    const batch = await this.dependencies.db
      .prepare(
        `SELECT id, base_position_basis_revision, failed_rows, status
           FROM import_batches WHERE id = ?1`,
      )
      .bind(batchId)
      .first<BatchRow>();
    if (!batch || !["pending", "running"].includes(batch.status)) return;
    const timestamp = this.now().toISOString();
    const today = easternMarketDate(timestamp);
    if (batch.failed_rows > 0) {
      await finishWithError(
        this.dependencies.db,
        batchId,
        "complete_with_errors",
        "import_validation_failed",
        "One or more rows failed validation.",
        timestamp,
      );
      return;
    }

    if (!(await this.validateAccounts(batchId, timestamp))) {
      await finishWithError(
        this.dependencies.db,
        batchId,
        "complete_with_errors",
        "import_validation_failed",
        "One or more accounts are no longer available.",
        timestamp,
      );
      return;
    }

    const symbols = await this.dependencies.db
      .prepare(
        `SELECT resolved_instrument_id, resolved_symbol, split_snapshot_json
           FROM import_symbols
          WHERE import_batch_id = ?1 AND state = 'complete'
          ORDER BY source_symbol`,
      )
      .bind(batchId)
      .all<SymbolRow>();
    const snapshots = symbols.results.flatMap((row) => {
      if (!row.resolved_symbol || !row.split_snapshot_json) return [];
      try {
        return [
          {
            instrumentId: row.resolved_instrument_id ?? row.resolved_symbol,
            snapshot: JSON.parse(row.split_snapshot_json) as SplitEventRange,
          },
        ];
      } catch {
        return [];
      }
    });
    if (snapshots.length !== symbols.results.length) {
      await finishWithError(
        this.dependencies.db,
        batchId,
        "terminal",
        "invalid_provider_snapshot",
        "Stored provider data could not be finalized.",
        timestamp,
      );
      return;
    }
    if (!(await this.validateHoldings(batchId, today, timestamp))) {
      await finishWithError(
        this.dependencies.db,
        batchId,
        "complete_with_errors",
        "import_validation_failed",
        "The imported history would create negative holdings.",
        timestamp,
      );
      return;
    }

    const intervals = snapshots.map(({ instrumentId, snapshot }) => ({
      instrumentId,
      startDate: snapshot.range.requestedStartDate,
      endDate: snapshot.range.requestedEndDate,
    }));
    const jobId = this.newId();
    const workId = this.newId();
    const mutationId = this.newId();
    const jobs = new PipelineJobRepository(this.dependencies.db);
    const workItems = new WorkItemRepository(this.dependencies.db);
    const revisions = new FactRevisionBucketRepository(this.dependencies.db);
    const statements: D1PreparedStatement[] = [
      this.dependencies.db
        .prepare(
          `INSERT INTO ledger_mutations
           (id, expected_revision, resulting_revision, mutation_kind, created_at)
           VALUES (?1,
             CASE WHEN EXISTS (
               SELECT 1 FROM import_batches
                WHERE id = ?2 AND status = 'running'
                  AND base_position_basis_revision = ?3
             ) THEN ?3 ELSE NULL END,
             ?3 + 1, 'import_commit', ?4)`,
        )
        .bind(
          mutationId,
          batchId,
          batch.base_position_basis_revision,
          timestamp,
        ),
      this.dependencies.db
        .prepare(
          `INSERT OR IGNORE INTO instruments
           (id, symbol, company_name, exchange, currency, instrument_type,
            security_type, provider, provider_symbol, provider_metadata_json,
            created_at, updated_at)
           SELECT COALESCE(resolved_instrument_id, resolved_symbol),
                  resolved_symbol,
                  json_extract(instrument_metadata_json, '$.companyName'),
                  json_extract(instrument_metadata_json, '$.exchange'),
                  json_extract(instrument_metadata_json, '$.currency'),
                  CASE WHEN json_extract(instrument_metadata_json, '$.instrumentType') = 'etf'
                       THEN 'etf' ELSE 'stock' END,
                  json_extract(instrument_metadata_json, '$.instrumentType'),
                  'yahoo', provider_symbol, instrument_metadata_json, ?2, ?2
             FROM import_symbols
            WHERE import_batch_id = ?1 AND state = 'complete'
              AND resolved_symbol IS NOT NULL
              AND instrument_metadata_json IS NOT NULL`,
        )
        .bind(batchId, timestamp),
      this.dependencies.db
        .prepare(
          `UPDATE corporate_actions
              SET status = 'superseded', updated_at = ?2
            WHERE status = 'active' AND EXISTS (
              SELECT 1
                FROM import_symbols staged
                JOIN instruments ON instruments.symbol = staged.resolved_symbol
               WHERE staged.import_batch_id = ?1 AND staged.state = 'complete'
                 AND corporate_actions.instrument_id = instruments.id
                 AND corporate_actions.provider = json_extract(staged.split_snapshot_json, '$.range.provider')
                 AND corporate_actions.effective_date BETWEEN
                     json_extract(staged.split_snapshot_json, '$.range.requestedStartDate') AND
                     json_extract(staged.split_snapshot_json, '$.range.requestedEndDate')
            )`,
        )
        .bind(batchId, timestamp),
      this.dependencies.db
        .prepare(
          `INSERT INTO corporate_action_coverage
           (instrument_id, provider, requested_start_date, requested_end_date,
            snapshot_provider_revision, retrieved_at, confirmed_start_date,
            confirmed_end_date, confirmed_provider_revision, confirmed_at,
            status, error_code, error_message, updated_at)
           SELECT instruments.id,
                  json_extract(staged.split_snapshot_json, '$.range.provider'),
                  json_extract(staged.split_snapshot_json, '$.range.requestedStartDate'),
                  json_extract(staged.split_snapshot_json, '$.range.requestedEndDate'),
                  json_extract(staged.split_snapshot_json, '$.range.providerRevision'),
                  json_extract(staged.split_snapshot_json, '$.range.observedAt'),
                  json_extract(staged.split_snapshot_json, '$.range.requestedStartDate'),
                  json_extract(staged.split_snapshot_json, '$.range.requestedEndDate'),
                  json_extract(staged.split_snapshot_json, '$.range.providerRevision'),
                  ?2, 'confirmed', NULL, NULL, ?2
             FROM import_symbols staged
             JOIN instruments ON instruments.symbol = staged.resolved_symbol
            WHERE staged.import_batch_id = ?1 AND staged.state = 'complete'
           ON CONFLICT(instrument_id, provider) DO UPDATE SET
             requested_start_date = excluded.requested_start_date,
             requested_end_date = excluded.requested_end_date,
             snapshot_provider_revision = excluded.snapshot_provider_revision,
             retrieved_at = excluded.retrieved_at,
             confirmed_start_date = excluded.confirmed_start_date,
             confirmed_end_date = excluded.confirmed_end_date,
             confirmed_provider_revision = excluded.confirmed_provider_revision,
             confirmed_at = excluded.confirmed_at, status = 'confirmed',
             error_code = NULL, error_message = NULL, updated_at = excluded.updated_at`,
        )
        .bind(batchId, timestamp),
      this.dependencies.db
        .prepare(
          `INSERT OR IGNORE INTO corporate_actions
           (id, instrument_id, action_type, effective_date, split_numerator,
            split_denominator, provider, provider_event_id, provider_revision,
            retrieved_at, revision, status, conflict_code, conflict_message,
            created_at, updated_at)
           SELECT staged.id || ':' || json_extract(event.value, '$.providerEventId') ||
                  '@' || json_extract(event.value, '$.providerRevision'),
                  instruments.id, 'split',
                  json_extract(event.value, '$.effectiveDate'),
                  json_extract(event.value, '$.numerator'),
                  json_extract(event.value, '$.denominator'),
                  json_extract(event.value, '$.provider'),
                  json_extract(event.value, '$.providerEventId'),
                  json_extract(event.value, '$.providerRevision'),
                  json_extract(staged.split_snapshot_json, '$.range.observedAt'),
                  1, 'candidate', NULL, NULL, ?2, ?2
             FROM import_symbols staged
             JOIN instruments ON instruments.symbol = staged.resolved_symbol
             JOIN json_each(staged.split_snapshot_json, '$.events') event
            WHERE staged.import_batch_id = ?1 AND staged.state = 'complete'`,
        )
        .bind(batchId, timestamp),
      this.dependencies.db
        .prepare(
          `UPDATE corporate_actions
              SET status = 'active', conflict_code = NULL,
                  conflict_message = NULL, updated_at = ?2
            WHERE EXISTS (
              SELECT 1 FROM import_symbols staged
              JOIN instruments ON instruments.symbol = staged.resolved_symbol
              JOIN json_each(staged.split_snapshot_json, '$.events') event
               WHERE staged.import_batch_id = ?1 AND staged.state = 'complete'
                 AND corporate_actions.instrument_id = instruments.id
                 AND corporate_actions.provider = json_extract(event.value, '$.provider')
                 AND corporate_actions.provider_event_id = json_extract(event.value, '$.providerEventId')
                 AND corporate_actions.provider_revision = json_extract(event.value, '$.providerRevision')
            )`,
        )
        .bind(batchId, timestamp),
      this.dependencies.db
        .prepare(
          `INSERT INTO transactions
           (id, instrument_id, account_id, trade_date, side, quantity_decimal,
            price_decimal, revision, created_at, updated_at)
           SELECT ?1 || ':' || rows.row_number, instruments.id, rows.account_id,
                  json_extract(rows.normalized_transaction_json, '$.tradeDate'),
                  json_extract(rows.normalized_transaction_json, '$.side'),
                  json_extract(rows.normalized_transaction_json, '$.quantityDecimal'),
                  json_extract(rows.normalized_transaction_json, '$.priceDecimal'),
                  1, ?2, ?2
             FROM import_rows rows
             JOIN import_symbols staged
               ON staged.import_batch_id = rows.import_batch_id
              AND staged.source_symbol = rows.symbol
             JOIN instruments ON instruments.symbol = staged.resolved_symbol
            WHERE rows.import_batch_id = ?1 AND rows.status = 'valid'
              AND staged.state = 'complete'`,
        )
        .bind(batchId, timestamp),
      this.dependencies.db
        .prepare(
          `INSERT INTO tickers
           (id, symbol, company_name, exchange, currency, active, deleted_at,
            created_at, updated_at, security_type)
           SELECT instruments.id, instruments.symbol, instruments.company_name,
                  instruments.exchange, instruments.currency, 1, NULL, ?2, ?2,
                  instruments.security_type
             FROM import_symbols staged
             JOIN instruments ON instruments.symbol = staged.resolved_symbol
            WHERE staged.import_batch_id = ?1 AND staged.state = 'complete'
              AND staged.has_nonzero_holdings = 1
           ON CONFLICT(symbol) DO UPDATE SET active = 1, deleted_at = NULL,
             company_name = excluded.company_name, exchange = excluded.exchange,
             currency = excluded.currency, security_type = excluded.security_type,
             updated_at = excluded.updated_at`,
        )
        .bind(batchId, timestamp),
      jobs.createStatement({
        id: jobId,
        triggerType: "ledger_reconciliation",
        requestedStartDate:
          intervals.map((entry) => entry.startDate).sort()[0] ?? null,
        requestedEndDate:
          intervals
            .map((entry) => entry.endDate)
            .sort()
            .at(-1) ?? null,
        affectedInstrumentsJson: JSON.stringify(
          intervals.map((entry) => entry.instrumentId),
        ),
        eligibilityIntervalsJson: JSON.stringify(intervals),
        priority: 100,
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      workItems.createPlanningStatement({
        id: workId,
        pipelineJobId: jobId,
        workType: "ledger_reconciliation_plan",
        deterministicKey: `job:${jobId}:ledger-reconciliation-plan`,
        priority: 100,
        maxAttempts: RESUMABLE_PLANNING_MAX_ATTEMPTS,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      workItems.linkToJobStatement({
        pipelineJobId: jobId,
        workItemId: workId,
        relationship: "required",
        createdAt: timestamp,
      }),
      this.dependencies.db
        .prepare(
          `UPDATE import_batches
              SET status = 'committed', result_pipeline_job_id = ?2,
                  committed_at = ?3, completed_at = ?3, updated_at = ?3,
                  processing_lease_until = NULL, processing_lease_token = NULL
            WHERE id = ?1 AND status = 'running'
              AND base_position_basis_revision = ?4`,
        )
        .bind(batchId, jobId, timestamp, batch.base_position_basis_revision),
    ];
    if (intervals.length > 0) {
      statements.push(
        revisions.bumpRangesStatement(intervals, timestamp),
        revisions.bumpLatestForRangesStatement(intervals, timestamp, today),
      );
    }

    try {
      await this.dependencies.db.batch(statements);
    } catch (error) {
      const conflict = String(error).includes("ledger_conflict");
      await finishWithError(
        this.dependencies.db,
        batchId,
        "terminal",
        conflict ? "ledger_conflict" : "import_commit_failed",
        conflict
          ? "The portfolio changed while the import was running."
          : "The import could not be committed atomically.",
        timestamp,
      );
    }
  }

  private async validateAccounts(
    batchId: string,
    timestamp: string,
  ): Promise<boolean> {
    const invalid = await this.dependencies.db
      .prepare(
        `SELECT COUNT(*) AS count
           FROM import_rows rows
          WHERE rows.import_batch_id = ?1 AND rows.status = 'valid'
            AND NOT EXISTS (
              SELECT 1 FROM accounts
              JOIN account_categories
                ON account_categories.id = accounts.category_id
               WHERE accounts.id = rows.account_id
                 AND accounts.archived_at IS NULL
                 AND account_categories.archived_at IS NULL
            )`,
      )
      .bind(batchId)
      .first<{ count: number }>();
    if ((invalid?.count ?? 0) === 0) return true;

    await this.dependencies.db.batch([
      this.dependencies.db
        .prepare(
          `UPDATE import_rows
              SET status = 'invalid',
                  validation_errors_json = json_array('unknown_account'),
                  normalized_transaction_json = NULL
            WHERE import_batch_id = ?1 AND status = 'valid'
              AND NOT EXISTS (
                SELECT 1 FROM accounts
                JOIN account_categories
                  ON account_categories.id = accounts.category_id
                 WHERE accounts.id = import_rows.account_id
                   AND accounts.archived_at IS NULL
                   AND account_categories.archived_at IS NULL
              )`,
        )
        .bind(batchId),
      this.dependencies.db
        .prepare(
          `UPDATE import_batches SET failed_rows = (
             SELECT COUNT(*) FROM import_rows
              WHERE import_batch_id = ?1 AND status = 'invalid'
           ), updated_at = ?2 WHERE id = ?1`,
        )
        .bind(batchId, timestamp),
    ]);
    return false;
  }

  private async validateHoldings(
    batchId: string,
    today: string,
    timestamp: string,
  ): Promise<boolean> {
    const staged = await this.dependencies.db
      .prepare(
        `SELECT rows.id, rows.account_id, staged.source_symbol,
                staged.resolved_symbol, staged.resolved_instrument_id,
                rows.normalized_transaction_json, staged.split_snapshot_json
           FROM import_rows rows
           JOIN import_symbols staged
             ON staged.import_batch_id = rows.import_batch_id
            AND staged.source_symbol = rows.symbol
          WHERE rows.import_batch_id = ?1 AND rows.status = 'valid'
            AND staged.state = 'complete'
          ORDER BY staged.resolved_symbol, rows.account_id, rows.row_number`,
      )
      .bind(batchId)
      .all<FinalValidationRow>();
    const bySymbol = new Map<string, FinalValidationRow[]>();
    for (const row of staged.results) {
      const group = bySymbol.get(row.resolved_symbol) ?? [];
      group.push(row);
      bySymbol.set(row.resolved_symbol, group);
    }
    const instrumentIds = [
      ...new Set(
        staged.results.flatMap((row) =>
          row.resolved_instrument_id ? [row.resolved_instrument_id] : [],
        ),
      ),
    ];
    const [existingTransactions, activeActions] = await Promise.all([
      transactionsByInstrument(this.dependencies.db, instrumentIds),
      activeActionsByInstrument(this.dependencies.db, instrumentIds),
    ]);
    const projections: Array<{
      symbol: string;
      holdings: Array<{ accountId: string; quantityDecimal: string }>;
      hasNonzero: boolean;
    }> = [];
    for (const [symbol, rows] of bySymbol) {
      const first = rows[0];
      if (!first) continue;
      let snapshot: SplitEventRange;
      try {
        const candidates = rows.map(
          (row) => JSON.parse(row.split_snapshot_json) as SplitEventRange,
        );
        snapshot = candidates.sort((left, right) =>
          left.range.requestedStartDate.localeCompare(
            right.range.requestedStartDate,
          ),
        )[0] as SplitEventRange;
      } catch {
        await this.invalidateRows(
          batchId,
          symbol,
          null,
          "invalid_staged_row",
          timestamp,
        );
        return false;
      }
      const accountIds = [...new Set(rows.map((row) => row.account_id))];
      const holdings: Array<{ accountId: string; quantityDecimal: string }> =
        [];
      for (const accountId of accountIds) {
        try {
          const imported = rows
            .filter((row) => row.account_id === accountId)
            .map((row) => {
              const value = JSON.parse(
                row.normalized_transaction_json,
              ) as FinalNormalizedRow;
              return {
                id: `import:${row.id}`,
                tradeDate: value.tradeDate,
                side: value.side,
                quantityDecimal: value.quantityDecimal,
              };
            });
          const instrumentId = first.resolved_instrument_id;
          const quantity = deriveHoldings({
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
          holdings.push({ accountId, quantityDecimal: quantity });
        } catch {
          await this.invalidateRows(
            batchId,
            symbol,
            accountId,
            "negative_holdings",
            timestamp,
          );
          return false;
        }
      }
      projections.push({
        symbol,
        holdings,
        hasNonzero: holdings.some((entry) => entry.quantityDecimal !== "0"),
      });
    }
    if (projections.length > 0) {
      await this.dependencies.db
        .prepare(
          `UPDATE import_symbols
              SET projected_holdings_json = json_extract(source.value, '$.holdingsJson'),
                  has_nonzero_holdings = json_extract(source.value, '$.hasNonzero'),
                  updated_at = ?2
             FROM json_each(?1) source
            WHERE import_symbols.import_batch_id = ?3
              AND import_symbols.resolved_symbol = json_extract(source.value, '$.symbol')`,
        )
        .bind(
          JSON.stringify(
            projections.map((entry) => ({
              symbol: entry.symbol,
              holdingsJson: JSON.stringify(entry.holdings),
              hasNonzero: entry.hasNonzero ? 1 : 0,
            })),
          ),
          timestamp,
          batchId,
        )
        .run();
    }
    return true;
  }

  private async invalidateRows(
    batchId: string,
    resolvedSymbol: string,
    accountId: string | null,
    code: string,
    timestamp: string,
  ): Promise<void> {
    await this.dependencies.db.batch([
      this.dependencies.db
        .prepare(
          `UPDATE import_rows SET status = 'invalid',
                  validation_errors_json = json_array(?1),
                  normalized_transaction_json = NULL
            WHERE import_batch_id = ?2 AND status = 'valid'
              AND (?3 IS NULL OR account_id = ?3)
              AND symbol IN (
                SELECT source_symbol FROM import_symbols
                 WHERE import_batch_id = ?2 AND resolved_symbol = ?4
              )`,
        )
        .bind(code, batchId, accountId, resolvedSymbol),
      this.dependencies.db
        .prepare(
          `UPDATE import_batches SET failed_rows = (
             SELECT COUNT(*) FROM import_rows
              WHERE import_batch_id = ?1 AND status = 'invalid'
           ), updated_at = ?2 WHERE id = ?1`,
        )
        .bind(batchId, timestamp),
    ]);
  }
}
