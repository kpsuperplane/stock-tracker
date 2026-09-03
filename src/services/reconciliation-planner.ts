import type { CorporateActionRecord } from "../db/corporate-actions";
import type {
  PipelineJobRecord,
  PipelinePlanningPhase,
} from "../db/pipeline-jobs";
import { PipelineJobRepository } from "../db/pipeline-jobs";
import { ReconciliationWorkRepository } from "../db/reconciliation-work";
import type { TransactionRecord } from "../db/transactions";
import {
  type GlobalFactWorkRecord,
  type WorkItemRecord,
  WorkItemRepository,
} from "../db/work-items";
import { DecimalValue } from "../domain/decimal";
import {
  type ActiveSplit,
  deriveHoldings,
  type LedgerTransaction,
} from "../domain/holdings";
import { isMarketTradingDayForExchange } from "../domain/market-calendar";
import { easternMarketDate } from "../shared/dates";

export const MARKET_FACT_WORK_TYPE = "market_fact" as const;
export const ANALYSIS_WORK_TYPE = "analysis" as const;
export const DIVIDEND_RECALCULATION_WORK_TYPE =
  "dividend_recalculation" as const;

const DEFAULT_MARKET_DEPENDENCY_REVISION = "market-r1";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;
const CURRENT_DAY_PRIORITY = 300;
const BACKFILL_PRIORITY = 200;
const AUTOMATIC_PRIORITY = 100;

export interface EligibilityInterval {
  instrumentId?: string;
  startDate: string;
  endDate: string;
}

export interface ReconciliationPlannerDependencies {
  db: D1Database;
  now?: () => Date;
  newId?: () => string;
  marketDependencyRevision?: string;
}

export interface PlanReconciliationPageInput {
  pipelineJobId?: string;
  jobId?: string;
  plannerWorkItemId?: string;
  planningWorkItemId?: string;
  plannerLeaseUntil?: string;
  planningLeaseUntil?: string;
  cursor?: string | null;
  dividendCursor?: string | null;
  pageSize?: number;
  forcedRefreshGeneration?: number | null;
  forceRefresh?: boolean;
  reprocessExisting?: boolean;
  latestCompletedTradingDate?: string;
  previousCompletedTradingDate?: string;
}

export interface PlannedDividendRecalculation {
  instrumentId: string;
  exDate: string;
}

export interface ReconciliationPlanPage {
  pipelineJobId: string;
  plannerWorkItemId: string;
  plannerLeaseUntil: string | null;
  complete: boolean;
  nextCursor: string | null;
  nextDividendCursor: string | null;
  createdCount: number;
  reusedCount: number;
  attachedCount: number;
  skippedCount: number;
  globalWork: WorkItemRecord[];
  dividendRecalculations: PlannedDividendRecalculation[];
  priority: number;
  nextPlanningPhase?: PipelinePlanningPhase;
  pausePlanning?: boolean;
}

type PlanningCursorPhase = PipelinePlanningPhase | "current";

interface HistoryCursor {
  phase: PlanningCursorPhase;
  instrumentId: string;
  date: string;
}

interface HistoryDate {
  instrumentId: string;
  date: string;
  valuationOnly?: boolean;
}

interface FactRow {
  id: string;
  instrument_id: string;
  trading_date: string;
  previous_trading_date: string | null;
  current_raw_close_decimal: string;
  crossing_split_numerator: string;
  crossing_split_denominator: string;
  movement_percent_decimal: string | null;
  movement_basis: "split_adjusted_price_return" | "legacy_migration";
  provider_revision: string;
  status: "valid" | "stale" | "error";
  updated_at: string;
}

interface AnalysisRow {
  daily_market_fact_id: string;
  status: "pending" | "complete" | "stale" | "error";
  updated_at: string;
}

interface DividendDateRow {
  instrument_id: string;
  ex_date: string;
}

interface WorkStateRow {
  deterministic_key: string;
  state: WorkItemRecord["state"];
}

interface PlannerCandidate {
  workType: typeof MARKET_FACT_WORK_TYPE | typeof ANALYSIS_WORK_TYPE;
  instrumentId: string;
  effectiveDate: string;
  dependencyRevision: string;
  forcedRefreshGeneration: number | null;
  priority: number;
}

const nextDate = (date: string): string => {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
};

const previousWeekday = (date: string): string => {
  let value = new Date(`${date}T12:00:00.000Z`);
  do {
    value = new Date(value.getTime() - 86_400_000);
  } while (value.getUTCDay() === 0 || value.getUTCDay() === 6);
  return value.toISOString().slice(0, 10);
};

const latestWeekday = (date: string): string => {
  let value = new Date(`${date}T12:00:00.000Z`);
  while (value.getUTCDay() === 0 || value.getUTCDay() === 6) {
    value = new Date(value.getTime() - 86_400_000);
  }
  return value.toISOString().slice(0, 10);
};

const parseHistoryCursor = (
  cursor: string | null | undefined,
  phase: PlanningCursorPhase,
): HistoryCursor | null => {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(cursor) as Record<string, unknown>;
    if (
      parsed.phase !== phase ||
      typeof parsed.instrumentId !== "string" ||
      typeof parsed.date !== "string"
    ) {
      throw new Error("invalid_planner_cursor");
    }
    return {
      phase,
      instrumentId: parsed.instrumentId,
      date: parsed.date,
    };
  } catch {
    throw new Error("invalid_planner_cursor");
  }
};

