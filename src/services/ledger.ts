import {
  type CorporateActionRecord,
  CorporateActionRepository,
  type CoverageRecord,
} from "../db/corporate-actions";
import { InstrumentRepository } from "../db/instruments";
import { PipelineJobRepository } from "../db/pipeline-jobs";
import {
  type LedgerMutationKind,
  PositionBasisRepository,
} from "../db/position-basis";
import { FactRevisionBucketRepository } from "../db/revision-buckets";
import {
  type TransactionRecord,
  TransactionRepository,
} from "../db/transactions";
import {
  RESUMABLE_PLANNING_MAX_ATTEMPTS,
  WorkItemRepository,
} from "../db/work-items";
import { canonicalizeDecimal, INPUT_DECIMAL_BOUNDS } from "../domain/decimal";
import {
  type ActiveSplit,
  deriveHoldings,
  type LedgerTransaction,
} from "../domain/holdings";
import type {
  CorporateActionProvider,
  NormalizedSplitEvent,
  SplitEventRange,
} from "../providers/corporate-actions";
import { easternMarketDate } from "../shared/dates";

const PLANNING_WORK_TYPE = "ledger_reconciliation_plan";
const DEFAULT_SPLIT_PROVIDER = "yahoo-chart-v8";

type TransactionSide = "buy" | "sell";

export type LedgerProposal =
  | {
      kind: "create";
      instrumentId: string;
      /** Account owning the event. Omitted only for legacy clients. */
      accountId?: string;
      tradeDate: string;
      side: TransactionSide;
      quantityDecimal: string;
      priceDecimal: string;
    }
  | {
      kind: "update";
      eventId: string;
      expectedEventRevision: number;
      /** Moving an event between accounts is supported atomically. */
      accountId?: string;
      tradeDate: string;
      side: TransactionSide;
      quantityDecimal: string;
      priceDecimal: string;
    }
  | {
      kind: "delete";
      eventId: string;
      expectedEventRevision: number;
    };

export interface ApplyLedgerMutationInput {
  expectedPositionBasisRevision: number;
  proposal: LedgerProposal;
}

export type LedgerWarningCode =
  | "split_history_unavailable"
  | "split_history_conflict";

export interface RefreshSplitHistoryInput {
  expectedPositionBasisRevision: number;
  instrumentId: string;
  requestedStartDate: string;
}

export type LedgerMutationResult =
  | {
      kind: "committed";
      positionBasisRevision: number;
      pipelineJobId: string;
      transactionId: string | null;
      warningCode?: LedgerWarningCode;
    }
  | { kind: "candidate_conflict"; snapshot: SplitEventRange }
  | { kind: "provider_unavailable"; code: string }
  | { kind: "conflict"; code: "ledger_conflict" | "event_conflict" }
  | { kind: "validation_error"; code: string };

export interface LedgerServiceDependencies {
  db: D1Database;
  corporateActionProvider: CorporateActionProvider;
  now?: () => Date;
  newId?: () => string;
}

interface ResolvedProposal {
  instrumentId: string;
  before: TransactionRecord[];
  after: TransactionRecord[];
  existing: TransactionRecord | null;
  changedStartDate: string;
  transactionToWrite: TransactionRecord | null;
  mutationKind: LedgerMutationKind;
  /** Account used by the transaction mutation (source for delete). */
  accountId: string;
}

interface CoverageRow {
  instrument_id: string;
  provider: string;
  requested_start_date: string;
  requested_end_date: string;
  snapshot_provider_revision: string | null;
  retrieved_at: string | null;
  confirmed_start_date: string | null;
  confirmed_end_date: string | null;
  confirmed_provider_revision: string | null;
  confirmed_at: string | null;
  status: CoverageRecord["status"];
  error_code: string | null;
  error_message: string | null;
  updated_at: string;
}

const toCoverageRecord = (row: CoverageRow): CoverageRecord => ({
  instrumentId: row.instrument_id,
  provider: row.provider,
  requestedStartDate: row.requested_start_date,
  requestedEndDate: row.requested_end_date,
  snapshotProviderRevision: row.snapshot_provider_revision,
  retrievedAt: row.retrieved_at,
  confirmedStartDate: row.confirmed_start_date,
  confirmedEndDate: row.confirmed_end_date,
  confirmedProviderRevision: row.confirmed_provider_revision,
  confirmedAt: row.confirmed_at,
  status: row.status,
  errorCode: row.error_code,
  errorMessage: row.error_message,
  updatedAt: row.updated_at,
});

const toLedgerTransaction = (record: TransactionRecord): LedgerTransaction => ({
  id: record.id,
  tradeDate: record.tradeDate,
  side: record.side,
  quantityDecimal: record.quantityDecimal,
});

const toActiveSplit = (record: CorporateActionRecord): ActiveSplit => ({
  id: record.id,
  effectiveDate: record.effectiveDate,
  numerator: record.splitNumerator,
  denominator: record.splitDenominator,
});

const splitFromSnapshot = (event: NormalizedSplitEvent): ActiveSplit => ({
  id: `${event.providerEventId}@${event.providerRevision}`,
  effectiveDate: event.effectiveDate,
  numerator: event.numerator,
  denominator: event.denominator,
});

