import {
  type CorporateActionRecord,
  CorporateActionRepository,
  type CoverageRecord,
} from "../db/corporate-actions";
import {
  type ImportBatchRecord,
  ImportRepository,
  type ImportRowRecord,
} from "../db/imports";
import { type InstrumentRecord, InstrumentRepository } from "../db/instruments";
import { PipelineJobRepository } from "../db/pipeline-jobs";
import { PositionBasisRepository } from "../db/position-basis";
import { WorkItemRepository } from "../db/work-items";
import { canonicalizeDecimal, INPUT_DECIMAL_BOUNDS } from "../domain/decimal";
import {
  type ActiveSplit,
  deriveHoldings,
  type LedgerTransaction,
} from "../domain/holdings";
import type {
  CorporateActionProvider,
  SplitEventRange,
} from "../providers/corporate-actions";

const HEADER = "trade_date,symbol,side,quantity,price";
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 10_000;
const MAX_CURRENT_POSITIONS = 100;
const PREVIEW_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const STAGING_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const PLANNING_WORK_TYPE = "ledger_reconciliation_plan";

type Side = "buy" | "sell";

interface NormalizedImportTransaction {
  instrumentId: string;
  symbol: string;
  tradeDate: string;
  side: Side;
  quantityDecimal: string;
  priceDecimal: string;
  snapshot: {
    provider: string;
    requestedStartDate: string;
    requestedEndDate: string;
    providerRevision: string;
  };
}

interface StagedRow {
  id: string;
  rowNumber: number;
  symbol: string;
  tradeDate: string | null;
  side: Side | null;
  quantityDecimal: string | null;
  priceDecimal: string | null;
  status: "valid" | "invalid";
  validationErrorsJson: string | null;
  normalizedTransactionJson: string | null;
}

interface BatchRow extends ImportBatchRecord {
  rows: StagedRow[];
}

export interface ImportPreviewRow {
  rowNumber: number;
  symbol: string;
  tradeDate: string | null;
  side: Side | null;
  quantityDecimal: string | null;
  priceDecimal: string | null;
  status: "valid" | "invalid";
  errors: string[];
}

export interface ImportSplitReview {
  instrumentId: string;
  symbol: string;
  requestedStartDate: string;
  requestedEndDate: string;
  provider: string;
  providerRevision: string;
  snapshot: SplitEventRange;
}

export type ImportPreviewResult =
  | {
      kind: "preview";
      batchId: string;
      basePositionBasisRevision: number;
      rows: ImportPreviewRow[];
      reviews: ImportSplitReview[];
      projectedHoldings: Record<string, string>;
      expiresAt: string;
    }
  | { kind: "invalid_file"; code: string }
  | { kind: "duplicate"; batchId: string; status: string }
  | { kind: "provider_unavailable"; code: string };

export interface ImportConfirmation {
  instrumentId: string;
  requestedStartDate: string;
  requestedEndDate: string;
  providerRevision: string;
}

export type ImportCommitResult =
  | { kind: "committed"; pipelineJobId: string; positionBasisRevision: number }
  | { kind: "review_required"; reviews: ImportSplitReview[] }
  | { kind: "provider_unavailable"; code: string }
  | { kind: "validation_error"; code: string }
  | { kind: "conflict"; code: "ledger_conflict" }
  | { kind: "expired" }
  | { kind: "not_found" };

export interface EventImportsServiceDependencies {
  db: D1Database;
  corporateActionProvider: CorporateActionProvider;
  now?: () => Date;
  newId?: () => string;
}

const toActiveSplit = (action: CorporateActionRecord): ActiveSplit => ({
  id: action.id,
  effectiveDate: action.effectiveDate,
  numerator: action.splitNumerator,
  denominator: action.splitDenominator,
});

const toLedgerTransaction = (
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

const isIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T12:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
};

const hexDigest = async (bytes: Uint8Array): Promise<string> =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        ) as ArrayBuffer,
      ),
    ),
  )
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

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

const providerErrorCode = (error: unknown): string => {
  const message =
    error instanceof Error ? error.message : "provider_unavailable";
  return message.startsWith("provider_") ? message : "provider_unavailable";
};

