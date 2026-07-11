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
import { WorkItemRepository } from "../db/work-items";
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

const MAX_CURRENT_POSITIONS = 100;
const PLANNING_WORK_TYPE = "ledger_reconciliation_plan";

type TransactionSide = "buy" | "sell";

export type LedgerProposal =
  | {
      kind: "create";
      instrumentId: string;
      tradeDate: string;
      side: TransactionSide;
      quantityDecimal: string;
      priceDecimal: string;
    }
  | {
      kind: "update";
      eventId: string;
      expectedEventRevision: number;
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

export interface SplitConfirmation {
  requestedStartDate: string;
  requestedEndDate: string;
  providerRevision: string;
}

export interface ApplyLedgerMutationInput {
  expectedPositionBasisRevision: number;
  proposal: LedgerProposal;
  confirmation?: SplitConfirmation;
}

export interface ConfirmSplitHistoryInput {
  expectedPositionBasisRevision: number;
  instrumentId: string;
  confirmation: SplitConfirmation;
}

export type LedgerMutationResult =
  | {
      kind: "committed";
      positionBasisRevision: number;
      pipelineJobId: string;
      transactionId: string | null;
    }
  | { kind: "review_required"; snapshot: SplitEventRange }
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

const minDate = (dates: readonly string[]): string | null =>
  dates.length === 0
    ? null
    : ([...dates].sort((left, right) => left.localeCompare(right))[0] ?? null);

const nextDate = (date: string): string => {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
};

const snapshotsMatch = (
  coverage: CoverageRecord | null,
  snapshot: SplitEventRange,
): boolean =>
  coverage?.requestedStartDate === snapshot.range.requestedStartDate &&
  coverage.requestedEndDate === snapshot.range.requestedEndDate &&
  coverage.snapshotProviderRevision === snapshot.range.providerRevision;

const confirmationMatches = (
  confirmation: SplitConfirmation | undefined,
  snapshot: SplitEventRange,
): boolean =>
  confirmation?.requestedStartDate === snapshot.range.requestedStartDate &&
  confirmation.requestedEndDate === snapshot.range.requestedEndDate &&
  confirmation.providerRevision === snapshot.range.providerRevision;

const coverageIsConfirmed = (
  coverage: CoverageRecord | null,
  snapshot: SplitEventRange,
): boolean =>
  snapshotsMatch(coverage, snapshot) &&
  coverage?.status === "confirmed" &&
  coverage.confirmedStartDate === snapshot.range.requestedStartDate &&
  coverage.confirmedEndDate === snapshot.range.requestedEndDate &&
  coverage.confirmedProviderRevision === snapshot.range.providerRevision &&
  coverage.confirmedAt !== null;

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

    let snapshot: SplitEventRange;
    try {
      snapshot = await this.dependencies.corporateActionProvider.getSplits(
        instrument.providerSymbol,
        resolved.changedStartDate,
        today,
      );
    } catch (error) {
      return { kind: "provider_unavailable", code: providerErrorCode(error) };
    }
    if (
      snapshot.symbol !== instrument.providerSymbol.toUpperCase() ||
      snapshot.range.requestedStartDate !== resolved.changedStartDate ||
      snapshot.range.requestedEndDate !== today
    ) {
      return {
        kind: "provider_unavailable",
        code: "provider_snapshot_mismatch",
      };
    }

    const coverage = await this.coverageFor(
      resolved.instrumentId,
      snapshot.range.provider,
    );
    const activeActions = (
      await this.actions.listForInstrument(resolved.instrumentId)
    ).filter((action) => action.status === "active");
    const candidateSplits = this.proposedSplits(activeActions, snapshot);

    let proposedHoldings: ReturnType<typeof deriveHoldings>;
    try {
      proposedHoldings = deriveHoldings({
        today,
        transactions: resolved.after.map(toLedgerTransaction),
        activeSplits: candidateSplits,
      });
    } catch {
      if (!this.isCandidateRefreshNeeded(coverage, snapshot)) {
        return { kind: "validation_error", code: "negative_holdings" };
      }
      const persisted = await this.persistReviewState({
        input,
        snapshot,
        instrumentId: resolved.instrumentId,
        changedStartDate: resolved.changedStartDate,
        timestamp,
        previousCoverage: coverage,
        status: "conflict",
        candidateStatus: "quarantined",
        conflict: "negative_history",
      });
      return persisted ?? { kind: "candidate_conflict", snapshot };
    }

    const authorized =
      coverageIsConfirmed(coverage, snapshot) ||
      confirmationMatches(input.confirmation, snapshot);
    if (!authorized) {
      if (this.isCandidateRefreshNeeded(coverage, snapshot)) {
        const persisted = await this.persistReviewState({
          input,
          snapshot,
          instrumentId: resolved.instrumentId,
          changedStartDate: resolved.changedStartDate,
          timestamp,
          previousCoverage: coverage,
          status: "review_required",
          candidateStatus: "candidate",
          conflict: null,
        });
        if (persisted) return persisted;
      }
      return { kind: "review_required", snapshot };
    }

    let beforeHoldings: ReturnType<typeof deriveHoldings>;
    try {
      beforeHoldings = deriveHoldings({
        today,
        transactions: resolved.before.map(toLedgerTransaction),
        activeSplits: activeActions.map(toActiveSplit),
      });
    } catch {
      return { kind: "validation_error", code: "negative_holdings" };
    }

    const withinPositionLimit = await this.withinPositionLimit({
      today,
      targetInstrumentId: resolved.instrumentId,
      targetTransactions: resolved.after,
      targetSplits: candidateSplits,
    });
    if (!withinPositionLimit)
      return { kind: "validation_error", code: "position_limit" };

    const jobId = this.newId();
    const workId = this.newId();
    const mutationId = this.newId();
    const intervals = this.changedEligibilityIntervals(
      beforeHoldings,
      proposedHoldings,
      resolved.changedStartDate,
      today,
    );
    const statements = [
      this.mutationTokenStatement({
        id: mutationId,
        expectedRevision: input.expectedPositionBasisRevision,
        kind: resolved.mutationKind,
        createdAt: timestamp,
        eventGuard: resolved.existing,
      }),
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
      ...this.transactionStatements(resolved),
      ...this.reconciliationStatements({
        jobId,
        workId,
        instrumentId: resolved.instrumentId,
        startDate: resolved.changedStartDate,
        endDate: today,
        intervals,
        timestamp,
      }),
      this.revisions.bumpRangeStatement(
        resolved.changedStartDate,
        today,
        timestamp,
      ),
      this.revisions.bumpLatestForRangeStatement(
        resolved.changedStartDate,
        today,
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
      transactionId: resolved.transactionToWrite?.id ?? null,
    };
  }

  /**
   * Promotes a previously reviewed, server-fetched split snapshot without
   * accepting any corporate-action rows from the client. The confirmation is
   * guarded by the same position-basis revision as transaction mutations.
   */
  async confirmSplitHistory(
    input: ConfirmSplitHistoryInput,
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
    if (input.confirmation.requestedEndDate !== today) {
      return { kind: "validation_error", code: "invalid_confirmation" };
    }
    const instrument = await this.instruments.findById(input.instrumentId);
    if (!instrument)
      return { kind: "validation_error", code: "instrument_not_found" };

    let snapshot: SplitEventRange;
    try {
      snapshot = await this.dependencies.corporateActionProvider.getSplits(
        instrument.providerSymbol,
        input.confirmation.requestedStartDate,
        input.confirmation.requestedEndDate,
      );
    } catch (error) {
      return { kind: "provider_unavailable", code: providerErrorCode(error) };
    }
    const coverage = await this.coverageFor(
      input.instrumentId,
      snapshot.range.provider,
    );
    if (snapshot.symbol !== instrument.providerSymbol.toUpperCase()) {
      return {
        kind: "provider_unavailable",
        code: "provider_snapshot_mismatch",
      };
    }
    if (!confirmationMatches(input.confirmation, snapshot)) {
      if (this.isCandidateRefreshNeeded(coverage, snapshot)) {
        const persisted = await this.persistConfirmationReviewState({
          expectedPositionBasisRevision: input.expectedPositionBasisRevision,
          instrumentId: input.instrumentId,
          snapshot,
          timestamp,
          previousCoverage: coverage,
        });
        if (persisted) return persisted;
      }
      return { kind: "review_required", snapshot };
    }
    if (
      !snapshotsMatch(coverage, snapshot) ||
      coverage?.status !== "review_required"
    ) {
      return { kind: "review_required", snapshot };
    }

    const activeActions = (
      await this.actions.listForInstrument(input.instrumentId)
    ).filter((action) => action.status === "active");
    const transactions = await this.transactions.listForInstrument(
      input.instrumentId,
    );
    let beforeHoldings: ReturnType<typeof deriveHoldings>;
    let afterHoldings: ReturnType<typeof deriveHoldings>;
    try {
      beforeHoldings = deriveHoldings({
        today,
        transactions: transactions.map(toLedgerTransaction),
        activeSplits: activeActions.map(toActiveSplit),
      });
      afterHoldings = deriveHoldings({
        today,
        transactions: transactions.map(toLedgerTransaction),
        activeSplits: this.proposedSplits(activeActions, snapshot),
      });
    } catch {
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
      const record = this.newTransaction({
        id: this.newId(),
        instrumentId: proposal.instrumentId,
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
      };
    }
    const updated = this.newTransaction({
      id: existing.id,
      instrumentId: existing.instrumentId,
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
    };
  }

  private newTransaction(input: {
    id: string;
    instrumentId: string;
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
        priceDecimal === "0" ||
        quantityDecimal.startsWith("-") ||
        priceDecimal.startsWith("-")
      ) {
        return null;
      }
      return {
        id: input.id,
        instrumentId: input.instrumentId,
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
              price_decimal, revision, created_at, updated_at
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
        revision: number;
        created_at: string;
        updated_at: string;
      }>();
    return row
      ? {
          id: row.id,
          instrumentId: row.instrument_id,
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

  private isCandidateRefreshNeeded(
    coverage: CoverageRecord | null,
    snapshot: SplitEventRange,
  ): boolean {
    // A normal invalid transaction must not be misreported as a provider
    // conflict merely because its already-confirmed snapshot is not in review.
    // Candidate quarantine is reserved for a newly fetched snapshot.
    return !snapshotsMatch(coverage, snapshot);
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
        maxAttempts: 3,
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
    before: ReturnType<typeof deriveHoldings>,
    after: ReturnType<typeof deriveHoldings>,
    startDate: string,
    today: string,
  ): { startDate: string; endDate: string }[] {
    const intervals: { startDate: string; endDate: string }[] = [];
    let intervalStart: string | null = null;
    for (let date = startDate; date <= today; date = nextDate(date)) {
      const changed =
        before.isEligibleForScreening(date) !==
        after.isEligibleForScreening(date);
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
    beforeHoldings: ReturnType<typeof deriveHoldings>;
    afterHoldings: ReturnType<typeof deriveHoldings>;
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
        !input.beforeHoldings.isEligibleForScreening(effectiveDate) ||
        effectiveDate > input.today
      ) {
        continue;
      }
      const affectedHeldInterval = input.afterHoldings.heldIntervals({
        startDate: effectiveDate,
        endDate: input.today,
      })[0];
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

  private async withinPositionLimit(input: {
    today: string;
    targetInstrumentId: string;
    targetTransactions: readonly TransactionRecord[];
    targetSplits: readonly ActiveSplit[];
  }): Promise<boolean> {
    const rows = await this.dependencies.db
      .prepare("SELECT id FROM instruments ORDER BY id")
      .all<{ id: string }>();
    let positive = 0;
    for (const row of rows.results) {
      const transactions =
        row.id === input.targetInstrumentId
          ? input.targetTransactions
          : await this.transactions.listForInstrument(row.id);
      const actions =
        row.id === input.targetInstrumentId
          ? input.targetSplits
          : (await this.actions.listForInstrument(row.id))
              .filter((action) => action.status === "active")
              .map(toActiveSplit);
      try {
        if (
          deriveHoldings({
            today: input.today,
            transactions: transactions.map(toLedgerTransaction),
            activeSplits: actions,
          }).currentQuantity() !== "0"
        )
          positive += 1;
      } catch {
        return false;
      }
      if (positive > MAX_CURRENT_POSITIONS) return false;
    }
    return true;
  }

  private async persistReviewState(input: {
    input: ApplyLedgerMutationInput;
    snapshot: SplitEventRange;
    instrumentId: string;
    changedStartDate: string;
    timestamp: string;
    previousCoverage: CoverageRecord | null;
    status: "review_required" | "conflict";
    candidateStatus: "candidate" | "quarantined";
    conflict: string | null;
  }): Promise<LedgerMutationResult | null> {
    const jobId = this.newId();
    const workId = this.newId();
    const mutationId = this.newId();
    const kind: LedgerMutationKind =
      input.status === "conflict" ? "action_quarantine" : "candidate_refresh";
    const statements = [
      this.positionBasis.mutationTokenStatement({
        id: mutationId,
        expectedRevision: input.input.expectedPositionBasisRevision,
        kind,
        createdAt: input.timestamp,
      }),
      ...this.candidateInsertStatements(
        input.instrumentId,
        input.snapshot,
        input.timestamp,
        input.candidateStatus,
        input.conflict,
      ),
      ...(input.previousCoverage
        ? [
            this.revisions.bumpRangeStatement(
              input.previousCoverage.requestedStartDate,
              input.previousCoverage.requestedEndDate,
              input.timestamp,
            ),
            this.revisions.bumpLatestForRangeStatement(
              input.previousCoverage.requestedStartDate,
              input.previousCoverage.requestedEndDate,
              input.timestamp,
              easternMarketDate(input.timestamp),
            ),
          ]
        : []),
      ...(input.candidateStatus === "quarantined"
        ? input.snapshot.events.map((event) =>
            this.dependencies.db
              .prepare(
                `UPDATE corporate_actions
             SET status = 'quarantined', conflict_code = ?1, conflict_message = ?2,
                 updated_at = ?3
             WHERE instrument_id = ?4 AND provider = ?5 AND provider_event_id = ?6
                   AND provider_revision = ?7`,
              )
              .bind(
                input.conflict,
                "candidate split would create negative historical holdings",
                input.timestamp,
                input.instrumentId,
                event.provider,
                event.providerEventId,
                event.providerRevision,
              ),
          )
        : []),
      this.actions.upsertCoverageStatement(
        this.coverageFromSnapshot({
          instrumentId: input.instrumentId,
          snapshot: input.snapshot,
          timestamp: input.timestamp,
          status: input.status,
          errorCode: input.conflict,
          errorMessage: input.conflict
            ? "candidate split would create negative historical holdings"
            : null,
        }),
      ),
      ...this.reconciliationStatements({
        jobId,
        workId,
        instrumentId: input.instrumentId,
        startDate: input.changedStartDate,
        endDate: input.snapshot.range.requestedEndDate,
        intervals: [],
        timestamp: input.timestamp,
      }),
      this.revisions.bumpRangeStatement(
        input.changedStartDate,
        input.snapshot.range.requestedEndDate,
        input.timestamp,
      ),
      this.revisions.bumpLatestForRangeStatement(
        input.changedStartDate,
        input.snapshot.range.requestedEndDate,
        input.timestamp,
        easternMarketDate(input.timestamp),
      ),
    ];
    try {
      await this.dependencies.db.batch(statements);
      return null;
    } catch (error) {
      return this.batchFailure(error);
    }
  }

  private async persistConfirmationReviewState(input: {
    expectedPositionBasisRevision: number;
    instrumentId: string;
    snapshot: SplitEventRange;
    timestamp: string;
    previousCoverage: CoverageRecord | null;
  }): Promise<LedgerMutationResult | null> {
    const jobId = this.newId();
    const workId = this.newId();
    const mutationId = this.newId();
    const statements = [
      this.positionBasis.mutationTokenStatement({
        id: mutationId,
        expectedRevision: input.expectedPositionBasisRevision,
        kind: "candidate_refresh",
        createdAt: input.timestamp,
      }),
      ...this.candidateInsertStatements(
        input.instrumentId,
        input.snapshot,
        input.timestamp,
        "candidate",
        null,
      ),
      ...(input.previousCoverage
        ? [
            this.revisions.bumpRangeStatement(
              input.previousCoverage.requestedStartDate,
              input.previousCoverage.requestedEndDate,
              input.timestamp,
            ),
            this.revisions.bumpLatestForRangeStatement(
              input.previousCoverage.requestedStartDate,
              input.previousCoverage.requestedEndDate,
              input.timestamp,
              easternMarketDate(input.timestamp),
            ),
          ]
        : []),
      this.actions.upsertCoverageStatement(
        this.coverageFromSnapshot({
          instrumentId: input.instrumentId,
          snapshot: input.snapshot,
          timestamp: input.timestamp,
          status: "review_required",
        }),
      ),
      ...this.reconciliationStatements({
        jobId,
        workId,
        instrumentId: input.instrumentId,
        startDate: input.snapshot.range.requestedStartDate,
        endDate: input.snapshot.range.requestedEndDate,
        intervals: [],
        timestamp: input.timestamp,
      }),
      this.revisions.bumpRangeStatement(
        input.snapshot.range.requestedStartDate,
        input.snapshot.range.requestedEndDate,
        input.timestamp,
      ),
      this.revisions.bumpLatestForRangeStatement(
        input.snapshot.range.requestedStartDate,
        input.snapshot.range.requestedEndDate,
        input.timestamp,
        easternMarketDate(input.timestamp),
      ),
    ];
    try {
      await this.dependencies.db.batch(statements);
      return null;
    } catch (error) {
      return this.batchFailure(error);
    }
  }

  private batchFailure(error: unknown): LedgerMutationResult {
    const message = error instanceof Error ? error.message : "ledger_conflict";
    if (message.includes("ledger_conflict"))
      return { kind: "conflict", code: "ledger_conflict" };
    return { kind: "conflict", code: "event_conflict" };
  }
}