type HoldingsByAccount = Map<string, ReturnType<typeof deriveHoldings>>;

const accountKey = (record: TransactionRecord): string =>
  record.accountId ?? "account-default";

const transactionsByAccount = (
  records: readonly TransactionRecord[],
): Map<string, TransactionRecord[]> => {
  const grouped = new Map<string, TransactionRecord[]>();
  for (const record of records) {
    const accountId = accountKey(record);
    const rows = grouped.get(accountId) ?? [];
    rows.push(record);
    grouped.set(accountId, rows);
  }
  return grouped;
};

/**
 * Fold each account independently. A global fold can hide an invalid sale
 * when another account happens to own enough shares, so all mutation paths
 * use this helper before committing.
 */
const holdingsByAccount = (input: {
  today: string;
  transactions: readonly TransactionRecord[];
  activeSplits: readonly ActiveSplit[];
}): HoldingsByAccount => {
  const result: HoldingsByAccount = new Map();
  for (const [accountId, records] of transactionsByAccount(
    input.transactions,
  )) {
    result.set(
      accountId,
      deriveHoldings({
        today: input.today,
        transactions: records.map(toLedgerTransaction),
        activeSplits: input.activeSplits,
      }),
    );
  }
  return result;
};

const anyAccountEligible = (
  holdings: HoldingsByAccount,
  date: string,
): boolean => {
  for (const value of holdings.values()) {
    if (value.isEligibleForScreening(date)) return true;
  }
  return false;
};

const mergedHeldIntervals = (
  holdings: HoldingsByAccount,
  startDate: string,
  endDate: string,
): { startDate: string; endDate: string }[] => {
  const intervals = [...holdings.values()].flatMap((value) =>
    value.heldIntervals({ startDate, endDate }),
  );
  return intervals
    .sort(
      (left, right) =>
        left.startDate.localeCompare(right.startDate) ||
        left.endDate.localeCompare(right.endDate),
    )
    .reduce<{ startDate: string; endDate: string }[]>((merged, interval) => {
      const previous = merged.at(-1);
      if (!previous || interval.startDate > nextDate(previous.endDate)) {
        merged.push({ ...interval });
      } else if (interval.endDate > previous.endDate) {
        previous.endDate = interval.endDate;
      }
      return merged;
    }, []);
};

const minDate = (dates: readonly string[]): string | null =>
  dates.length === 0
    ? null
    : ([...dates].sort((left, right) => left.localeCompare(right))[0] ?? null);

const nextDate = (date: string): string => {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
};

function providerErrorCode(error: unknown): string {
  const message =
    error instanceof Error ? error.message : "provider_unavailable";
  return message.startsWith("provider_") ? message : "provider_unavailable";
}

/**
 * Performs the pre-batch fold and emits the complete guarded D1 batch for one
 * manual ledger mutation. Split rows are always supplied by the provider; the
 * confirmation payload can only identify a fetched snapshot.
 */