const coverageMatches = (
  coverage: CoverageRecord | null,
  snapshot: SplitEventRange,
): boolean =>
  coverage?.status === "confirmed" &&
  coverage.requestedStartDate === snapshot.range.requestedStartDate &&
  coverage.requestedEndDate === snapshot.range.requestedEndDate &&
  coverage.snapshotProviderRevision === snapshot.range.providerRevision &&
  coverage.confirmedStartDate === snapshot.range.requestedStartDate &&
  coverage.confirmedEndDate === snapshot.range.requestedEndDate &&
  coverage.confirmedProviderRevision === snapshot.range.providerRevision &&
  coverage.confirmedAt !== null;

const confirmationMatches = (
  confirmation: ImportConfirmation | undefined,
  snapshot: SplitEventRange,
): boolean =>
  confirmation?.requestedStartDate === snapshot.range.requestedStartDate &&
  confirmation.requestedEndDate === snapshot.range.requestedEndDate &&
  confirmation.providerRevision === snapshot.range.providerRevision;

const parseCsv = (text: string): string[][] | null => {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let quoteClosed = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          quoteClosed = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (quoteClosed) {
      if (character === ",") {
        row.push(field);
        field = "";
        quoteClosed = false;
      } else if (character === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        quoteClosed = false;
      } else if (character === "\r" && text[index + 1] === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
        quoteClosed = false;
        index += 1;
      } else {
        return null;
      }
      continue;
    }
    if (character === '"') {
      if (field.length !== 0) return null;
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) return null;
  if (field.length > 0 || row.length > 0) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
};