const historyCursorFor = (
  phase: PlanningCursorPhase,
  value: HistoryDate,
): string =>
  JSON.stringify({ phase, instrumentId: value.instrumentId, date: value.date });

const parseJsonArray = (value: string, code: string): unknown[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error(code);
    return parsed;
  } catch {
    throw new Error(code);
  }
};

const parseAffectedInstruments = (job: PipelineJobRecord): string[] => {
  const values = parseJsonArray(
    job.affectedInstrumentsJson,
    "invalid_affected_instruments",
  );
  const result = values.filter(
    (value): value is string => typeof value === "string",
  );
  if (
    result.length !== values.length ||
    result.some((value) => value.length === 0)
  ) {
    throw new Error("invalid_affected_instruments");
  }
  return [...new Set(result)].sort();
};

const parseIntervals = (
  job: PipelineJobRecord,
  instruments: readonly string[],
): EligibilityInterval[] => {
  const values = parseJsonArray(
    job.eligibilityIntervalsJson,
    "invalid_eligibility_intervals",
  );
  const result: EligibilityInterval[] = [];
  for (const value of values) {
    if (typeof value !== "object" || value === null) {
      throw new Error("invalid_eligibility_intervals");
    }
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.startDate !== "string" ||
      typeof candidate.endDate !== "string" ||
      candidate.startDate > candidate.endDate
    ) {
      throw new Error("invalid_eligibility_intervals");
    }
    if (candidate.instrumentId !== undefined) {
      if (
        typeof candidate.instrumentId !== "string" ||
        !instruments.includes(candidate.instrumentId)
      ) {
        throw new Error("invalid_eligibility_intervals");
      }
      result.push({
        instrumentId: candidate.instrumentId,
        startDate: candidate.startDate,
        endDate: candidate.endDate,
      });
    } else {
      for (const instrumentId of instruments) {
        result.push({
          instrumentId,
          startDate: candidate.startDate,
          endDate: candidate.endDate,
        });
      }
    }
  }
  return result;
};

const toLedgerTransaction = (row: TransactionRecord): LedgerTransaction => ({
  id: row.id,
  tradeDate: row.tradeDate,
  side: row.side,
  quantityDecimal: row.quantityDecimal,
});

const toActiveSplit = (row: CorporateActionRecord): ActiveSplit => ({
  id: row.id,
  effectiveDate: row.effectiveDate,
  numerator: row.splitNumerator,
  denominator: row.splitDenominator,
});

const ratio = (actions: readonly CorporateActionRecord[], fact: FactRow) => {
  let numerator = 1n;
  let denominator = 1n;
  for (const action of actions) {
    if (
      action.status === "active" &&
      fact.previous_trading_date &&
      action.effectiveDate > fact.previous_trading_date &&
      action.effectiveDate <= fact.trading_date
    ) {
      numerator *= BigInt(action.splitNumerator);
      denominator *= BigInt(action.splitDenominator);
    }
  }
  const gcd = (left: bigint, right: bigint): bigint => {
    let a = left < 0n ? -left : left;
    let b = right < 0n ? -right : right;
    while (b !== 0n) {
      const remainder = a % b;
      a = b;
      b = remainder;
    }
    return a || 1n;
  };
  const divisor = gcd(numerator, denominator);
  return {
    numerator: String(numerator / divisor),
    denominator: String(denominator / divisor),
  };
};

const splitFingerprint = (
  actions: readonly CorporateActionRecord[],
  fact: FactRow,
): string =>
  actions
    .filter(
      (action) =>
        action.status === "active" &&
        fact.previous_trading_date !== null &&
        action.effectiveDate > fact.previous_trading_date &&
        action.effectiveDate <= fact.trading_date,
    )
    .map(
      (action) =>
        `${action.id}:${action.revision}:${action.providerRevision}:${action.splitNumerator}/${action.splitDenominator}`,
    )
    .sort()
    .join(",");

const isQualifiedMovement = (fact: FactRow): boolean => {
  if (!fact.movement_percent_decimal) return false;
  try {
    const movement = DecimalValue.parse(fact.movement_percent_decimal);
    return movement.compare("5") >= 0 || movement.compare("-5") <= 0;
  } catch {
    return false;
  }
};

export class ReconciliationPlannerService {
  private readonly jobs: PipelineJobRepository;
  private readonly reconciliationWork: ReconciliationWorkRepository;
  private readonly workItems: WorkItemRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly marketDependencyRevision: string;
  private plannerLeaseSequence = 0;

  constructor(
    private readonly dependencies: ReconciliationPlannerDependencies,
  ) {
    this.jobs = new PipelineJobRepository(dependencies.db);
    this.reconciliationWork = new ReconciliationWorkRepository(dependencies.db);
    this.workItems = new WorkItemRepository(dependencies.db);
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
    this.marketDependencyRevision =
      dependencies.marketDependencyRevision ??
      DEFAULT_MARKET_DEPENDENCY_REVISION;
  }

  private async resolveOwningPlanner(
    pipelineJobId: string,
    input: PlanReconciliationPageInput,
  ): Promise<WorkItemRecord> {
    const explicitIds = [
      input.plannerWorkItemId,
      input.planningWorkItemId,
    ].filter((value): value is string => value !== undefined);
    if (new Set(explicitIds).size > 1) {
      throw new Error("planner_work_item_id_conflict");
    }
    const planner = explicitIds[0]
      ? await this.workItems.findById(explicitIds[0])
      : await this.workItems.findPlanningForJob(pipelineJobId);
    if (!planner) throw new Error("planner_work_item_missing");
    if (
      planner.scope !== "job_planning" ||
      planner.pipelineJobId !== pipelineJobId ||
      !planner.deterministicKey.startsWith(`job:${pipelineJobId}:`)
    ) {
      throw new Error("planner_work_item_owner_mismatch");
    }
    if (
      !(await this.workItems.isLinkedToJob({
        pipelineJobId,
        workItemId: planner.id,
      }))
    ) {
      throw new Error("planner_work_item_unlinked");
    }
    return planner;
  }