export class LedgerService {
  private readonly actions: CorporateActionRepository;
  private readonly instruments: InstrumentRepository;
  private readonly jobs: PipelineJobRepository;
  private readonly positionBasis: PositionBasisRepository;
  private readonly revisions: FactRevisionBucketRepository;
  private readonly transactions: TransactionRepository;
  private readonly workItems: WorkItemRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly dependencies: LedgerServiceDependencies) {
    this.actions = new CorporateActionRepository(dependencies.db);
    this.instruments = new InstrumentRepository(dependencies.db);
    this.jobs = new PipelineJobRepository(dependencies.db);
    this.positionBasis = new PositionBasisRepository(dependencies.db);
    this.revisions = new FactRevisionBucketRepository(dependencies.db);
    this.transactions = new TransactionRepository(dependencies.db);
    this.workItems = new WorkItemRepository(dependencies.db);
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
  }

  async apply(input: ApplyLedgerMutationInput): Promise<LedgerMutationResult> {
    if (
      !Number.isInteger(input.expectedPositionBasisRevision) ||
      input.expectedPositionBasisRevision < 0
    ) {
      return {
        kind: "validation_error",
        code: "invalid_position_basis_revision",
      };
    }

    const timestamp = this.now().toISOString();
    const today = easternMarketDate(timestamp);
    const resolved = await this.resolveProposal(input.proposal, timestamp);
    if ("kind" in resolved) return resolved;

    const instrument = await this.instruments.findById(resolved.instrumentId);
    if (!instrument)
      return { kind: "validation_error", code: "instrument_not_found" };

    const activeActions = (
      await this.actions.listForInstrument(resolved.instrumentId)
    ).filter((action) => action.status === "active");
    const activeSplits = activeActions.map(toActiveSplit);

    let beforeHoldings: HoldingsByAccount;
    let activeProposedHoldings: HoldingsByAccount;
    try {
      beforeHoldings = holdingsByAccount({
        today,
        transactions: resolved.before,
        activeSplits,
      });
      activeProposedHoldings = holdingsByAccount({
        today,
        transactions: resolved.after,
        activeSplits,
      });
    } catch {
      return { kind: "validation_error", code: "negative_holdings" };
    }

    if (instrument.instrumentType === "warrant") {
      return this.commitResolvedMutation({
        input,
        resolved,
        timestamp,
        today,
        beforeHoldings,
        proposedHoldings: activeProposedHoldings,
        targetSplits: activeSplits,
        splitStatements: [],
      });
    }

    let snapshot: SplitEventRange;
    try {
      snapshot = await this.dependencies.corporateActionProvider.getSplits(
        instrument.providerSymbol,
        resolved.changedStartDate,
        today,
      );
    } catch (error) {
      const coverage = await this.coverageFor(
        resolved.instrumentId,
        DEFAULT_SPLIT_PROVIDER,
      );
      return this.commitResolvedMutation({
        input,
        resolved,
        timestamp,
        today,
        beforeHoldings,
        proposedHoldings: activeProposedHoldings,
        targetSplits: activeSplits,
        splitStatements: [
          this.unavailableCoverageStatement({
            instrumentId: resolved.instrumentId,
            startDate: resolved.changedStartDate,
            endDate: today,
            timestamp,
            code: providerErrorCode(error),
            coverage,
          }),
        ],
        warningCode: "split_history_unavailable",
      });
    }
    if (
      snapshot.symbol !== instrument.providerSymbol.toUpperCase() ||
      snapshot.range.requestedStartDate !== resolved.changedStartDate ||
      snapshot.range.requestedEndDate !== today
    ) {
      const coverage = await this.coverageFor(
        resolved.instrumentId,
        DEFAULT_SPLIT_PROVIDER,
      );
      return this.commitResolvedMutation({
        input,
        resolved,
        timestamp,
        today,
        beforeHoldings,
        proposedHoldings: activeProposedHoldings,
        targetSplits: activeSplits,
        splitStatements: [
          this.unavailableCoverageStatement({
            instrumentId: resolved.instrumentId,
            startDate: resolved.changedStartDate,
            endDate: today,
            timestamp,
            code: "provider_snapshot_mismatch",
            coverage,
          }),
        ],
        warningCode: "split_history_unavailable",
      });
    }

    const coverage = await this.coverageFor(
      resolved.instrumentId,
      snapshot.range.provider,
    );
    const candidateSplits = this.proposedSplits(activeActions, snapshot);

    let proposedHoldings: HoldingsByAccount;
    try {
      proposedHoldings = holdingsByAccount({
        today,
        transactions: resolved.after,
        activeSplits: candidateSplits,
      });
    } catch {
      return this.commitResolvedMutation({
        input,
        resolved,
        timestamp,
        today,
        beforeHoldings,
        proposedHoldings: activeProposedHoldings,
        targetSplits: activeSplits,
        splitStatements: this.splitConflictStatements({
          instrumentId: resolved.instrumentId,
          snapshot,
          timestamp,
          coverage,
          today,
        }),
        warningCode: "split_history_conflict",
      });
    }

    return this.commitResolvedMutation({
      input,
      resolved,
      timestamp,
      today,
      beforeHoldings,
      proposedHoldings,
      targetSplits: candidateSplits,
      splitStatements: [
        ...this.candidateInsertStatements(
          resolved.instrumentId,
          snapshot,
          timestamp,
          "candidate",
          null,
        ),
        ...this.promotionStatements(resolved.instrumentId, snapshot, timestamp),
        ...(coverage
          ? [
              this.revisions.bumpRangeStatement(
                coverage.requestedStartDate,
                coverage.requestedEndDate,
                timestamp,
              ),
              this.revisions.bumpLatestForRangeStatement(
                coverage.requestedStartDate,
                coverage.requestedEndDate,
                timestamp,
                today,
              ),
            ]
          : []),
        this.actions.upsertCoverageStatement(
          this.coverageFromSnapshot({
            instrumentId: resolved.instrumentId,
            snapshot,
            timestamp,
            status: "confirmed",
          }),
        ),
      ],
    });
  }

  private async commitResolvedMutation(input: {
    input: ApplyLedgerMutationInput;
    resolved: ResolvedProposal;
    timestamp: string;
    today: string;
    beforeHoldings: HoldingsByAccount;
    proposedHoldings: HoldingsByAccount;
    targetSplits: readonly ActiveSplit[];
    splitStatements: D1PreparedStatement[];
    warningCode?: LedgerWarningCode;
  }): Promise<LedgerMutationResult> {
    const jobId = this.newId();
    const workId = this.newId();
    const mutationId = this.newId();
    const intervals = this.changedEligibilityIntervals(
      input.beforeHoldings,
      input.proposedHoldings,
      input.resolved.changedStartDate,
      input.today,
    );
    const statements = [
      this.mutationTokenStatement({
        id: mutationId,
        expectedRevision: input.input.expectedPositionBasisRevision,
        kind: input.resolved.mutationKind,
        createdAt: input.timestamp,
        eventGuard: input.resolved.existing,
      }),
      ...input.splitStatements,
      ...this.transactionStatements(input.resolved),
      ...this.reconciliationStatements({
        jobId,
        workId,
        instrumentId: input.resolved.instrumentId,
        startDate: input.resolved.changedStartDate,
        endDate: input.today,
        intervals,
        timestamp: input.timestamp,
      }),
      this.revisions.bumpRangeStatement(
        input.resolved.changedStartDate,
        input.today,
        input.timestamp,
      ),
      this.revisions.bumpLatestForRangeStatement(
        input.resolved.changedStartDate,
        input.today,
        input.timestamp,
        input.today,
      ),
    ];
    try {
      await this.dependencies.db.batch(statements);
    } catch (error) {
      return this.batchFailure(error);
    }

    return {
      kind: "committed",
      positionBasisRevision: input.input.expectedPositionBasisRevision + 1,
      pipelineJobId: jobId,
      transactionId: input.resolved.transactionToWrite?.id ?? null,
      ...(input.warningCode ? { warningCode: input.warningCode } : {}),
    };
  }

  /** Refreshes provider-owned split facts without rewriting transaction rows. */
  async refreshSplitHistory(
    input: RefreshSplitHistoryInput,
  ): Promise<LedgerMutationResult> {
    if (
      !Number.isInteger(input.expectedPositionBasisRevision) ||
      input.expectedPositionBasisRevision < 0
    ) {
      return {
        kind: "validation_error",
        code: "invalid_position_basis_revision",
      };
    }

    const timestamp = this.now().toISOString();
    const today = easternMarketDate(timestamp);
    const instrument = await this.instruments.findById(input.instrumentId);
    if (!instrument)
      return { kind: "validation_error", code: "instrument_not_found" };

    let snapshot: SplitEventRange;
    try {
      snapshot = await this.dependencies.corporateActionProvider.getSplits(
        instrument.providerSymbol,
        input.requestedStartDate,
        today,
      );
    } catch (error) {
      const coverage = await this.coverageFor(
        input.instrumentId,
        DEFAULT_SPLIT_PROVIDER,
      );
      await this.unavailableCoverageStatement({
        instrumentId: input.instrumentId,
        startDate: input.requestedStartDate,
        endDate: today,
        timestamp,
        code: providerErrorCode(error),
        coverage,
      }).run();
      return { kind: "provider_unavailable", code: providerErrorCode(error) };
    }
    const coverage = await this.coverageFor(
      input.instrumentId,
      snapshot.range.provider,
    );
    if (
      snapshot.symbol !== instrument.providerSymbol.toUpperCase() ||
      snapshot.range.requestedStartDate !== input.requestedStartDate ||
      snapshot.range.requestedEndDate !== today
    ) {
      return {
        kind: "provider_unavailable",
        code: "provider_snapshot_mismatch",
      };
    }

    const activeActions = (
      await this.actions.listForInstrument(input.instrumentId)
    ).filter((action) => action.status === "active");
    const transactions = await this.transactions.listForInstrument(
      input.instrumentId,
    );
    let beforeHoldings: HoldingsByAccount;
    let afterHoldings: HoldingsByAccount;
    try {
      beforeHoldings = holdingsByAccount({
        today,
        transactions,
        activeSplits: activeActions.map(toActiveSplit),
      });
      afterHoldings = holdingsByAccount({
        today,
        transactions,
        activeSplits: this.proposedSplits(activeActions, snapshot),
      });
    } catch {
      const mutationId = this.newId();
      try {
        await this.dependencies.db.batch([
          this.positionBasis.mutationTokenStatement({
            id: mutationId,
            expectedRevision: input.expectedPositionBasisRevision,
            kind: "action_quarantine",
            createdAt: timestamp,
          }),
          ...this.splitConflictStatements({
            instrumentId: input.instrumentId,
            snapshot,
            timestamp,
            coverage,
            today,
          }),
        ]);
      } catch (error) {
        return this.batchFailure(error);
      }
      return { kind: "candidate_conflict", snapshot };
    }

    const jobId = this.newId();
    const workId = this.newId();
    const mutationId = this.newId();
    const intervals = this.splitPromotionIntervals({
      beforeHoldings,
      afterHoldings,
      activeActions,
      snapshot,
      today,
    });
    const statements = [
      this.positionBasis.mutationTokenStatement({
        id: mutationId,
        expectedRevision: input.expectedPositionBasisRevision,
        kind: "action_confirmation",
        createdAt: timestamp,
      }),
      ...this.candidateInsertStatements(
        input.instrumentId,
        snapshot,
        timestamp,
        "candidate",
        null,
      ),
      ...this.promotionStatements(input.instrumentId, snapshot, timestamp),
      ...(coverage
        ? [
            this.revisions.bumpRangeStatement(
              coverage.requestedStartDate,
              coverage.requestedEndDate,
              timestamp,
            ),
            this.revisions.bumpLatestForRangeStatement(
              coverage.requestedStartDate,
              coverage.requestedEndDate,
              timestamp,
              today,
            ),
          ]
        : []),
      this.actions.upsertCoverageStatement(
        this.coverageFromSnapshot({
          instrumentId: input.instrumentId,
          snapshot,
          timestamp,
          status: "confirmed",
        }),
      ),
      ...this.reconciliationStatements({
        jobId,
        workId,
        instrumentId: input.instrumentId,
        startDate: snapshot.range.requestedStartDate,
        endDate: snapshot.range.requestedEndDate,
        intervals,
        timestamp,
      }),
      this.revisions.bumpRangeStatement(
        snapshot.range.requestedStartDate,
        snapshot.range.requestedEndDate,
        timestamp,
      ),
      this.revisions.bumpLatestForRangeStatement(
        snapshot.range.requestedStartDate,
        snapshot.range.requestedEndDate,
        timestamp,
        today,
      ),
    ];
    try {
      await this.dependencies.db.batch(statements);
    } catch (error) {
      return this.batchFailure(error);
    }
    return {
      kind: "committed",
      positionBasisRevision: input.expectedPositionBasisRevision + 1,
      pipelineJobId: jobId,
      transactionId: null,
    };
  }

  private async resolveProposal(
    proposal: LedgerProposal,
    timestamp: string,
  ): Promise<ResolvedProposal | LedgerMutationResult> {
    if (proposal.kind === "create") {
      const before = await this.transactions.listForInstrument(
        proposal.instrumentId,
      );
      const accountId = await this.resolveAccountId(proposal.accountId);
      if (!accountId)
        return { kind: "validation_error", code: "account_not_found" };
      const record = this.newTransaction({
        id: this.newId(),
        instrumentId: proposal.instrumentId,
        accountId,
        proposal,
        timestamp,
      });
      if (!record)
        return { kind: "validation_error", code: "invalid_transaction" };
      return {
        instrumentId: proposal.instrumentId,
        before,
        after: [...before, record],
        existing: null,
        changedStartDate:
          minDate([...before.map((row) => row.tradeDate), record.tradeDate]) ??
          record.tradeDate,
        transactionToWrite: record,
        mutationKind: "transaction_create",
        accountId,
      };
    }

    const existing = await this.transactionById(proposal.eventId);
    if (!existing) return { kind: "conflict", code: "event_conflict" };
    if (existing.revision !== proposal.expectedEventRevision) {
      return { kind: "conflict", code: "event_conflict" };
    }
    const before = await this.transactions.listForInstrument(
      existing.instrumentId,
    );
    const accountId = await this.resolveAccountId(
      proposal.kind === "update" ? proposal.accountId : existing.accountId,
      existing,
    );
    if (!accountId)
      return { kind: "validation_error", code: "account_not_found" };
    if (proposal.kind === "delete") {
      return {
        instrumentId: existing.instrumentId,
        before,
        after: before.filter((row) => row.id !== existing.id),
        existing,
        changedStartDate:
          minDate(before.map((row) => row.tradeDate)) ?? existing.tradeDate,
        transactionToWrite: null,
        mutationKind: "transaction_delete",
        accountId: existing.accountId ?? accountId,
      };
    }
    const updated = this.newTransaction({
      id: existing.id,
      instrumentId: existing.instrumentId,
      accountId,
      proposal,
      timestamp,
      revision: existing.revision,
      createdAt: existing.createdAt,
    });
    if (!updated)
      return { kind: "validation_error", code: "invalid_transaction" };
    return {
      instrumentId: existing.instrumentId,
      before,
      after: before.map((row) => (row.id === existing.id ? updated : row)),
      existing,
      changedStartDate:
        minDate([...before.map((row) => row.tradeDate), updated.tradeDate]) ??
        updated.tradeDate,
      transactionToWrite: updated,
      mutationKind: "transaction_update",
      accountId,
    };
  }

  private newTransaction(input: {
    id: string;
    instrumentId: string;
    accountId: string;
    proposal: Exclude<LedgerProposal, { kind: "delete" }>;
    timestamp: string;
    revision?: number;
    createdAt?: string;
  }): TransactionRecord | null {
    try {
      const quantityDecimal = canonicalizeDecimal(
        input.proposal.quantityDecimal,
        INPUT_DECIMAL_BOUNDS,
      );
      const priceDecimal = canonicalizeDecimal(
        input.proposal.priceDecimal,
        INPUT_DECIMAL_BOUNDS,
      );
      if (
        quantityDecimal === "0" ||
        quantityDecimal.startsWith("-") ||
        priceDecimal.startsWith("-")
      ) {
        return null;
      }
      return {
        id: input.id,
        instrumentId: input.instrumentId,
        accountId: input.accountId,
        tradeDate: input.proposal.tradeDate,
        side: input.proposal.side,
        quantityDecimal,
        priceDecimal,
        revision: input.revision ?? 1,
        createdAt: input.createdAt ?? input.timestamp,
        updatedAt: input.timestamp,
      };
    } catch {
      return null;
    }
  }

  private async transactionById(id: string): Promise<TransactionRecord | null> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT id, instrument_id, trade_date, side, quantity_decimal,
              price_decimal, account_id, revision, created_at, updated_at
       FROM transactions WHERE id = ?1`,
      )
      .bind(id)
      .first<{
        id: string;
        instrument_id: string;
        trade_date: string;
        side: TransactionSide;
        quantity_decimal: string;
        price_decimal: string;
        account_id: string | null;
        revision: number;
        created_at: string;
        updated_at: string;
      }>();
    return row
      ? {
          id: row.id,
          instrumentId: row.instrument_id,
          accountId: row.account_id ?? "account-default",
          tradeDate: row.trade_date,
          side: row.side,
          quantityDecimal: row.quantity_decimal,
          priceDecimal: row.price_decimal,
          revision: row.revision,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : null;
  }

  /**
   * Resolve and validate an account at mutation time. The default account is
   * retained for clients that predate account selection, while explicit IDs
   * must be active so archived accounts cannot receive new events.
   */
  private async resolveAccountId(
    requested: string | undefined,
    existing?: TransactionRecord,
  ): Promise<string | null> {
    const fallback = existing?.accountId ?? "account-default";
    const accountId = requested?.trim() || fallback;
    const row = await this.dependencies.db
      .prepare(
        `SELECT id FROM accounts
         WHERE id = ?1 AND (archived_at IS NULL OR id = ?2)`,
      )
      .bind(accountId, existing?.id ? fallback : "__no_fallback__")
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  private async coverageFor(
    instrumentId: string,
    provider: string,
  ): Promise<CoverageRecord | null> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT * FROM corporate_action_coverage
       WHERE instrument_id = ?1 AND provider = ?2`,
      )
      .bind(instrumentId, provider)
      .first<CoverageRow>();
    return row ? toCoverageRecord(row) : null;
  }

  private proposedSplits(
    active: readonly CorporateActionRecord[],
    snapshot: SplitEventRange,
  ): ActiveSplit[] {
    return [
      ...active
        .filter(
          (action) =>
            action.provider !== snapshot.range.provider ||
            !this.isWithinSnapshotRange(action.effectiveDate, snapshot),
        )
        .map(toActiveSplit),
      ...snapshot.events.map(splitFromSnapshot),
    ];
  }

  private isWithinSnapshotRange(
    effectiveDate: string,
    snapshot: SplitEventRange,
  ): boolean {
    return (
      effectiveDate >= snapshot.range.requestedStartDate &&
      effectiveDate <= snapshot.range.requestedEndDate
    );
  }

  private coverageFromSnapshot(input: {
    instrumentId: string;
    snapshot: SplitEventRange;
    timestamp: string;
    status: CoverageRecord["status"];
    errorCode?: string | null;
    errorMessage?: string | null;
  }): CoverageRecord {
    const confirmed = input.status === "confirmed";
    return {
      instrumentId: input.instrumentId,
      provider: input.snapshot.range.provider,
      requestedStartDate: input.snapshot.range.requestedStartDate,
      requestedEndDate: input.snapshot.range.requestedEndDate,
      snapshotProviderRevision: input.snapshot.range.providerRevision,
      retrievedAt: input.snapshot.range.observedAt,
      confirmedStartDate: confirmed
        ? input.snapshot.range.requestedStartDate
        : null,
      confirmedEndDate: confirmed
        ? input.snapshot.range.requestedEndDate
        : null,
      confirmedProviderRevision: confirmed
        ? input.snapshot.range.providerRevision
        : null,
      confirmedAt: confirmed ? input.timestamp : null,
      status: input.status,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      updatedAt: input.timestamp,
    };
  }

  private unavailableCoverageStatement(input: {
    instrumentId: string;
    startDate: string;
    endDate: string;
    timestamp: string;
    code: string;
    coverage: CoverageRecord | null;
  }): D1PreparedStatement {
    return this.actions.upsertCoverageStatement({
      instrumentId: input.instrumentId,
      provider: input.coverage?.provider ?? DEFAULT_SPLIT_PROVIDER,
      requestedStartDate: input.startDate,
      requestedEndDate: input.endDate,
      snapshotProviderRevision:
        input.coverage?.snapshotProviderRevision ?? null,
      retrievedAt: input.coverage?.retrievedAt ?? null,
      confirmedStartDate: input.coverage?.confirmedStartDate ?? null,
      confirmedEndDate: input.coverage?.confirmedEndDate ?? null,
      confirmedProviderRevision:
        input.coverage?.confirmedProviderRevision ?? null,
      confirmedAt: input.coverage?.confirmedAt ?? null,
      status: "unavailable",
      errorCode: input.code,
      errorMessage: "Split history will be retried automatically.",
      updatedAt: input.timestamp,
    });
  }

  private splitConflictStatements(input: {
    instrumentId: string;
    snapshot: SplitEventRange;
    timestamp: string;
    coverage: CoverageRecord | null;
    today: string;
  }): D1PreparedStatement[] {
    return [
      ...this.candidateInsertStatements(
        input.instrumentId,
        input.snapshot,
        input.timestamp,
        "quarantined",
        "negative_history",
      ),
      ...input.snapshot.events.map((event) =>
        this.dependencies.db
          .prepare(
            `UPDATE corporate_actions
                SET status = 'quarantined', conflict_code = 'negative_history',
                    conflict_message = 'candidate split would create negative historical holdings',
                    updated_at = ?1
              WHERE instrument_id = ?2 AND provider = ?3
                AND provider_event_id = ?4 AND provider_revision = ?5`,
          )
          .bind(
            input.timestamp,
            input.instrumentId,
            event.provider,
            event.providerEventId,
            event.providerRevision,
          ),
      ),
      ...(input.coverage
        ? [
            this.revisions.bumpRangeStatement(
              input.coverage.requestedStartDate,
              input.coverage.requestedEndDate,
              input.timestamp,
            ),
            this.revisions.bumpLatestForRangeStatement(
              input.coverage.requestedStartDate,
              input.coverage.requestedEndDate,
              input.timestamp,
              input.today,
            ),
          ]
        : []),
      this.actions.upsertCoverageStatement(
        this.coverageFromSnapshot({
          instrumentId: input.instrumentId,
          snapshot: input.snapshot,
          timestamp: input.timestamp,
          status: "conflict",
          errorCode: "negative_history",
          errorMessage:
            "candidate split would create negative historical holdings",
        }),
      ),
    ];
  }

  private candidateInsertStatements(
    instrumentId: string,
    snapshot: SplitEventRange,
    timestamp: string,
    status: "candidate" | "quarantined",
    conflict: string | null,
  ): D1PreparedStatement[] {
    return snapshot.events.map((event) =>
      this.dependencies.db
        .prepare(
          `INSERT OR IGNORE INTO corporate_actions
       (id, instrument_id, action_type, effective_date, split_numerator,
        split_denominator, provider, provider_event_id, provider_revision,
        retrieved_at, revision, status, conflict_code, conflict_message,
        created_at, updated_at)
       VALUES (?1, ?2, 'split', ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?11, ?12, ?13, ?13)`,
        )
        .bind(
          this.newId(),
          instrumentId,
          event.effectiveDate,
          event.numerator,
          event.denominator,
          event.provider,
          event.providerEventId,
          event.providerRevision,
          snapshot.range.observedAt,
          status,
          conflict,
          conflict
            ? "candidate split would create negative historical holdings"
            : null,
          timestamp,
        ),
    );
  }

  private promotionStatements(
    instrumentId: string,
    snapshot: SplitEventRange,
    timestamp: string,
  ): D1PreparedStatement[] {
    const statements: D1PreparedStatement[] = [
      this.dependencies.db
        .prepare(
          `UPDATE corporate_actions SET status = 'superseded', updated_at = ?1
       WHERE instrument_id = ?2 AND provider = ?3 AND status = 'active'
             AND effective_date >= ?4 AND effective_date <= ?5`,
        )
        .bind(
          timestamp,
          instrumentId,
          snapshot.range.provider,
          snapshot.range.requestedStartDate,
          snapshot.range.requestedEndDate,
        ),
    ];
    for (const event of snapshot.events) {
      statements.push(
        this.dependencies.db
          .prepare(
            `UPDATE corporate_actions
         SET status = 'active', conflict_code = NULL, conflict_message = NULL,
             updated_at = ?1
         WHERE instrument_id = ?2 AND provider = ?3 AND provider_event_id = ?4
               AND provider_revision = ?5`,
          )
          .bind(
            timestamp,
            instrumentId,
            event.provider,
            event.providerEventId,
            event.providerRevision,
          ),
      );
    }
    return statements;
  }

  private transactionStatements(
    resolved: ResolvedProposal,
  ): D1PreparedStatement[] {
    if (
      resolved.mutationKind === "transaction_create" &&
      resolved.transactionToWrite
    ) {
      return [this.transactions.insertStatement(resolved.transactionToWrite)];
    }
    if (
      resolved.mutationKind === "transaction_update" &&
      resolved.transactionToWrite &&
      resolved.existing
    ) {
      return [
        this.transactions.updateStatement(
          resolved.transactionToWrite,
          resolved.existing.revision,
        ),
      ];
    }
    if (resolved.mutationKind === "transaction_delete" && resolved.existing) {
      return [
        this.transactions.deleteStatement(
          resolved.existing.id,
          resolved.existing.revision,
        ),
      ];
    }
    return [];
  }

  private mutationTokenStatement(input: {
    id: string;
    expectedRevision: number;
    kind: LedgerMutationKind;
    createdAt: string;
    eventGuard: TransactionRecord | null;
  }): D1PreparedStatement {
    if (!input.eventGuard)
      return this.positionBasis.mutationTokenStatement({
        id: input.id,
        expectedRevision: input.expectedRevision,
        kind: input.kind,
        createdAt: input.createdAt,
      });
    return this.dependencies.db
      .prepare(
        `INSERT INTO ledger_mutations
       (id, expected_revision, resulting_revision, mutation_kind, created_at)
       VALUES (?1,
         CASE WHEN EXISTS (
           SELECT 1 FROM transactions WHERE id = ?5 AND revision = ?6
         ) THEN ?2 ELSE NULL END,
         CASE WHEN EXISTS (
           SELECT 1 FROM transactions WHERE id = ?5 AND revision = ?6
         ) THEN ?2 + 1 ELSE NULL END,
         ?3, ?4)`,
      )
      .bind(
        input.id,
        input.expectedRevision,
        input.kind,
        input.createdAt,
        input.eventGuard.id,
        input.eventGuard.revision,
      );
  }

  private reconciliationStatements(input: {
    jobId: string;
    workId: string;
    instrumentId: string;
    startDate: string;
    endDate: string;
    intervals: readonly { startDate: string; endDate: string }[];
    timestamp: string;
  }): D1PreparedStatement[] {
    return [
      this.jobs.createStatement({
        id: input.jobId,
        triggerType: "ledger_reconciliation",
        requestedStartDate: input.startDate,
        requestedEndDate: input.endDate,
        affectedInstrumentsJson: JSON.stringify([input.instrumentId]),
        eligibilityIntervalsJson: JSON.stringify(input.intervals),
        priority: 100,
        status: "pending",
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      }),
      this.workItems.createPlanningStatement({
        id: input.workId,
        pipelineJobId: input.jobId,
        workType: PLANNING_WORK_TYPE,
        deterministicKey: `job:${input.jobId}:ledger-reconciliation-plan`,
        priority: 100,
        maxAttempts: RESUMABLE_PLANNING_MAX_ATTEMPTS,
        createdAt: input.timestamp,
        updatedAt: input.timestamp,
      }),
      this.workItems.linkToJobStatement({
        pipelineJobId: input.jobId,
        workItemId: input.workId,
        relationship: "required",
        createdAt: input.timestamp,
      }),
    ];
  }

  private changedEligibilityIntervals(
    before: HoldingsByAccount,
    after: HoldingsByAccount,
    startDate: string,
    today: string,
  ): { startDate: string; endDate: string }[] {
    const intervals: { startDate: string; endDate: string }[] = [];
    let intervalStart: string | null = null;
    for (let date = startDate; date <= today; date = nextDate(date)) {
      const changed =
        anyAccountEligible(before, date) !== anyAccountEligible(after, date);
      if (changed && !intervalStart) intervalStart = date;
      if (!changed && intervalStart) {
        const endDate = new Date(`${date}T12:00:00.000Z`);
        endDate.setUTCDate(endDate.getUTCDate() - 1);
        intervals.push({
          startDate: intervalStart,
          endDate: endDate.toISOString().slice(0, 10),
        });
        intervalStart = null;
      }
    }
    if (intervalStart)
      intervals.push({ startDate: intervalStart, endDate: today });
    return intervals;
  }

  private splitPromotionIntervals(input: {
    beforeHoldings: HoldingsByAccount;
    afterHoldings: HoldingsByAccount;
    activeActions: readonly CorporateActionRecord[];
    snapshot: SplitEventRange;
    today: string;
  }): { startDate: string; endDate: string }[] {
    const activeInRange = input.activeActions.filter(
      (action) =>
        action.provider === input.snapshot.range.provider &&
        this.isWithinSnapshotRange(action.effectiveDate, input.snapshot),
    );
    const activeByIdentity = new Map(
      activeInRange.map((action) => [
        `${action.providerEventId}@${action.providerRevision}`,
        action,
      ]),
    );
    const snapshotByIdentity = new Map(
      input.snapshot.events.map((event) => [
        `${event.providerEventId}@${event.providerRevision}`,
        event,
      ]),
    );
    const changedDates = new Set<string>();
    for (const event of input.snapshot.events) {
      const active = activeByIdentity.get(
        `${event.providerEventId}@${event.providerRevision}`,
      );
      if (
        !active ||
        active.effectiveDate !== event.effectiveDate ||
        active.splitNumerator !== event.numerator ||
        active.splitDenominator !== event.denominator
      ) {
        changedDates.add(event.effectiveDate);
      }
    }
    for (const action of activeInRange) {
      if (
        !snapshotByIdentity.has(
          `${action.providerEventId}@${action.providerRevision}`,
        )
      ) {
        changedDates.add(action.effectiveDate);
      }
    }

    const intervals: { startDate: string; endDate: string }[] = [];
    for (const effectiveDate of [...changedDates].sort()) {
      if (
        !anyAccountEligible(input.beforeHoldings, effectiveDate) ||
        effectiveDate > input.today
      ) {
        continue;
      }
      const affectedHeldInterval = mergedHeldIntervals(
        input.afterHoldings,
        effectiveDate,
        input.today,
      )[0];
      if (affectedHeldInterval) intervals.push(affectedHeldInterval);
    }

    return intervals.reduce<{ startDate: string; endDate: string }[]>(
      (merged, interval) => {
        const previous = merged.at(-1);
        if (!previous || interval.startDate > nextDate(previous.endDate)) {
          merged.push({ ...interval });
        } else if (interval.endDate > previous.endDate) {
          previous.endDate = interval.endDate;
        }
        return merged;
      },
      [],
    );
  }

  private batchFailure(error: unknown): LedgerMutationResult {
    const message = error instanceof Error ? error.message : "ledger_conflict";
    if (message.includes("ledger_conflict"))
      return { kind: "conflict", code: "ledger_conflict" };
    return { kind: "conflict", code: "event_conflict" };
  }
}