export class EventImportsService {
  private readonly actions: CorporateActionRepository;
  private readonly imports: ImportRepository;
  private readonly instruments: InstrumentRepository;
  private readonly jobs: PipelineJobRepository;
  private readonly positionBasis: PositionBasisRepository;
  private readonly workItems: WorkItemRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly dependencies: EventImportsServiceDependencies) {
    this.actions = new CorporateActionRepository(dependencies.db);
    this.imports = new ImportRepository(dependencies.db);
    this.instruments = new InstrumentRepository(dependencies.db);
    this.jobs = new PipelineJobRepository(dependencies.db);
    this.positionBasis = new PositionBasisRepository(dependencies.db);
    this.workItems = new WorkItemRepository(dependencies.db);
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
  }

  async cleanup(): Promise<void> {
    const now = this.now();
    const sevenDaysAgo = new Date(
      now.valueOf() - STAGING_RETENTION_MS,
    ).toISOString();
    await this.dependencies.db.batch([
      this.dependencies.db
        .prepare(
          `UPDATE import_batches SET status = 'expired', updated_at = ?1
           WHERE status = 'preview' AND expires_at <= ?1`,
        )
        .bind(now.toISOString()),
      this.dependencies.db
        .prepare(
          `DELETE FROM import_rows WHERE import_batch_id IN (
             SELECT id FROM import_batches
             WHERE created_at <= ?1 AND status <> 'preview'
           )`,
        )
        .bind(sevenDaysAgo),
    ]);
  }

  async preview(input: {
    originalFilename: string;
    file: Uint8Array;
  }): Promise<ImportPreviewResult> {
    await this.cleanup();
    if (!input.originalFilename || input.originalFilename.length > 255)
      return { kind: "invalid_file", code: "invalid_filename" };
    if (input.file.byteLength === 0 || input.file.byteLength > MAX_FILE_BYTES)
      return { kind: "invalid_file", code: "file_too_large" };

    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input.file);
    } catch {
      return { kind: "invalid_file", code: "invalid_utf8" };
    }
    const parsed = parseCsv(text.replace(/^\uFEFF/, ""));
    if (!parsed || parsed.length === 0 || parsed[0]?.join(",") !== HEADER)
      return { kind: "invalid_file", code: "invalid_header" };
    const sourceRows = parsed
      .slice(1)
      .filter((row) => row.some((cell) => cell.trim() !== ""));
    if (sourceRows.length > MAX_ROWS)
      return { kind: "invalid_file", code: "too_many_rows" };

    const digest = await hexDigest(input.file);
    const duplicate = await this.imports.findBatchByDigest(digest);
    if (duplicate)
      return {
        kind: "duplicate",
        batchId: duplicate.id,
        status: duplicate.status,
      };

    const timestamp = this.now().toISOString();
    const today = timestamp.slice(0, 10);
    const preliminary = await Promise.all(
      sourceRows.map((row, index) => this.normalizeRow(row, index + 2, today)),
    );

    const validByInstrument = new Map<
      string,
      { instrument: InstrumentRecord; rows: PendingRow[] }
    >();
    for (const row of preliminary) {
      if (!row.normalized || !row.instrument) continue;
      const current = validByInstrument.get(row.instrument.id) ?? {
        instrument: row.instrument,
        rows: [],
      };
      current.rows.push(row.normalized);
      validByInstrument.set(row.instrument.id, current);
    }

    const snapshots = new Map<string, SplitEventRange>();
    for (const [instrumentId, group] of validByInstrument) {
      const existing = await this.transactionsForInstrument(instrumentId);
      const startDate = [
        ...existing.map((row) => row.tradeDate),
        ...group.rows.map((row) => row.tradeDate),
      ].sort((left, right) => left.localeCompare(right))[0];
      if (!startDate) continue;
      let snapshot: SplitEventRange;
      try {
        snapshot = await this.dependencies.corporateActionProvider.getSplits(
          group.instrument.providerSymbol,
          startDate,
          today,
        );
      } catch (error) {
        return { kind: "provider_unavailable", code: providerErrorCode(error) };
      }
      if (
        snapshot.symbol !== group.instrument.providerSymbol.toUpperCase() ||
        snapshot.range.requestedStartDate !== startDate ||
        snapshot.range.requestedEndDate !== today
      ) {
        return {
          kind: "provider_unavailable",
          code: "provider_snapshot_mismatch",
        };
      }
      snapshots.set(instrumentId, snapshot);
      for (const row of group.rows) row.snapshot = snapshot;
    }

    const projectedHoldings: Record<string, string> = {};
    for (const [instrumentId, group] of validByInstrument) {
      const actions = (
        await this.actions.listForInstrument(instrumentId)
      ).filter((action) => action.status === "active");
      const snapshot = snapshots.get(instrumentId);
      if (!snapshot) continue;
      try {
        const holdings = deriveHoldings({
          today,
          transactions: [
            ...(await this.transactionsForInstrument(instrumentId)).map(
              (row) => ({
                id: row.id,
                tradeDate: row.tradeDate,
                side: row.side,
                quantityDecimal: row.quantityDecimal,
              }),
            ),
            ...group.rows.map(toLedgerTransaction),
          ],
          activeSplits: actions.map(toActiveSplit),
        });
        projectedHoldings[group.instrument.symbol] = holdings.currentQuantity();
      } catch {
        for (const row of group.rows) row.errors.push("negative_holdings");
      }
    }

    const batchId = this.newId();
    const basePositionBasisRevision = await this.positionBasis.revision();
    const expiresAt = new Date(
      this.now().valueOf() + PREVIEW_LIFETIME_MS,
    ).toISOString();
    const rows = preliminary.map((row) => this.toImportRow(batchId, row));
    const batch: ImportBatchRecord = {
      id: batchId,
      fileDigest: digest,
      originalFilename: input.originalFilename,
      basePositionBasisRevision,
      projectedHoldingsJson: JSON.stringify(projectedHoldings),
      status: "preview",
      resultPipelineJobId: null,
      expiresAt,
      committedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    try {
      await this.dependencies.db.batch([
        this.imports.createBatchStatement(batch),
        ...rows.map((row) => this.imports.createRowStatement(row)),
      ]);
    } catch (error) {
      if (
        String(error).includes(
          "UNIQUE constraint failed: import_batches.file_digest",
        )
      ) {
        const existing = await this.imports.findBatchByDigest(digest);
        if (existing)
          return {
            kind: "duplicate",
            batchId: existing.id,
            status: existing.status,
          };
      }
      throw error;
    }

    const reviews: ImportSplitReview[] = [];
    for (const [instrumentId, snapshot] of snapshots) {
      const coverage = await this.coverageFor(
        instrumentId,
        snapshot.range.provider,
      );
      if (!coverageMatches(coverage, snapshot)) {
        const instrument = validByInstrument.get(instrumentId)?.instrument;
        if (instrument) reviews.push(this.reviewFor(instrument, snapshot));
      }
    }
    return {
      kind: "preview",
      batchId,
      basePositionBasisRevision,
      rows: rows.map((row) => this.toPreviewRow(row)),
      reviews,
      projectedHoldings,
      expiresAt,
    };
  }

  async commit(input: {
    batchId: string;
    expectedPositionBasisRevision: number;
    confirmations: ImportConfirmation[];
  }): Promise<ImportCommitResult> {
    await this.cleanup();
    if (
      !Number.isInteger(input.expectedPositionBasisRevision) ||
      input.expectedPositionBasisRevision < 0
    )
      return {
        kind: "validation_error",
        code: "invalid_position_basis_revision",
      };
    const batch = await this.batch(input.batchId);
    if (!batch) return { kind: "not_found" };
    if (
      batch.status === "expired" ||
      batch.expiresAt <= this.now().toISOString()
    )
      return { kind: "expired" };
    if (batch.status !== "preview")
      return { kind: "validation_error", code: "import_not_preview" };
    if (batch.basePositionBasisRevision !== input.expectedPositionBasisRevision)
      return { kind: "conflict", code: "ledger_conflict" };
    if (
      batch.rows.length === 0 ||
      batch.rows.some(
        (row) => row.status !== "valid" || !row.normalizedTransactionJson,
      )
    )
      return { kind: "validation_error", code: "invalid_import_rows" };
    const currentRevision = await this.positionBasis.revision();
    if (currentRevision !== input.expectedPositionBasisRevision)
      return { kind: "conflict", code: "ledger_conflict" };

    const normalized = this.normalizedRows(batch.rows);
    if (!normalized)
      return { kind: "validation_error", code: "invalid_import_rows" };
    const byInstrument = new Map<string, NormalizedImportTransaction[]>();
    for (const row of normalized) {
      const group = byInstrument.get(row.instrumentId) ?? [];
      group.push(row);
      byInstrument.set(row.instrumentId, group);
    }
    const confirmations = new Map(
      input.confirmations.map((entry) => [entry.instrumentId, entry]),
    );
    if (confirmations.size !== input.confirmations.length)
      return { kind: "validation_error", code: "duplicate_confirmation" };

    const refreshed: {
      instrument: InstrumentRecord;
      snapshot: SplitEventRange;
    }[] = [];
    for (const [instrumentId, group] of byInstrument) {
      const instrument = await this.instruments.findById(instrumentId);
      if (!instrument)
        return { kind: "validation_error", code: "instrument_not_found" };
      const staged = group[0]?.snapshot;
      if (!staged)
        return { kind: "validation_error", code: "invalid_import_rows" };
      let snapshot: SplitEventRange;
      try {
        snapshot = await this.dependencies.corporateActionProvider.getSplits(
          instrument.providerSymbol,
          staged.requestedStartDate,
          staged.requestedEndDate,
        );
      } catch (error) {
        return { kind: "provider_unavailable", code: providerErrorCode(error) };
      }
      if (
        snapshot.symbol !== instrument.providerSymbol.toUpperCase() ||
        snapshot.range.provider !== staged.provider ||
        snapshot.range.requestedStartDate !== staged.requestedStartDate ||
        snapshot.range.requestedEndDate !== staged.requestedEndDate ||
        snapshot.range.providerRevision !== staged.providerRevision
      ) {
        return {
          kind: "review_required",
          reviews: [this.reviewFor(instrument, snapshot)],
        };
      }
      const coverage = await this.coverageFor(
        instrumentId,
        snapshot.range.provider,
      );
      if (
        !coverageMatches(coverage, snapshot) &&
        !confirmationMatches(confirmations.get(instrumentId), snapshot)
      ) {
        return {
          kind: "review_required",
          reviews: [this.reviewFor(instrument, snapshot)],
        };
      }
      try {
        await this.assertProjectedHoldings(
          instrumentId,
          group,
          snapshot,
          this.now().toISOString().slice(0, 10),
        );
      } catch {
        return { kind: "validation_error", code: "negative_holdings" };
      }
      refreshed.push({ instrument, snapshot });
    }

    if (
      !(await this.withinPositionLimit(
        byInstrument,
        refreshed,
        this.now().toISOString().slice(0, 10),
      ))
    ) {
      return { kind: "validation_error", code: "position_limit" };
    }

    const timestamp = this.now().toISOString();
    const jobId = this.newId();
    const workId = this.newId();
    const mutationId = this.newId();
    const allIntervals = refreshed.flatMap(({ instrument, snapshot }) => [
      {
        instrumentId: instrument.id,
        startDate: snapshot.range.requestedStartDate,
        endDate: snapshot.range.requestedEndDate,
      },
    ]);
    const statements: D1PreparedStatement[] = [
      this.importMutationTokenStatement({
        id: mutationId,
        batchId: batch.id,
        expectedRevision: input.expectedPositionBasisRevision,
        createdAt: timestamp,
      }),
      ...refreshed.flatMap(({ instrument, snapshot }) =>
        this.snapshotStatements(instrument, snapshot, timestamp),
      ),
      this.dependencies.db
        .prepare(
          `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
          revision, created_at, updated_at)
         SELECT ?1 || ':' || import_rows.row_number,
                json_extract(import_rows.normalized_transaction_json, '$.instrumentId'),
                json_extract(import_rows.normalized_transaction_json, '$.tradeDate'),
                json_extract(import_rows.normalized_transaction_json, '$.side'),
                json_extract(import_rows.normalized_transaction_json, '$.quantityDecimal'),
                json_extract(import_rows.normalized_transaction_json, '$.priceDecimal'),
                1, ?2, ?2
         FROM import_rows JOIN import_batches ON import_batches.id = import_rows.import_batch_id
         WHERE import_rows.import_batch_id = ?1
           AND import_rows.status = 'valid'
           AND import_batches.status = 'preview'
           AND import_batches.base_position_basis_revision = ?3
           AND import_batches.expires_at > ?4`,
        )
        .bind(
          batch.id,
          timestamp,
          input.expectedPositionBasisRevision,
          timestamp,
        ),
      this.jobs.createStatement({
        id: jobId,
        triggerType: "ledger_reconciliation",
        requestedStartDate:
          allIntervals.map((entry) => entry.startDate).sort()[0] ?? null,
        requestedEndDate:
          allIntervals
            .map((entry) => entry.endDate)
            .sort()
            .at(-1) ?? null,
        affectedInstrumentsJson: JSON.stringify(
          refreshed.map(({ instrument }) => instrument.id),
        ),
        eligibilityIntervalsJson: JSON.stringify(allIntervals),
        priority: 100,
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      this.workItems.createPlanningStatement({
        id: workId,
        pipelineJobId: jobId,
        workType: PLANNING_WORK_TYPE,
        deterministicKey: `job:${jobId}:ledger-reconciliation-plan`,
        priority: 100,
        maxAttempts: 3,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      this.workItems.linkToJobStatement({
        pipelineJobId: jobId,
        workItemId: workId,
        relationship: "required",
        createdAt: timestamp,
      }),
      this.dependencies.db
        .prepare(
          `UPDATE import_batches
         SET status = 'committed', result_pipeline_job_id = ?2, committed_at = ?3, updated_at = ?3
         WHERE id = ?1 AND status = 'preview' AND base_position_basis_revision = ?4
           AND expires_at > ?3`,
        )
        .bind(batch.id, jobId, timestamp, input.expectedPositionBasisRevision),
    ];
    try {
      await this.dependencies.db.batch(statements);
    } catch (error) {
      const afterFailure = await this.batch(batch.id);
      if (afterFailure && afterFailure.expiresAt <= this.now().toISOString())
        return { kind: "expired" };
      if (String(error).includes("ledger_conflict"))
        return { kind: "conflict", code: "ledger_conflict" };
      return { kind: "validation_error", code: "import_commit_failed" };
    }
    return {
      kind: "committed",
      pipelineJobId: jobId,
      positionBasisRevision: input.expectedPositionBasisRevision + 1,
    };
  }

  private async normalizeRow(
    values: string[],
    rowNumber: number,
    today: string,
  ): Promise<PreliminaryRow> {
    const errors: string[] = [];
    if (values.length !== 5)
      return {
        rowNumber,
        symbol: "",
        tradeDate: null,
        side: null,
        quantityDecimal: null,
        priceDecimal: null,
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
    ] = values.map((value) => value.trim());
    const symbol = symbolInput.toUpperCase();
    const tradeDate = dateInput;
    const side = sideInput.toLowerCase() as Side;
    if (!/^[A-Z0-9.^-]{1,32}$/.test(symbol)) errors.push("invalid_symbol");
    if (!isIsoDate(tradeDate) || tradeDate > today)
      errors.push("invalid_trade_date");
    if (side !== "buy" && side !== "sell") errors.push("invalid_side");
    let quantityDecimal: string | null = null;
    let priceDecimal: string | null = null;
    try {
      quantityDecimal = canonicalizeDecimal(
        quantityInput,
        INPUT_DECIMAL_BOUNDS,
      );
      if (quantityDecimal === "0" || quantityDecimal.startsWith("-"))
        errors.push("invalid_quantity");
    } catch {
      errors.push("invalid_quantity");
    }
    try {
      priceDecimal = canonicalizeDecimal(priceInput, INPUT_DECIMAL_BOUNDS);
      if (priceDecimal === "0" || priceDecimal.startsWith("-"))
        errors.push("invalid_price");
    } catch {
      errors.push("invalid_price");
    }
    const instrument =
      errors.length === 0 ? await this.instruments.findBySymbol(symbol) : null;
    if (errors.length === 0 && !instrument) errors.push("unknown_symbol");
    const normalized =
      errors.length === 0 && instrument && quantityDecimal && priceDecimal
        ? {
            instrumentId: instrument.id,
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
      errors,
      normalized,
      instrument,
    };
  }

  private toImportRow(batchId: string, row: PreliminaryRow): ImportRowRecord {
    const valid = !!row.normalized && row.errors.length === 0;
    const normalized = valid
      ? this.asNormalized(row.normalized as PendingRow)
      : null;
    return {
      id: this.newId(),
      importBatchId: batchId,
      rowNumber: row.rowNumber,
      symbol: row.symbol || "INVALID",
      tradeDate: row.tradeDate,
      side: row.side,
      quantityDecimal: row.quantityDecimal,
      priceDecimal: row.priceDecimal,
      status: valid ? "valid" : "invalid",
      validationErrorsJson: valid ? null : JSON.stringify(row.errors),
      normalizedTransactionJson: normalized ? JSON.stringify(normalized) : null,
    };
  }

  private asNormalized(row: PendingRow): NormalizedImportTransaction {
    if (!row.snapshot) throw new Error("missing_preview_snapshot");
    return {
      instrumentId: row.instrumentId,
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
  }

  private toPreviewRow(row: ImportRowRecord): ImportPreviewRow {
    return {
      rowNumber: row.rowNumber,
      symbol: row.symbol,
      tradeDate: row.tradeDate,
      side: row.side,
      quantityDecimal: row.quantityDecimal,
      priceDecimal: row.priceDecimal,
      status: row.status,
      errors: errorList(row.validationErrorsJson),
    };
  }

  private async transactionsForInstrument(
    instrumentId: string,
  ): Promise<LedgerTransaction[]> {
    const result = await this.dependencies.db
      .prepare(
        `SELECT id, trade_date, side, quantity_decimal FROM transactions
       WHERE instrument_id = ?1 ORDER BY trade_date, id`,
      )
      .bind(instrumentId)
      .all<{
        id: string;
        trade_date: string;
        side: Side;
        quantity_decimal: string;
      }>();
    return result.results.map((row) => ({
      id: row.id,
      tradeDate: row.trade_date,
      side: row.side,
      quantityDecimal: row.quantity_decimal,
    }));
  }

  private async coverageFor(
    instrumentId: string,
    provider: string,
  ): Promise<CoverageRecord | null> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT instrument_id, provider, requested_start_date, requested_end_date,
              snapshot_provider_revision, retrieved_at, confirmed_start_date,
              confirmed_end_date, confirmed_provider_revision, confirmed_at,
              status, error_code, error_message, updated_at
       FROM corporate_action_coverage WHERE instrument_id = ?1 AND provider = ?2`,
      )
      .bind(instrumentId, provider)
      .first<Record<string, string | null>>();
    if (!row) return null;
    return {
      instrumentId: row.instrument_id as string,
      provider: row.provider as string,
      requestedStartDate: row.requested_start_date ?? "",
      requestedEndDate: row.requested_end_date ?? "",
      snapshotProviderRevision: row.snapshot_provider_revision ?? null,
      retrievedAt: row.retrieved_at ?? null,
      confirmedStartDate: row.confirmed_start_date ?? null,
      confirmedEndDate: row.confirmed_end_date ?? null,
      confirmedProviderRevision: row.confirmed_provider_revision ?? null,
      confirmedAt: row.confirmed_at ?? null,
      status: row.status as CoverageRecord["status"],
      errorCode: row.error_code ?? null,
      errorMessage: row.error_message ?? null,
      updatedAt: row.updated_at ?? "",
    };
  }

  private reviewFor(
    instrument: InstrumentRecord,
    snapshot: SplitEventRange,
  ): ImportSplitReview {
    return {
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      requestedStartDate: snapshot.range.requestedStartDate,
      requestedEndDate: snapshot.range.requestedEndDate,
      provider: snapshot.range.provider,
      providerRevision: snapshot.range.providerRevision,
      snapshot,
    };
  }

  private async batch(id: string): Promise<BatchRow | null> {
    const batch = await this.dependencies.db
      .prepare("SELECT * FROM import_batches WHERE id = ?1")
      .bind(id)
      .first<{
        id: string;
        file_digest: string;
        original_filename: string;
        base_position_basis_revision: number;
        projected_holdings_json: string | null;
        status: ImportBatchRecord["status"];
        result_pipeline_job_id: string | null;
        expires_at: string;
        committed_at: string | null;
        created_at: string;
        updated_at: string;
      }>();
    if (!batch) return null;
    const rows = await this.dependencies.db
      .prepare(
        `SELECT id, row_number, symbol, trade_date, side, quantity_decimal, price_decimal,
              status, validation_errors_json, normalized_transaction_json
       FROM import_rows WHERE import_batch_id = ?1 ORDER BY row_number`,
      )
      .bind(id)
      .all<{
        id: string;
        row_number: number;
        symbol: string;
        trade_date: string | null;
        side: Side | null;
        quantity_decimal: string | null;
        price_decimal: string | null;
        status: "valid" | "invalid";
        validation_errors_json: string | null;
        normalized_transaction_json: string | null;
      }>();
    return {
      id: batch.id,
      fileDigest: batch.file_digest,
      originalFilename: batch.original_filename,
      basePositionBasisRevision: batch.base_position_basis_revision,
      projectedHoldingsJson: batch.projected_holdings_json,
      status: batch.status,
      resultPipelineJobId: batch.result_pipeline_job_id,
      expiresAt: batch.expires_at,
      committedAt: batch.committed_at,
      createdAt: batch.created_at,
      updatedAt: batch.updated_at,
      rows: rows.results.map((row) => ({
        id: row.id,
        rowNumber: row.row_number,
        symbol: row.symbol,
        tradeDate: row.trade_date,
        side: row.side,
        quantityDecimal: row.quantity_decimal,
        priceDecimal: row.price_decimal,
        status: row.status,
        validationErrorsJson: row.validation_errors_json,
        normalizedTransactionJson: row.normalized_transaction_json,
      })),
    };
  }

  private normalizedRows(
    rows: StagedRow[],
  ): NormalizedImportTransaction[] | null {
    try {
      return rows.map((row) => {
        const parsed = JSON.parse(
          row.normalizedTransactionJson ?? "",
        ) as NormalizedImportTransaction;
        if (
          !parsed?.instrumentId ||
          !isIsoDate(parsed.tradeDate) ||
          (parsed.side !== "buy" && parsed.side !== "sell") ||
          !parsed.snapshot?.providerRevision
        )
          throw new Error("invalid");
        return parsed;
      });
    } catch {
      return null;
    }
  }

  private async assertProjectedHoldings(
    instrumentId: string,
    rows: NormalizedImportTransaction[],
    snapshot: SplitEventRange,
    today: string,
  ): Promise<void> {
    const active = (await this.actions.listForInstrument(instrumentId)).filter(
      (action) => action.status === "active",
    );
    deriveHoldings({
      today,
      transactions: [
        ...(await this.transactionsForInstrument(instrumentId)),
        ...rows.map(toLedgerTransaction),
      ],
      activeSplits: this.proposedSplits(active, snapshot),
    });
  }

  private importMutationTokenStatement(input: {
    id: string;
    batchId: string;
    expectedRevision: number;
    createdAt: string;
  }): D1PreparedStatement {
    return this.dependencies.db
      .prepare(
        `INSERT INTO ledger_mutations
         (id, expected_revision, resulting_revision, mutation_kind, created_at)
         VALUES (?1,
           CASE WHEN EXISTS (
             SELECT 1 FROM import_batches
             WHERE id = ?2 AND status = 'preview'
               AND base_position_basis_revision = ?3 AND expires_at > ?4
           ) THEN ?3 ELSE NULL END,
           ?3 + 1, 'import_commit', ?4)`,
      )
      .bind(input.id, input.batchId, input.expectedRevision, input.createdAt);
  }

  private async withinPositionLimit(
    imported: Map<string, NormalizedImportTransaction[]>,
    refreshed: { instrument: InstrumentRecord; snapshot: SplitEventRange }[],
    today: string,
  ): Promise<boolean> {
    const snapshots = new Map(
      refreshed.map(({ instrument, snapshot }) => [instrument.id, snapshot]),
    );
    const instruments = await this.dependencies.db
      .prepare("SELECT id FROM instruments ORDER BY id")
      .all<{ id: string }>();
    let currentPositions = 0;
    try {
      for (const { id } of instruments.results) {
        const actions = (await this.actions.listForInstrument(id)).filter(
          (action) => action.status === "active",
        );
        const snapshot = snapshots.get(id);
        const holdings = deriveHoldings({
          today,
          transactions: [
            ...(await this.transactionsForInstrument(id)),
            ...(imported.get(id) ?? []).map(toLedgerTransaction),
          ],
          activeSplits: snapshot
            ? this.proposedSplits(actions, snapshot)
            : actions.map(toActiveSplit),
        });
        if (holdings.currentQuantity() !== "0") currentPositions += 1;
        if (currentPositions > MAX_CURRENT_POSITIONS) return false;
      }
    } catch {
      return false;
    }
    return true;
  }

  private snapshotStatements(
    instrument: InstrumentRecord,
    snapshot: SplitEventRange,
    timestamp: string,
  ): D1PreparedStatement[] {
    const candidates = snapshot.events.map((event) =>
      this.dependencies.db
        .prepare(
          `INSERT OR IGNORE INTO corporate_actions
       (id, instrument_id, action_type, effective_date, split_numerator, split_denominator,
        provider, provider_event_id, provider_revision, retrieved_at, revision, status,
        conflict_code, conflict_message, created_at, updated_at)
       VALUES (?1, ?2, 'split', ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, 'candidate', NULL, NULL, ?10, ?10)`,
        )
        .bind(
          `${event.providerEventId}@${event.providerRevision}`,
          instrument.id,
          event.effectiveDate,
          event.numerator,
          event.denominator,
          event.provider,
          event.providerEventId,
          event.providerRevision,
          snapshot.range.observedAt,
          timestamp,
        ),
    );
    const promotions = snapshot.events.map((event) =>
      this.dependencies.db
        .prepare(
          `UPDATE corporate_actions
           SET status = 'active', conflict_code = NULL, conflict_message = NULL, updated_at = ?5
           WHERE instrument_id = ?1 AND provider = ?2 AND provider_event_id = ?3
             AND provider_revision = ?4 AND status = 'candidate'`,
        )
        .bind(
          instrument.id,
          snapshot.range.provider,
          event.providerEventId,
          event.providerRevision,
          timestamp,
        ),
    );
    return [
      ...candidates,
      this.dependencies.db
        .prepare(
          `UPDATE corporate_actions SET status = 'superseded', updated_at = ?4
         WHERE instrument_id = ?1 AND provider = ?2 AND status = 'active'
           AND effective_date >= ?3 AND effective_date <= ?5`,
        )
        .bind(
          instrument.id,
          snapshot.range.provider,
          snapshot.range.requestedStartDate,
          timestamp,
          snapshot.range.requestedEndDate,
        ),
      ...promotions,
      this.actions.upsertCoverageStatement({
        instrumentId: instrument.id,
        provider: snapshot.range.provider,
        requestedStartDate: snapshot.range.requestedStartDate,
        requestedEndDate: snapshot.range.requestedEndDate,
        snapshotProviderRevision: snapshot.range.providerRevision,
        retrievedAt: snapshot.range.observedAt,
        confirmedStartDate: snapshot.range.requestedStartDate,
        confirmedEndDate: snapshot.range.requestedEndDate,
        confirmedProviderRevision: snapshot.range.providerRevision,
        confirmedAt: timestamp,
        status: "confirmed",
        errorCode: null,
        errorMessage: null,
        updatedAt: timestamp,
      }),
    ];
  }

  private proposedSplits(
    actions: CorporateActionRecord[],
    snapshot: SplitEventRange,
  ): ActiveSplit[] {
    return [
      ...actions
        .filter(
          (action) =>
            action.provider !== snapshot.range.provider ||
            action.effectiveDate < snapshot.range.requestedStartDate ||
            action.effectiveDate > snapshot.range.requestedEndDate,
        )
        .map(toActiveSplit),
      ...snapshot.events.map((event) => ({
        id: `${event.providerEventId}@${event.providerRevision}`,
        effectiveDate: event.effectiveDate,
        numerator: event.numerator,
        denominator: event.denominator,
      })),
    ];
  }
}

interface PendingRow {
  instrumentId: string;
  symbol: string;
  tradeDate: string;
  side: Side;
  quantityDecimal: string;
  priceDecimal: string;
  errors: string[];
  snapshot?: SplitEventRange;
}

interface PreliminaryRow {
  rowNumber: number;
  symbol: string;
  tradeDate: string | null;
  side: Side | null;
  quantityDecimal: string | null;
  priceDecimal: string | null;
  errors: string[];
  normalized: PendingRow | null;
  instrument: InstrumentRecord | null;
}
