import type { CorporateActionRecord } from "../db/corporate-actions";
import type { PipelineJobRecord } from "../db/pipeline-jobs";
import { PipelineJobRepository } from "../db/pipeline-jobs";
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
  type Holdings,
  type LedgerTransaction,
} from "../domain/holdings";
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

interface InstrumentTimeline {
  holdings: Holdings;
  actions: CorporateActionRecord[];
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

const parseCursor = (cursor: string | null | undefined): number => {
  if (cursor === undefined || cursor === null || cursor === "") return 0;
  if (!/^\d+$/.test(cursor)) throw new Error("invalid_planner_cursor");
  const value = Number(cursor);
  if (!Number.isSafeInteger(value)) throw new Error("invalid_planner_cursor");
  return value;
};

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
  private readonly workItems: WorkItemRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly marketDependencyRevision: string;
  private plannerLeaseSequence = 0;

  constructor(
    private readonly dependencies: ReconciliationPlannerDependencies,
  ) {
    this.jobs = new PipelineJobRepository(dependencies.db);
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
    const offset = parseCursor(input.cursor);
    const built = await this.buildCandidates(job, input);
    const page = built.candidates.slice(offset, offset + pageSize);
    const dividendOffset = parseCursor(input.dividendCursor);
    const dividendPage = built.dividendRecalculations.slice(
      dividendOffset,
      dividendOffset + pageSize,
    );
    let createdCount = 0;
    let reusedCount = 0;
    let attachedCount = 0;
    const globalWork: WorkItemRecord[] = [];
    for (const candidate of page) {
      const workRecord: GlobalFactWorkRecord = {
        id: this.newId(),
        workType: candidate.workType,
        instrumentId: candidate.instrumentId,
        effectiveDate: candidate.effectiveDate,
        dependencyRevision: candidate.dependencyRevision,
        forcedRefreshGeneration: candidate.forcedRefreshGeneration,
        deterministicKey: WorkItemRepository.globalFactKey(candidate),
        priority: candidate.priority,
        maxAttempts: 3,
        availableAt: timestamp,
        retentionUntil: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      const before = await this.workItems.findByDeterministicKey(
        workRecord.deterministicKey,
      );
      const work = await this.workItems.ensureGlobal(workRecord);
      await this.workItems
        .promotePriorityStatement({
          id: work.id,
          priority: candidate.priority,
          updatedAt: timestamp,
        })
        .run();
      const promotedWork = {
        ...work,
        priority: Math.max(work.priority, candidate.priority),
        updatedAt: timestamp,
      };
      if (!before) createdCount += 1;
      if (work.state === "complete") reusedCount += 1;
      const attached = await this.workItems.attachToJob({
        pipelineJobId,
        workItemId: work.id,
        relationship: "required",
        outcome:
          work.state === "complete"
            ? "reused"
            : work.state === "terminal"
              ? "failed"
              : "pending",
        now: timestamp,
      });
      if (attached) attachedCount += 1;
      globalWork.push(promotedWork);
    }
    const end = offset + page.length;
    const dividendEnd = dividendOffset + dividendPage.length;
    const globalComplete = end >= built.candidates.length;
    const dividendsComplete =
      dividendEnd >= built.dividendRecalculations.length;
    const complete = globalComplete && dividendsComplete;
    const nextCursor = globalComplete ? null : String(end);
    const nextDividendCursor = dividendsComplete ? null : String(dividendEnd);
    let returnedLease: string | null = leaseUntil;
    if (complete) {
      const completed = await this.workItems.completePlanning({
        id: planner.id,
        pipelineJobId,
        now: timestamp,
        expectedLeaseUntil: leaseUntil,
      });
      if (!completed) throw new Error("planner_completion_conflict");
      returnedLease = null;
    }
    if (complete && planningStatus === "planning") {
      await this.jobs.transition({
        id: pipelineJobId,
        from: "planning",
        to: "running",
        now: timestamp,
      });
    }
    await this.updateProgress(pipelineJobId, timestamp, built.skippedCount);
    return {
      pipelineJobId,
      plannerWorkItemId: planner.id,
      plannerLeaseUntil: returnedLease,
      complete,
      nextCursor,
      nextDividendCursor,
      createdCount,
      reusedCount,
      attachedCount,
      skippedCount: built.skippedCount,
      globalWork,
      dividendRecalculations: dividendPage,
      priority: built.priority,
    };
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

  private async buildCandidates(
    job: PipelineJobRecord,
    input: PlanReconciliationPageInput,
  ): Promise<{
    candidates: PlannerCandidate[];
    dividendRecalculations: PlannedDividendRecalculation[];
    skippedCount: number;
    priority: number;
  }> {
    const instruments = parseAffectedInstruments(job);
    if (instruments.length === 0) {
      return {
        candidates: [],
        dividendRecalculations: [],
        skippedCount: 0,
        priority: this.priorityFor(job.triggerType, false),
      };
    }
    const today = easternMarketDate(this.now());
    const latestCompleted = latestWeekday(
      input.latestCompletedTradingDate ?? today,
    );
    const previousCompleted =
      input.previousCompletedTradingDate ?? previousWeekday(latestCompleted);
    // Scheduled jobs normally omit a range; retain a valid lower bound so a
    // future backfill adapter can derive held intervals without passing an
    // invalid year-zero date through the holdings domain.
    const rangeStart = job.requestedStartDate ?? "1900-01-01";
    const rangeEnd = job.requestedEndDate ?? latestCompleted;
    const intervals = parseIntervals(job, instruments);
    const [transactions, actions, facts, analyses, dividends, workStates] =
      await Promise.all([
        this.loadTransactions(instruments),
        this.loadActions(instruments),
        this.loadFacts(instruments),
        this.loadAnalyses(instruments),
        this.loadDividends(instruments),
        this.loadWorkStates(instruments),
      ]);
    const timelines = new Map<string, InstrumentTimeline>();
    for (const instrumentId of instruments) {
      const instrumentActions = actions.get(instrumentId) ?? [];
      timelines.set(instrumentId, {
        actions: instrumentActions,
        holdings: deriveHoldings({
          today,
          transactions: (transactions.get(instrumentId) ?? []).map(
            toLedgerTransaction,
          ),
          activeSplits: instrumentActions.map(toActiveSplit),
        }),
      });
    }
    const requestedDates = new Map<string, Set<string>>();
    const addDate = (
      instrumentId: string,
      date: string,
      allowBeforeRangeStart = false,
    ) => {
      if (
        (!allowBeforeRangeStart && date < rangeStart) ||
        date > rangeEnd ||
        date > latestCompleted
      )
        return;
      const dates = requestedDates.get(instrumentId) ?? new Set<string>();
      dates.add(date);
      requestedDates.set(instrumentId, dates);
    };
    const intervalsByInstrument = new Map<string, EligibilityInterval[]>();
    for (const interval of intervals) {
      if (!interval.instrumentId) continue;
      const list = intervalsByInstrument.get(interval.instrumentId) ?? [];
      list.push(interval);
      intervalsByInstrument.set(interval.instrumentId, list);
    }
    for (const instrumentId of instruments) {
      const timeline = timelines.get(instrumentId);
      if (!timeline) continue;
      let instrumentIntervals = intervalsByInstrument.get(instrumentId) ?? [];
      if (instrumentIntervals.length === 0 && job.triggerType === "backfill") {
        instrumentIntervals = timeline.holdings.heldIntervals({
          startDate: rangeStart,
          endDate: rangeEnd,
        });
      }
      for (const interval of instrumentIntervals) {
        const start =
          interval.startDate < rangeStart ? rangeStart : interval.startDate;
        const end = interval.endDate > rangeEnd ? rangeEnd : interval.endDate;
        for (let date = start; date <= end; date = nextDate(date)) {
          if (timeline.holdings.isEligibleForScreening(date))
            addDate(instrumentId, date);
        }
      }
      if (
        job.triggerType === "scheduled" &&
        timeline.holdings.isEligibleForScreening(latestCompleted)
      ) {
        addDate(instrumentId, latestCompleted);
      }
      const firstCurrentBuy =
        timeline.holdings.currentQuantity() !== "0" &&
        timeline.holdings.quantityAtStartOfDay(latestCompleted) === "0";
      const reconciliationTouchesCurrentDay = instrumentIntervals.some(
        (interval) =>
          interval.startDate <= latestCompleted &&
          interval.endDate >= latestCompleted,
      );
      if (
        job.triggerType === "ledger_reconciliation" &&
        timeline.holdings.currentQuantity() !== "0" &&
        (reconciliationTouchesCurrentDay || firstCurrentBuy)
      ) {
        addDate(instrumentId, latestCompleted);
        addDate(instrumentId, previousCompleted, firstCurrentBuy);
      }
    }
    const forcedGeneration =
      input.forcedRefreshGeneration ??
      (input.forceRefresh || input.reprocessExisting ? 1 : null);
    const candidates: PlannerCandidate[] = [];
    let skippedCount = 0;
    for (const [instrumentId, dates] of requestedDates) {
      const timeline = timelines.get(instrumentId);
      if (!timeline) continue;
      const instrumentFacts = facts.get(instrumentId) ?? new Map();
      const instrumentAnalyses = analyses.get(instrumentId) ?? new Map();
      const instrumentWork = workStates.get(instrumentId) ?? new Map();
      for (const date of [...dates].sort()) {
        const fact = instrumentFacts.get(date);
        const splitRatio = fact ? ratio(timeline.actions, fact) : null;
        const splitChanged =
          fact !== undefined &&
          splitRatio !== null &&
          (fact.crossing_split_numerator !== splitRatio.numerator ||
            fact.crossing_split_denominator !== splitRatio.denominator);
        const needsMarket =
          forcedGeneration !== null ||
          fact === undefined ||
          fact.status !== "valid" ||
          fact.movement_basis === "legacy_migration" ||
          splitChanged;
        const currentPriority = this.priorityFor(
          job.triggerType,
          date === latestCompleted,
        );
        if (needsMarket) {
          let dependencyRevision =
            fact?.provider_revision ?? this.marketDependencyRevision;
          if (splitChanged && fact) {
            dependencyRevision = `${dependencyRevision}:split:${splitFingerprint(
              timeline.actions,
              fact,
            )}`;
          }
          const baseKey = WorkItemRepository.globalFactKey({
            workType: MARKET_FACT_WORK_TYPE,
            instrumentId,
            effectiveDate: date,
            dependencyRevision,
            forcedRefreshGeneration: forcedGeneration,
          });
          const existing = instrumentWork.get(baseKey);
          if (
            existing &&
            (existing === "complete" || existing === "terminal") &&
            fact !== undefined
          ) {
            dependencyRevision = `${dependencyRevision}:refresh:${fact.updated_at}`;
          }
          candidates.push({
            workType: MARKET_FACT_WORK_TYPE,
            instrumentId,
            effectiveDate: date,
            dependencyRevision,
            forcedRefreshGeneration: forcedGeneration,
            priority: currentPriority,
          });
          continue;
        }
        if (!fact || !isQualifiedMovement(fact)) {
          skippedCount += 1;
          continue;
        }
        const analysis = instrumentAnalyses.get(fact.id);
        const analysisIsFresh =
          analysis?.status === "complete" &&
          analysis.updated_at >= fact.updated_at;
        if (!analysisIsFresh) {
          let dependencyRevision = fact.provider_revision;
          const analysisKey = WorkItemRepository.globalFactKey({
            workType: ANALYSIS_WORK_TYPE,
            instrumentId,
            effectiveDate: date,
            dependencyRevision,
            forcedRefreshGeneration: null,
          });
          const existing = instrumentWork.get(analysisKey);
          if (
            existing &&
            (existing === "complete" || existing === "terminal")
          ) {
            dependencyRevision = `${dependencyRevision}:analysis:${analysis?.updated_at ?? fact.updated_at}`;
          }
          candidates.push({
            workType: ANALYSIS_WORK_TYPE,
            instrumentId,
            effectiveDate: date,
            dependencyRevision,
            forcedRefreshGeneration: null,
            priority: currentPriority,
          });
        } else {
          skippedCount += 1;
        }
      }
    }
    const dividendRecalculations = [
      ...new Map(
        dividends.flatMap((event) => {
          const list = intervalsByInstrument.get(event.instrument_id) ?? [];
          return list.some(
            (interval) =>
              interval.startDate <= event.ex_date &&
              interval.endDate >= event.ex_date,
          )
            ? [
                [
                  `${event.instrument_id}:${event.ex_date}`,
                  {
                    instrumentId: event.instrument_id,
                    exDate: event.ex_date,
                  },
                ] as const,
              ]
            : [];
        }),
      ).values(),
    ];
    candidates.sort((left, right) => {
      if (left.priority !== right.priority)
        return right.priority - left.priority;
      return `${left.effectiveDate}|${left.instrumentId}|${left.workType}|${left.dependencyRevision}`.localeCompare(
        `${right.effectiveDate}|${right.instrumentId}|${right.workType}|${right.dependencyRevision}`,
      );
    });
    return {
      candidates,
      dividendRecalculations,
      skippedCount,
      priority: Math.max(
        ...candidates.map((candidate) => candidate.priority),
        this.priorityFor(job.triggerType, false),
      ),
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

  private async loadFacts(
    instrumentIds: readonly string[],
  ): Promise<Map<string, Map<string, FactRow>>> {
    const rows = await this.dependencies.db
      .prepare(
        `SELECT id, instrument_id, trading_date, previous_trading_date,
                current_raw_close_decimal, crossing_split_numerator,
                crossing_split_denominator, movement_percent_decimal,
                movement_basis, provider_revision, status, updated_at
         FROM daily_market_facts
         WHERE instrument_id IN (${instrumentIds.map((_id, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...instrumentIds)
      .all<FactRow>();
    const result = new Map<string, Map<string, FactRow>>();
    for (const row of rows.results) {
      const facts = result.get(row.instrument_id) ?? new Map<string, FactRow>();
      facts.set(row.trading_date, row);
      result.set(row.instrument_id, facts);
    }
    return result;
  }

  private async loadAnalyses(
    instrumentIds: readonly string[],
  ): Promise<Map<string, Map<string, AnalysisRow>>> {
    const rows = await this.dependencies.db
      .prepare(
        `SELECT f.instrument_id, a.daily_market_fact_id,
                a.status, a.updated_at
         FROM movement_analyses a
         JOIN daily_market_facts f ON f.id = a.daily_market_fact_id
         WHERE f.instrument_id IN (${instrumentIds.map((_id, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...instrumentIds)
      .all<AnalysisRow & { instrument_id: string }>();
    const result = new Map<string, Map<string, AnalysisRow>>();
    for (const row of rows.results) {
      const analyses =
        result.get(row.instrument_id) ?? new Map<string, AnalysisRow>();
      analyses.set(row.daily_market_fact_id, row);
      result.set(row.instrument_id, analyses);
    }
    return result;
  }

  private async loadDividends(
    instrumentIds: readonly string[],
  ): Promise<DividendDateRow[]> {
    const rows = await this.dependencies.db
      .prepare(
        `SELECT instrument_id, ex_date
         FROM dividend_events
         WHERE instrument_id IN (${instrumentIds.map((_id, i) => `?${i + 1}`).join(",")})
           AND status = 'active'
         ORDER BY instrument_id, ex_date`,
      )
      .bind(...instrumentIds)
      .all<DividendDateRow>();
    return rows.results;
  }

  private async loadWorkStates(
    instrumentIds: readonly string[],
  ): Promise<Map<string, Map<string, WorkItemRecord["state"]>>> {
    const rows = await this.dependencies.db
      .prepare(
        `SELECT instrument_id, deterministic_key, state
         FROM work_items
         WHERE scope = 'global_fact'
           AND instrument_id IN (${instrumentIds.map((_id, i) => `?${i + 1}`).join(",")})`,
      )
      .bind(...instrumentIds)
      .all<WorkStateRow & { instrument_id: string }>();
    const result = new Map<string, Map<string, WorkItemRecord["state"]>>();
    for (const row of rows.results) {
      const work = result.get(row.instrument_id) ?? new Map();
      work.set(row.deterministic_key, row.state);
      result.set(row.instrument_id, work);
    }
    return result;
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

  private async updateProgress(
    id: string,
    now: string,
    skippedCount: number,
  ): Promise<void> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT
           COUNT(*) AS workTotal,
           SUM(CASE WHEN link.outcome = 'reused' THEN 1 ELSE 0 END) AS workReused,
           SUM(CASE WHEN link.outcome = 'skipped' THEN 1 ELSE 0 END) AS workSkipped,
           SUM(CASE WHEN link.outcome = 'failed' THEN 1 ELSE 0 END) AS workFailed,
           SUM(CASE WHEN work.work_type = 'market_fact' AND work.state = 'complete' THEN 1 ELSE 0 END) AS workFetched,
           SUM(CASE WHEN work.work_type = 'analysis' AND work.state = 'complete' THEN 1 ELSE 0 END) AS workAnalyzed,
           SUM(CASE WHEN work.state = 'complete' THEN 1 ELSE 0 END) AS workProcessed
         FROM job_work_items link
         JOIN work_items work ON work.id = link.work_item_id
         WHERE link.pipeline_job_id = ?1 AND work.scope = 'global_fact'`,
      )
      .bind(id)
      .first<{
        workTotal: number | null;
        workReused: number | null;
        workSkipped: number | null;
        workFailed: number | null;
        workFetched: number | null;
        workAnalyzed: number | null;
        workProcessed: number | null;
      }>();
    await this.jobs.updateProgress({
      id,
      now,
      progress: {
        workTotal:
          (row?.workTotal ?? 0) + Math.max(row?.workSkipped ?? 0, skippedCount),
        workReused: row?.workReused ?? 0,
        workSkipped: Math.max(row?.workSkipped ?? 0, skippedCount),
        workFetched: row?.workFetched ?? 0,
        workAnalyzed: row?.workAnalyzed ?? 0,
        workProcessed: row?.workProcessed ?? 0,
        workFailed: row?.workFailed ?? 0,
      },
    });
  }
}

export const createReconciliationPlanner = (
  dependencies: ReconciliationPlannerDependencies,
) => new ReconciliationPlannerService(dependencies);

export { ReconciliationPlannerService as ReconciliationPlanner };