  private nextPlannerLease(timestamp: string): string {
    this.plannerLeaseSequence += 1;
    return new Date(
      Date.parse(timestamp) + 5 * 60_000 + this.plannerLeaseSequence,
    ).toISOString();
  }

  async planPage(
    input: PlanReconciliationPageInput,
  ): Promise<ReconciliationPlanPage> {
    if (
      input.pipelineJobId !== undefined &&
      input.jobId !== undefined &&
      input.pipelineJobId !== input.jobId
    ) {
      throw new Error("pipeline_job_id_conflict");
    }
    const pipelineJobId = input.pipelineJobId ?? input.jobId;
    if (!pipelineJobId) throw new Error("pipeline_job_id_required");
    const job = await this.jobs.findById(pipelineJobId);
    if (!job) throw new Error("pipeline_job_not_found");
    const timestamp = this.now().toISOString();
    const planner = await this.resolveOwningPlanner(pipelineJobId, input);
    if (
      input.plannerLeaseUntil !== undefined &&
      input.planningLeaseUntil !== undefined &&
      input.plannerLeaseUntil !== input.planningLeaseUntil
    ) {
      throw new Error("planner_lease_conflict");
    }
    const expectedLease =
      input.plannerLeaseUntil ?? input.planningLeaseUntil ?? undefined;
    if (planner.state === "complete" || planner.state === "terminal") {
      throw new Error("planner_work_item_not_active");
    }
    if (planner.state === "pending" && expectedLease !== undefined) {
      throw new Error("planner_lease_unexpected");
    }
    if (planner.state === "processing") {
      if (!expectedLease) throw new Error("planner_lease_required");
      if (planner.processingLeaseUntil !== expectedLease) {
        throw new Error("planner_lease_conflict");
      }
    }
    const leaseUntil = this.nextPlannerLease(timestamp);
    const claimed =
      planner.state === "processing" &&
      planner.processingLeaseUntil !== null &&
      planner.processingLeaseUntil <= timestamp
        ? await this.workItems.reclaimExpiredPlanning({
            id: planner.id,
            pipelineJobId,
            now: timestamp,
            leaseUntil,
            expectedLeaseUntil: planner.processingLeaseUntil,
          })
        : await this.workItems.claimPlanning({
            id: planner.id,
            pipelineJobId,
            now: timestamp,
            leaseUntil,
            ...(expectedLease === undefined
              ? {}
              : { expectedLeaseUntil: expectedLease }),
          });
    if (!claimed) throw new Error("planner_claim_conflict");
    let planningStatus = job.status;
    if (job.status === "pending") {
      await this.jobs.transition({
        id: pipelineJobId,
        from: "pending",
        to: "planning",
        now: timestamp,
      });
      planningStatus = "planning";
    }
    const pageSize = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, Math.floor(input.pageSize ?? DEFAULT_PAGE_SIZE)),
    );
    if (job.syncLane === "history") {
      return this.planHistoryPage({
        job,
        planner,
        leaseUntil,
        timestamp,
        pageSize,
        input,
        planningStatus,
      });
    }
    return this.planCurrentPage({
      job,
      planner,
      leaseUntil,
      timestamp,
      pageSize,
      input,
      planningStatus,
    });
  }

  async plan(
    input: PlanReconciliationPageInput,
  ): Promise<ReconciliationPlanPage> {
    return this.planPage(input);
  }

  async execute(
    input: PlanReconciliationPageInput,
  ): Promise<ReconciliationPlanPage> {
    return this.planPage(input);
  }

  /**
   * Foreground jobs page over their frozen date domain. Facts and work may
   * change while the queue is running, but the cursor never depends on those
   * mutable candidate sets, so a completed first page cannot shift page two.
   */
  private async planCurrentPage(input: {
    job: PipelineJobRecord;
    planner: WorkItemRecord;
    leaseUntil: string;
    timestamp: string;
    pageSize: number;
    input: PlanReconciliationPageInput;
    planningStatus: PipelineJobRecord["status"];
  }): Promise<ReconciliationPlanPage> {
    const latestCompleted = latestWeekday(
      input.input.latestCompletedTradingDate ?? easternMarketDate(this.now()),
    );
    const domain = await this.historyDatePage({
      job: input.job,
      phase: "current",
      ...(input.input.cursor === undefined
        ? {}
        : { cursor: input.input.cursor }),
      pageSize: input.pageSize,
      latestCompleted,
    });
    const facts = await this.factsForDates(domain.page);
    const analyses = await this.analysesForFacts([...facts.values()]);
    const pageInstrumentIds = [
      ...new Set(domain.page.map((value) => value.instrumentId)),
    ];
    const actions =
      pageInstrumentIds.length > 0
        ? await this.loadActions(pageInstrumentIds)
        : new Map<string, CorporateActionRecord[]>();
    const forcedGeneration =
      input.input.forcedRefreshGeneration ??
      input.job.backfillForcedRefreshGeneration ??
      (input.input.forceRefresh || input.input.reprocessExisting ? 1 : null);
    const candidates: PlannerCandidate[] = [];
    let skippedCount = 0;
    for (const value of domain.page) {
      const fact = facts.get(`${value.instrumentId}|${value.date}`);
      const splitRatio = fact
        ? ratio(actions.get(value.instrumentId) ?? [], fact)
        : null;
      const splitChanged =
        fact !== undefined &&
        splitRatio !== null &&
        (fact.crossing_split_numerator !== splitRatio.numerator ||
          fact.crossing_split_denominator !== splitRatio.denominator);
      const priority = this.priorityFor(
        input.job.triggerType,
        value.date === latestCompleted,
      );
      if (
        forcedGeneration !== null ||
        !fact ||
        fact.status !== "valid" ||
        fact.movement_basis === "legacy_migration" ||
        splitChanged
      ) {
        let dependencyRevision =
          fact?.provider_revision ?? this.marketDependencyRevision;
        if (splitChanged && fact) {
          dependencyRevision = `${dependencyRevision}:split:${splitFingerprint(
            actions.get(value.instrumentId) ?? [],
            fact,
          )}`;
        }
        candidates.push({
          workType: MARKET_FACT_WORK_TYPE,
          instrumentId: value.instrumentId,
          effectiveDate: value.date,
          dependencyRevision,
          forcedRefreshGeneration: forcedGeneration,
          priority,
        });
        continue;
      }
      if (value.valuationOnly || !isQualifiedMovement(fact)) {
        skippedCount += 1;
        continue;
      }
      const analysis = analyses.get(fact.id);
      if (
        analysis?.status === "complete" &&
        analysis.updated_at >= fact.updated_at
      ) {
        skippedCount += 1;
        continue;
      }
      candidates.push({
        workType: ANALYSIS_WORK_TYPE,
        instrumentId: value.instrumentId,
        effectiveDate: value.date,
        dependencyRevision: fact.provider_revision,
        forcedRefreshGeneration: null,
        priority,
      });
    }
    candidates.sort(
      (left, right) =>
        right.priority - left.priority ||
        left.instrumentId.localeCompare(right.instrumentId) ||
        left.effectiveDate.localeCompare(right.effectiveDate) ||
        left.workType.localeCompare(right.workType),
    );
    const states = await this.statesForCandidates(candidates);
    for (const candidate of candidates) {
      const key = WorkItemRepository.globalFactKey(candidate);
      const state = states.get(key);
      if (state !== "complete" && state !== "terminal") continue;
      const fact = facts.get(
        `${candidate.instrumentId}|${candidate.effectiveDate}`,
      );
      candidate.dependencyRevision =
        candidate.workType === ANALYSIS_WORK_TYPE
          ? `${candidate.dependencyRevision}:analysis:${fact?.updated_at ?? "retry"}`
          : `${candidate.dependencyRevision}:refresh:${fact?.updated_at ?? "missing"}`;
    }
    const workRecords: GlobalFactWorkRecord[] = candidates.map((candidate) => ({
      id: this.newId(),
      ...candidate,
      deterministicKey: WorkItemRepository.globalFactKey(candidate),
      maxAttempts: candidate.workType === MARKET_FACT_WORK_TYPE ? 5 : 3,
      availableAt: input.timestamp,
      retentionUntil: null,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    }));
    const materialized = await this.reconciliationWork.materializePage({
      pipelineJobId: input.job.id,
      work: workRecords,
      now: input.timestamp,
    });
    const dividendPage = await this.historyDividendPage({
      job: input.job,
      ...(input.input.dividendCursor === undefined
        ? {}
        : { cursor: input.input.dividendCursor }),
      pageSize: input.pageSize,
    });
    const last = domain.page.at(-1) ?? null;
    const dateCursor = last ? historyCursorFor("current", last) : null;
    const datesComplete = !domain.hasMore;
    const dividendsComplete = !dividendPage.hasMore;
    const complete = datesComplete && dividendsComplete;
    const nextCursor = domain.hasMore
      ? dateCursor
      : dividendsComplete
        ? null
        : (input.input.cursor ?? dateCursor);
    const nextDividendCursor = dividendPage.hasMore
      ? dividendPage.last
        ? historyCursorFor("dividends", dividendPage.last)
        : (input.input.dividendCursor ?? null)
      : null;
    let returnedLease: string | null = input.leaseUntil;
    if (complete) {
      const completed = await this.workItems.completePlanning({
        id: input.planner.id,
        pipelineJobId: input.job.id,
        now: input.timestamp,
        expectedLeaseUntil: input.leaseUntil,
      });
      if (!completed) throw new Error("planner_completion_conflict");
      returnedLease = null;
      if (input.planningStatus === "planning") {
        await this.jobs.transition({
          id: input.job.id,
          from: "planning",
          to: "running",
          now: input.timestamp,
        });
      }
    }
    await this.jobs.recordPlanningPage({
      id: input.job.id,
      phase: "current",
      cursorStart: input.input.cursor ?? "start",
      cursorEnd: nextCursor,
      skippedCount,
      now: input.timestamp,
    });
    return {
      pipelineJobId: input.job.id,
      plannerWorkItemId: input.planner.id,
      plannerLeaseUntil: returnedLease,
      complete,
      nextCursor,
      nextDividendCursor,
      createdCount: materialized.createdCount,
      reusedCount: materialized.reusedCount,
      attachedCount: materialized.attachedCount,
      skippedCount: skippedCount + domain.skipped,
      globalWork: materialized.globalWork,
      dividendRecalculations: dividendPage.page,
      priority: Math.max(
        ...candidates.map((candidate) => candidate.priority),
        this.priorityFor(input.job.triggerType, false),
      ),
    };
  }

  private async unsettledForPhase(
    pipelineJobId: string,
    workType: typeof MARKET_FACT_WORK_TYPE | typeof ANALYSIS_WORK_TYPE,
  ): Promise<number> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT CASE WHEN ?2 = 'market_fact' THEN market_work_pending
                     ELSE analysis_work_pending END AS count
           FROM pipeline_jobs WHERE id = ?1`,
      )
      .bind(pipelineJobId, workType)
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  private async historyDatePage(input: {
    job: PipelineJobRecord;
    phase: PlanningCursorPhase;
    cursor?: string | null;
    pageSize: number;
    latestCompleted: string;
  }): Promise<{ page: HistoryDate[]; hasMore: boolean; skipped: number }> {
    const instruments = parseAffectedInstruments(input.job);
    let intervals = parseIntervals(input.job, instruments);
    const valuationOnly = new Set<string>();
    if (intervals.length === 0 && input.job.triggerType === "backfill") {
      const [transactions, actions] = await Promise.all([
        this.loadTransactions(instruments),
        this.loadActions(instruments),
      ]);
      intervals = instruments.flatMap((instrumentId) =>
        deriveHoldings({
          today: input.latestCompleted,
          transactions: (transactions.get(instrumentId) ?? []).map(
            toLedgerTransaction,
          ),
          activeSplits: (actions.get(instrumentId) ?? []).map(toActiveSplit),
        })
          .heldIntervals({
            startDate: input.job.requestedStartDate ?? "1900-01-01",
            endDate: input.job.requestedEndDate ?? input.latestCompleted,
          })
          .map((interval) => ({ instrumentId, ...interval })),
      );
    } else if (
      intervals.length === 0 &&
      input.phase === "current" &&
      input.job.triggerType === "ledger_reconciliation"
    ) {
      const [transactions, actions] = await Promise.all([
        this.loadTransactions(instruments),
        this.loadActions(instruments),
      ]);
      const previousCompleted = previousWeekday(input.latestCompleted);
      for (const instrumentId of instruments) {
        const holdings = deriveHoldings({
          today: input.latestCompleted,
          transactions: (transactions.get(instrumentId) ?? []).map(
            toLedgerTransaction,
          ),
          activeSplits: (actions.get(instrumentId) ?? []).map(toActiveSplit),
        });
        if (
          holdings.currentQuantity() === "0" ||
          holdings.quantityAtStartOfDay(input.latestCompleted) !== "0"
        ) {
          continue;
        }
        intervals.push(
          {
            instrumentId,
            startDate: previousCompleted,
            endDate: previousCompleted,
          },
          {
            instrumentId,
            startDate: input.latestCompleted,
            endDate: input.latestCompleted,
          },
        );
        valuationOnly.add(`${instrumentId}|${previousCompleted}`);
        valuationOnly.add(`${instrumentId}|${input.latestCompleted}`);
      }
    }
    intervals = intervals.sort(
      (left, right) =>
        (left.instrumentId ?? "").localeCompare(right.instrumentId ?? "") ||
        left.startDate.localeCompare(right.startDate) ||
        left.endDate.localeCompare(right.endDate),
    );
    const cursor = parseHistoryCursor(input.cursor, input.phase);
    const exchanges = await this.loadExchanges(instruments);
    const values: HistoryDate[] = [];
    const seen = new Set<string>();
    const seenCalendar = new Set<string>();
    let skipped = 0;
    for (const interval of intervals) {
      const instrumentId = interval.instrumentId;
      if (!instrumentId) continue;
      if (cursor && instrumentId < cursor.instrumentId) continue;
      let start = interval.startDate;
      if (cursor && instrumentId === cursor.instrumentId) {
        if (interval.endDate <= cursor.date) continue;
        if (start <= cursor.date) start = nextDate(cursor.date);
      }
      const isValuationFallback = valuationOnly.has(`${instrumentId}|${start}`);
      if (
        !isValuationFallback &&
        input.job.requestedStartDate &&
        start < input.job.requestedStartDate
      ) {
        start = input.job.requestedStartDate;
      }
      const requestedEnd = input.job.requestedEndDate ?? input.latestCompleted;
      const end = [
        interval.endDate,
        input.latestCompleted,
        requestedEnd,
      ].sort()[0] as string;
      for (let date = start; date <= end; date = nextDate(date)) {
        const key = `${instrumentId}|${date}`;
        if (seenCalendar.has(key)) continue;
        seenCalendar.add(key);
        if (
          !isMarketTradingDayForExchange(
            date,
            exchanges.get(instrumentId) ?? "",
          )
        ) {
          skipped += 1;
          continue;
        }
        if (seen.has(key)) continue;
        seen.add(key);
        values.push({
          instrumentId,
          date,
          ...(valuationOnly.has(key) ? { valuationOnly: true } : {}),
        });
        if (values.length > input.pageSize) {
          return {
            page: values.slice(0, input.pageSize),
            hasMore: true,
            skipped,
          };
        }
      }
    }
    return { page: values, hasMore: false, skipped };
  }

  private async factsForDates(
    dates: readonly HistoryDate[],
  ): Promise<Map<string, FactRow>> {
    if (dates.length === 0) return new Map();
    const rows = await this.dependencies.db
      .prepare(
        `SELECT fact.id, fact.instrument_id, fact.trading_date,
                fact.previous_trading_date, fact.current_raw_close_decimal,
                fact.crossing_split_numerator, fact.crossing_split_denominator,
                fact.movement_percent_decimal, fact.movement_basis,
                fact.provider_revision, fact.status, fact.updated_at
           FROM daily_market_facts fact
           JOIN json_each(?1) requested
             ON fact.instrument_id = json_extract(requested.value, '$.instrumentId')
            AND fact.trading_date = json_extract(requested.value, '$.date')`,
      )
      .bind(JSON.stringify(dates))
      .all<FactRow>();
    return new Map(
      rows.results.map((row) => [
        `${row.instrument_id}|${row.trading_date}`,
        row,
      ]),
    );
  }

  private async analysesForFacts(
    facts: readonly FactRow[],
  ): Promise<Map<string, AnalysisRow>> {
    if (facts.length === 0) return new Map();
    const rows = await this.dependencies.db
      .prepare(
        `SELECT daily_market_fact_id, status, updated_at
           FROM movement_analyses
          WHERE daily_market_fact_id IN (
            SELECT CAST(value AS TEXT) FROM json_each(?1)
          )`,
      )
      .bind(JSON.stringify(facts.map((fact) => fact.id)))
      .all<AnalysisRow>();
    return new Map(rows.results.map((row) => [row.daily_market_fact_id, row]));
  }

  private async statesForCandidates(
    candidates: readonly PlannerCandidate[],
  ): Promise<Map<string, WorkItemRecord["state"]>> {
    if (candidates.length === 0) return new Map();
    const keys = candidates.map((candidate) =>
      WorkItemRepository.globalFactKey(candidate),
    );
    const rows = await this.dependencies.db
      .prepare(
        `SELECT deterministic_key, state FROM work_items
          WHERE deterministic_key IN (
            SELECT CAST(value AS TEXT) FROM json_each(?1)
          )`,
      )
      .bind(JSON.stringify(keys))
      .all<WorkStateRow>();
    return new Map(
      rows.results.map((row) => [row.deterministic_key, row.state]),
    );
  }

  private async historyDividendPage(input: {
    job: PipelineJobRecord;
    cursor?: string | null;
    pageSize: number;
  }): Promise<{
    page: PlannedDividendRecalculation[];
    hasMore: boolean;
    last: HistoryDate | null;
  }> {
    const instruments = parseAffectedInstruments(input.job);
    const requestedStart = input.job.requestedStartDate;
    const requestedEnd = input.job.requestedEndDate;
    const intervals = parseIntervals(input.job, instruments)
      .map((interval) => ({
        ...interval,
        startDate:
          requestedStart && interval.startDate < requestedStart
            ? requestedStart
            : interval.startDate,
        endDate:
          requestedEnd && interval.endDate > requestedEnd
            ? requestedEnd
            : interval.endDate,
      }))
      .filter((interval) => interval.startDate <= interval.endDate);
    const cursor = parseHistoryCursor(input.cursor, "dividends");
    if (intervals.length === 0) {
      return { page: [], hasMore: false, last: null };
    }
    const rows = await this.dependencies.db
      .prepare(
        `SELECT DISTINCT event.instrument_id, event.ex_date
           FROM json_each(?1) interval
           JOIN dividend_events event
             ON event.instrument_id =
                  json_extract(interval.value, '$.instrumentId')
            AND event.ex_date >= json_extract(interval.value, '$.startDate')
            AND event.ex_date <= json_extract(interval.value, '$.endDate')
          WHERE event.status = 'active'
            AND (
              ?2 IS NULL
              OR event.instrument_id > ?2
              OR (event.instrument_id = ?2 AND event.ex_date > ?3)
            )
          ORDER BY event.instrument_id, event.ex_date
          LIMIT ?4`,
      )
      .bind(
        JSON.stringify(intervals),
        cursor?.instrumentId ?? null,
        cursor?.date ?? null,
        input.pageSize + 1,
      )
      .all<DividendDateRow>();
    const selected = rows.results.slice(0, input.pageSize);
    const lastEvent = selected.at(-1);
    return {
      page: selected.map((event) => ({
        instrumentId: event.instrument_id,
        exDate: event.ex_date,
      })),
      hasMore: rows.results.length > input.pageSize,
      last: lastEvent
        ? { instrumentId: lastEvent.instrument_id, date: lastEvent.ex_date }
        : null,
    };
  }

  private async planHistoryPage(input: {
    job: PipelineJobRecord;
    planner: WorkItemRecord;
    leaseUntil: string;
    timestamp: string;
    pageSize: number;
    input: PlanReconciliationPageInput;
    planningStatus: PipelineJobRecord["status"];
  }): Promise<ReconciliationPlanPage> {
    const phase =
      input.job.planningPhase === "complete"
        ? "dividends"
        : (input.job.planningPhase ?? "market");
    const latestCompleted = latestWeekday(
      input.input.latestCompletedTradingDate ?? easternMarketDate(this.now()),
    );
    if (
      phase === "analysis" &&
      (await this.unsettledForPhase(input.job.id, MARKET_FACT_WORK_TYPE)) > 0
    ) {
      return {
        pipelineJobId: input.job.id,
        plannerWorkItemId: input.planner.id,
        plannerLeaseUntil: input.leaseUntil,
        complete: false,
        nextCursor: null,
        nextDividendCursor: null,
        createdCount: 0,
        reusedCount: 0,
        attachedCount: 0,
        skippedCount: 0,
        globalWork: [],
        dividendRecalculations: [],
        priority: input.job.priority,
        nextPlanningPhase: phase,
        pausePlanning: true,
      };
    }
    if (
      phase === "dividends" &&
      (await this.unsettledForPhase(input.job.id, ANALYSIS_WORK_TYPE)) > 0
    ) {
      return {
        pipelineJobId: input.job.id,
        plannerWorkItemId: input.planner.id,
        plannerLeaseUntil: input.leaseUntil,
        complete: false,
        nextCursor: null,
        nextDividendCursor: null,
        createdCount: 0,
        reusedCount: 0,
        attachedCount: 0,
        skippedCount: 0,
        globalWork: [],
        dividendRecalculations: [],
        priority: input.job.priority,
        nextPlanningPhase: phase,
        pausePlanning: true,
      };
    }

    if (phase === "dividends") {
      const dividendPage = await this.historyDividendPage({
        job: input.job,
        ...(input.input.cursor === undefined
          ? {}
          : { cursor: input.input.cursor }),
        pageSize: input.pageSize,
      });
      const nextCursor =
        dividendPage.hasMore && dividendPage.last
          ? historyCursorFor("dividends", dividendPage.last)
          : null;
      if (!dividendPage.hasMore) {
        const completed = await this.workItems.completePlanning({
          id: input.planner.id,
          pipelineJobId: input.job.id,
          now: input.timestamp,
          expectedLeaseUntil: input.leaseUntil,
        });
        if (!completed) throw new Error("planner_completion_conflict");
        if (input.planningStatus === "planning") {
          await this.jobs.transition({
            id: input.job.id,
            from: "planning",
            to: "running",
            now: input.timestamp,
          });
        }
      }
      return {
        pipelineJobId: input.job.id,
        plannerWorkItemId: input.planner.id,
        plannerLeaseUntil: dividendPage.hasMore ? input.leaseUntil : null,
        complete: !dividendPage.hasMore,
        nextCursor,
        nextDividendCursor: null,
        createdCount: 0,
        reusedCount: 0,
        attachedCount: 0,
        skippedCount: 0,
        globalWork: [],
        dividendRecalculations: dividendPage.page,
        priority: input.job.priority,
        nextPlanningPhase: dividendPage.hasMore ? "dividends" : "complete",
      };
    }

    const domain = await this.historyDatePage({
      job: input.job,
      phase,
      ...(input.input.cursor === undefined
        ? {}
        : { cursor: input.input.cursor }),
      pageSize: input.pageSize,
      latestCompleted,
    });
    const facts = await this.factsForDates(domain.page);
    const forcedGeneration =
      input.input.forcedRefreshGeneration ??
      input.job.backfillForcedRefreshGeneration ??
      (input.input.forceRefresh || input.input.reprocessExisting ? 1 : null);
    const candidates: PlannerCandidate[] = [];
    if (phase === "market") {
      const instruments = [
        ...new Set(domain.page.map((value) => value.instrumentId)),
      ];
      const actions = await this.loadActions(instruments);
      for (const value of domain.page) {
        const fact = facts.get(`${value.instrumentId}|${value.date}`);
        const splitRatio = fact
          ? ratio(actions.get(value.instrumentId) ?? [], fact)
          : null;
        const splitChanged =
          fact !== undefined &&
          splitRatio !== null &&
          (fact.crossing_split_numerator !== splitRatio.numerator ||
            fact.crossing_split_denominator !== splitRatio.denominator);
        if (
          forcedGeneration !== null ||
          !fact ||
          fact.status !== "valid" ||
          fact.movement_basis === "legacy_migration" ||
          splitChanged
        ) {
          let dependencyRevision =
            fact?.provider_revision ?? this.marketDependencyRevision;
          if (splitChanged && fact) {
            dependencyRevision = `${dependencyRevision}:split:${splitFingerprint(
              actions.get(value.instrumentId) ?? [],
              fact,
            )}`;
          }
          candidates.push({
            workType: MARKET_FACT_WORK_TYPE,
            instrumentId: value.instrumentId,
            effectiveDate: value.date,
            dependencyRevision,
            forcedRefreshGeneration: forcedGeneration,
            priority:
              input.job.triggerType === "backfill"
                ? BACKFILL_PRIORITY
                : input.job.priority,
          });
        }
      }
    } else {
      const analyses = await this.analysesForFacts([...facts.values()]);
      for (const value of domain.page) {
        const fact = facts.get(`${value.instrumentId}|${value.date}`);
        if (fact?.status !== "valid" || !isQualifiedMovement(fact)) continue;
        const analysis = analyses.get(fact.id);
        if (
          analysis?.status === "complete" &&
          analysis.updated_at >= fact.updated_at
        ) {
          continue;
        }
        candidates.push({
          workType: ANALYSIS_WORK_TYPE,
          instrumentId: value.instrumentId,
          effectiveDate: value.date,
          dependencyRevision: fact.provider_revision,
          forcedRefreshGeneration: null,
          priority:
            input.job.triggerType === "backfill"
              ? BACKFILL_PRIORITY
              : input.job.priority,
        });
      }
    }
    const states = await this.statesForCandidates(candidates);
    for (const candidate of candidates) {
      const key = WorkItemRepository.globalFactKey(candidate);
      const state = states.get(key);
      if (state !== "complete" && state !== "terminal") continue;
      const fact = facts.get(
        `${candidate.instrumentId}|${candidate.effectiveDate}`,
      );
      candidate.dependencyRevision =
        phase === "analysis"
          ? `${candidate.dependencyRevision}:analysis:${fact?.updated_at ?? "retry"}`
          : `${candidate.dependencyRevision}:refresh:${fact?.updated_at ?? "missing"}`;
    }
    const workRecords: GlobalFactWorkRecord[] = candidates.map((candidate) => ({
      id: this.newId(),
      ...candidate,
      deterministicKey: WorkItemRepository.globalFactKey(candidate),
      maxAttempts: candidate.workType === MARKET_FACT_WORK_TYPE ? 5 : 3,
      availableAt: input.timestamp,
      retentionUntil: null,
      createdAt: input.timestamp,
      updatedAt: input.timestamp,
    }));
    const materialized = await this.reconciliationWork.materializePage({
      pipelineJobId: input.job.id,
      work: workRecords,
      now: input.timestamp,
    });
    const last = domain.page.at(-1) ?? null;
    const nextCursor =
      domain.hasMore && last ? historyCursorFor(phase, last) : null;
    const nextPhase: PipelinePlanningPhase = domain.hasMore
      ? phase
      : phase === "market"
        ? "analysis"
        : "dividends";
    const unsettled = domain.hasMore
      ? 0
      : await this.unsettledForPhase(
          input.job.id,
          phase === "market" ? MARKET_FACT_WORK_TYPE : ANALYSIS_WORK_TYPE,
        );
    await this.jobs.recordPlanningPage({
      id: input.job.id,
      phase,
      cursorStart: input.input.cursor ?? "start",
      cursorEnd: nextCursor,
      skippedCount: domain.page.length - candidates.length,
      now: input.timestamp,
    });
    return {
      pipelineJobId: input.job.id,
      plannerWorkItemId: input.planner.id,
      plannerLeaseUntil: input.leaseUntil,
      complete: false,
      nextCursor,
      nextDividendCursor: null,
      createdCount: materialized.createdCount,
      reusedCount: materialized.reusedCount,
      attachedCount: materialized.attachedCount,
      skippedCount: domain.page.length - candidates.length + domain.skipped,
      globalWork: materialized.globalWork,
      dividendRecalculations: [],
      priority: input.job.priority,
      nextPlanningPhase: nextPhase,
      pausePlanning: !domain.hasMore && unsettled > 0,
    };
  }

  private priorityFor(
    trigger: PipelineJobRecord["triggerType"],
    currentDay: boolean,
  ): number {
    if (currentDay) return CURRENT_DAY_PRIORITY;
    if (trigger === "backfill") return BACKFILL_PRIORITY;
    if (trigger === "ledger_reconciliation" || trigger === "scheduled") {
      return AUTOMATIC_PRIORITY;
    }
    return AUTOMATIC_PRIORITY;
  }

  private async loadTransactions(
    instrumentIds: readonly string[],
  ): Promise<Map<string, TransactionRecord[]>> {
    const rows = await this.dependencies.db
      .prepare(
        `SELECT id, instrument_id AS instrumentId, trade_date AS tradeDate,
                side, quantity_decimal AS quantityDecimal, price_decimal AS priceDecimal,
                revision, created_at AS createdAt, updated_at AS updatedAt
         FROM transactions
         WHERE instrument_id IN (${instrumentIds.map((_id, i) => `?${i + 1}`).join(",")})
         ORDER BY instrument_id, trade_date, id`,
      )
      .bind(...instrumentIds)
      .all<TransactionRecord>();
    return this.groupBy(rows.results, (row) => row.instrumentId);
  }

  private async loadExchanges(
    instrumentIds: readonly string[],
  ): Promise<Map<string, string>> {
    const rows = await this.dependencies.db
      .prepare(
        `SELECT id, exchange
           FROM instruments
          WHERE id IN (${instrumentIds.map((_id, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...instrumentIds)
      .all<{ id: string; exchange: string }>();
    return new Map(rows.results.map((row) => [row.id, row.exchange]));
  }

  private async loadActions(
    instrumentIds: readonly string[],
  ): Promise<Map<string, CorporateActionRecord[]>> {
    const rows = await this.dependencies.db
      .prepare(
        `SELECT id, instrument_id AS instrumentId, effective_date AS effectiveDate,
                split_numerator AS splitNumerator, split_denominator AS splitDenominator,
                provider, provider_event_id AS providerEventId,
                provider_revision AS providerRevision, retrieved_at AS retrievedAt,
                revision, status, conflict_code AS conflictCode,
                conflict_message AS conflictMessage, created_at AS createdAt,
                updated_at AS updatedAt
         FROM corporate_actions
         WHERE instrument_id IN (${instrumentIds.map((_id, i) => `?${i + 1}`).join(",")})
           AND status = 'active'
         ORDER BY instrument_id, effective_date, id`,
      )
      .bind(...instrumentIds)
      .all<CorporateActionRecord>();
    return this.groupBy(rows.results, (row) => row.instrumentId);
  }

  private groupBy<T>(
    rows: readonly T[],
    key: (row: T) => string,
  ): Map<string, T[]> {
    const result = new Map<string, T[]>();
    for (const row of rows) {
      const group = result.get(key(row)) ?? [];
      group.push(row);
      result.set(key(row), group);
    }
    return result;
  }
}

export const createReconciliationPlanner = (
  dependencies: ReconciliationPlannerDependencies,
) => new ReconciliationPlannerService(dependencies);

export { ReconciliationPlannerService as ReconciliationPlanner };
