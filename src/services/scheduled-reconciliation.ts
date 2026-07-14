/**
 * Scheduling primitives for the normalized portfolio pipeline.
 *
 * Cloudflare exposes cron timestamps in UTC.  Keep conversion and idempotency
 * in this small service so the Worker entrypoint only wires existing Plan 2
 * services and does not duplicate reconciliation rules.
 */

import { isMarketHolidayForExchange } from "../domain/market-calendar";

export {
  isCanadianMarketHoliday,
  isMarketHolidayForExchange,
  isTorontoMarketHoliday,
  isUsMarketHoliday,
} from "../domain/market-calendar";

export const TORONTO_TIME_ZONE = "America/Toronto";
export const NORMALIZED_PLANNER_CRONS = [
  "30 20 * * MON-FRI",
  "30 21 * * MON-FRI",
] as const;
export const NORMALIZED_DISPATCH_CRON = "*/15 * * * *" as const;
export const DELAYED_BAR_HORIZON_MS = 6 * 60 * 60 * 1000;

export interface TorontoLocalParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  weekday: string;
}

const localFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TORONTO_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  weekday: "short",
  hourCycle: "h23",
});

export const torontoLocalParts = (instant: Date): TorontoLocalParts => {
  const parts = localFormatter.formatToParts(instant);
  const value = (type: keyof TorontoLocalParts): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    weekday: value("weekday"),
  };
};

export const torontoTradingDate = (instant: Date): string => {
  const parts = torontoLocalParts(instant);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const isTorontoWeekday = (instant: Date): boolean => {
  const weekday = torontoLocalParts(instant).weekday;
  return weekday !== "Sat" && weekday !== "Sun";
};

export const isTorontoPlannerTrigger = (instant: Date): boolean => {
  const parts = torontoLocalParts(instant);
  return (
    isTorontoWeekday(instant) && parts.hour === "16" && parts.minute === "30"
  );
};

/**
 * A stable key for a Toronto trading date.  Both UTC cron candidates map to
 * the same key, making the second candidate an explicit no-op.
 */
export const scheduledPlannerJobId = (tradingDate: string): string =>
  `scheduled:portfolio:${tradingDate}`;

export const delayedBarDeadline = (scheduledAt: Date): string =>
  new Date(scheduledAt.getTime() + DELAYED_BAR_HORIZON_MS).toISOString();

export const isWithinDelayedBarHorizon = (
  scheduledAt: Date,
  now: Date,
): boolean => now.getTime() <= scheduledAt.getTime() + DELAYED_BAR_HORIZON_MS;

const dateAtNoonUtc = (date: string): Date => new Date(`${date}T12:00:00.000Z`);

const formatDate = (value: Date): string => value.toISOString().slice(0, 10);

export const previousTorontoWeekday = (date: string): string => {
  let value = dateAtNoonUtc(date);
  do {
    value = new Date(value.getTime() - 86_400_000);
  } while (value.getUTCDay() === 0 || value.getUTCDay() === 6);
  return formatDate(value);
};

const latestTorontoWeekday = (date: string): string => {
  let value = dateAtNoonUtc(date);
  while (value.getUTCDay() === 0 || value.getUTCDay() === 6) {
    value = new Date(value.getTime() - 86_400_000);
  }
  return formatDate(value);
};

import {
  type PipelineJobRecord,
  PipelineJobRepository,
} from "../db/pipeline-jobs";
import {
  RESUMABLE_PLANNING_MAX_ATTEMPTS,
  WorkItemRepository,
} from "../db/work-items";
import { deriveHoldings } from "../domain/holdings";
import { ReconciliationPlannerService } from "./reconciliation-planner";

export interface ScheduledReconciliationDependencies {
  db: D1Database;
  queue?: Queue<import("../shared/contracts").PipelineDispatchMessage>;
  dlq?: Queue<import("../shared/contracts").PipelineDispatchMessage>;
  now?: () => Date;
  newId?: () => string;
  isMarketHoliday?: (date: string, exchange?: string) => boolean;
  plannerPageSize?: number;
}

export type ScheduledPlannerResult =
  | {
      kind: "planned";
      pipelineJobId: string;
      tradingDate: string;
      pages: number;
      workItems: number;
    }
  | { kind: "duplicate"; pipelineJobId: string; tradingDate: string }
  | {
      kind: "skipped";
      reason: "not_planner_trigger" | "weekend" | "holiday" | "no_positions";
    };

export interface AutomaticPlanningError {
  pipelineJobId: string;
  message: string;
}

export interface AutomaticPlanningResult {
  jobs: number;
  pages: number;
  workItems: number;
  errors: AutomaticPlanningError[];
}

const planningErrorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

interface InstrumentRow {
  id: string;
  exchange: string;
}

interface TransactionRow {
  id: string;
  instrument_id: string;
  trade_date: string;
  side: "buy" | "sell";
  quantity_decimal: string;
}

interface ActionRow {
  id: string;
  instrument_id: string;
  effective_date: string;
  split_numerator: string;
  split_denominator: string;
}

interface HeldInstrument {
  id: string;
  exchange: string;
}

const listHeldInstruments = async (
  db: D1Database,
  tradingDate: string,
): Promise<HeldInstrument[]> => {
  const [instruments, transactions, actions] = await Promise.all([
    db
      .prepare("SELECT id, exchange FROM instruments ORDER BY id")
      .all<InstrumentRow>(),
    db
      .prepare(
        `SELECT id, instrument_id, trade_date, side, quantity_decimal
         FROM transactions ORDER BY instrument_id, trade_date, id`,
      )
      .all<TransactionRow>(),
    db
      .prepare(
        `SELECT id, instrument_id, effective_date, split_numerator,
                split_denominator
         FROM corporate_actions WHERE status = 'active'
         ORDER BY instrument_id, effective_date, id`,
      )
      .all<ActionRow>(),
  ]);
  const transactionsByInstrument = new Map<string, TransactionRow[]>();
  for (const transaction of transactions.results) {
    const rows = transactionsByInstrument.get(transaction.instrument_id) ?? [];
    rows.push(transaction);
    transactionsByInstrument.set(transaction.instrument_id, rows);
  }
  const actionsByInstrument = new Map<string, ActionRow[]>();
  for (const action of actions.results) {
    const rows = actionsByInstrument.get(action.instrument_id) ?? [];
    rows.push(action);
    actionsByInstrument.set(action.instrument_id, rows);
  }
  return instruments.results.flatMap(({ id, exchange }) => {
    try {
      const holdings = deriveHoldings({
        today: tradingDate,
        transactions: (transactionsByInstrument.get(id) ?? []).map((row) => ({
          id: row.id,
          tradeDate: row.trade_date,
          side: row.side,
          quantityDecimal: row.quantity_decimal,
        })),
        activeSplits: (actionsByInstrument.get(id) ?? []).map((row) => ({
          id: row.id,
          effectiveDate: row.effective_date,
          numerator: row.split_numerator,
          denominator: row.split_denominator,
        })),
      });
      return holdings.isEligibleForScreening(tradingDate)
        ? [{ id, exchange }]
        : [];
    } catch {
      // Invalid ledger history is handled by the Events mutation guard.  A
      // scheduler must not create work for a position it cannot prove held.
      return [];
    }
  });
};

export class ScheduledReconciliationService {
  private readonly jobs: PipelineJobRepository;
  private readonly workItems: WorkItemRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly isMarketHoliday: (
    date: string,
    exchange?: string,
  ) => boolean;
  private readonly plannerPageSize: number;

  constructor(
    private readonly dependencies: ScheduledReconciliationDependencies,
  ) {
    this.jobs = new PipelineJobRepository(dependencies.db);
    this.workItems = new WorkItemRepository(dependencies.db);
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
    this.isMarketHoliday =
      dependencies.isMarketHoliday ??
      ((date, exchange = "") => isMarketHolidayForExchange(date, exchange));
    this.plannerPageSize = Math.min(
      1_000,
      Math.max(1, Math.floor(dependencies.plannerPageSize ?? 500)),
    );
  }

  async plan(triggerTime: Date = this.now()): Promise<ScheduledPlannerResult> {
    if (!isTorontoPlannerTrigger(triggerTime)) {
      return { kind: "skipped", reason: "not_planner_trigger" };
    }
    const tradingDate = torontoTradingDate(triggerTime);
    if (!isTorontoWeekday(triggerTime)) {
      return { kind: "skipped", reason: "weekend" };
    }
    const pipelineJobId = scheduledPlannerJobId(tradingDate);
    const existing = await this.jobs.findById(pipelineJobId);
    // Both UTC cron candidates are expected to hit this same deterministic
    // key around a DST transition.  Once a row exists, the later candidate is
    // an explicit no-op; the 15-minute dispatcher owns recovery of unfinished
    // D1 work rather than re-running planning here.
    if (existing) {
      return { kind: "duplicate", pipelineJobId, tradingDate };
    }
    const heldInstruments = await listHeldInstruments(
      this.dependencies.db,
      tradingDate,
    );
    if (heldInstruments.length === 0 && !existing) {
      return { kind: "skipped", reason: "no_positions" };
    }
    const instruments = heldInstruments.filter(
      (instrument) => !this.isMarketHoliday(tradingDate, instrument.exchange),
    );
    if (instruments.length === 0 && !existing) {
      return { kind: "skipped", reason: "holiday" };
    }
    const instrumentIds = instruments.map((instrument) => instrument.id);
    const timestamp = triggerTime.toISOString();
    if (!existing) {
      const plannerId = `${pipelineJobId}:planner`;
      const job: PipelineJobRecord = {
        id: pipelineJobId,
        triggerType: "scheduled",
        requestedStartDate: tradingDate,
        requestedEndDate: tradingDate,
        affectedInstrumentsJson: JSON.stringify(instrumentIds),
        eligibilityIntervalsJson: JSON.stringify(
          instrumentIds.map((instrumentId) => ({
            instrumentId,
            startDate: tradingDate,
            endDate: tradingDate,
          })),
        ),
        priority: 100,
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
        plannerCursor: null,
        plannerDividendCursor: null,
        plannerLeaseUntil: null,
      };
      try {
        await this.dependencies.db.batch([
          this.jobs.createStatement(job),
          this.workItems.createPlanningStatement({
            id: plannerId,
            pipelineJobId,
            workType: "scheduled_reconciliation_plan",
            deterministicKey: WorkItemRepository.planningKey(
              pipelineJobId,
              "scheduled_reconciliation_plan",
            ),
            priority: 100,
            maxAttempts: RESUMABLE_PLANNING_MAX_ATTEMPTS,
            createdAt: timestamp,
            updatedAt: timestamp,
          }),
          this.workItems.linkToJobStatement({
            pipelineJobId,
            workItemId: plannerId,
            relationship: "required",
            createdAt: timestamp,
          }),
        ]);
      } catch (error) {
        if (!/unique|constraint/i.test(String(error))) throw error;
        // Another scheduler invocation won the deterministic insert race.
        return { kind: "duplicate", pipelineJobId, tradingDate };
      }
    }
    const pageResult = await this.planPages(
      pipelineJobId,
      tradingDate,
      timestamp,
    );
    await this.completeIfSettled(pipelineJobId, timestamp);
    return {
      kind: "planned",
      pipelineJobId,
      tradingDate,
      pages: pageResult.pages,
      workItems: pageResult.workItems,
    };
  }

  /**
   * Continue bounded automatic planning from the recurring dispatcher.
   * Scheduled snapshots and ledger mutations both persist planning work, so
   * both must be resumable without a browser request remaining alive.
   */
  async continueAutomaticPlanning(
    at: Date = this.now(),
    maxJobs = 10,
  ): Promise<AutomaticPlanningResult> {
    const timestamp = at.toISOString();
    const rows = await this.dependencies.db
      .prepare(
        `SELECT id, requested_end_date AS requestedEndDate
         FROM pipeline_jobs
         WHERE trigger_type IN ('scheduled', 'ledger_reconciliation')
           AND status IN ('pending', 'planning', 'running')
         ORDER BY priority DESC, created_at, id
         LIMIT ?1`,
      )
      .bind(Math.max(1, Math.min(50, Math.floor(maxJobs))))
      .all<{ id: string; requestedEndDate: string | null }>();
    let pages = 0;
    let workItems = 0;
    const errors: AutomaticPlanningError[] = [];
    for (const row of rows.results) {
      try {
        const result = await this.planPages(
          row.id,
          row.requestedEndDate ?? torontoTradingDate(at),
          timestamp,
          1,
        );
        await this.completeIfSettled(row.id, timestamp);
        pages += result.pages;
        workItems += result.workItems;
      } catch (error) {
        const message = planningErrorMessage(error);
        errors.push({ pipelineJobId: row.id, message });
        try {
          await this.terminalizeExhaustedPlanner(row.id, timestamp, message);
        } catch (recoveryError) {
          errors.push({
            pipelineJobId: row.id,
            message: `planner_recovery_failed:${planningErrorMessage(recoveryError)}`,
          });
        }
      }
    }
    return { jobs: rows.results.length, pages, workItems, errors };
  }

  private async terminalizeExhaustedPlanner(
    pipelineJobId: string,
    timestamp: string,
    message: string,
  ): Promise<void> {
    const [job, planner] = await Promise.all([
      this.jobs.findById(pipelineJobId),
      this.workItems.findPlanningForJob(pipelineJobId),
    ]);
    if (
      !job ||
      !planner ||
      !["pending", "planning", "running"].includes(job.status) ||
      planner.state !== "processing" ||
      planner.processingLeaseUntil === null ||
      planner.processingLeaseUntil > timestamp ||
      planner.attemptCount < planner.maxAttempts
    ) {
      return;
    }
    const terminalized = await this.workItems.transition({
      id: planner.id,
      from: "processing",
      to: "terminal",
      now: timestamp,
      expectedProcessingLeaseUntil: planner.processingLeaseUntil,
      errorCode: "planner_attempts_exhausted",
      errorMessage: message,
    });
    if (terminalized) {
      await this.jobs.transition({
        id: pipelineJobId,
        from: job.status,
        to: "terminal",
        now: timestamp,
      });
    }
  }

  private async planPages(
    pipelineJobId: string,
    tradingDate: string,
    timestamp: string,
    maxPages = 10,
  ): Promise<{ pages: number; workItems: number }> {
    const latestCompletedTradingDate = latestTorontoWeekday(tradingDate);
    let pages = 0;
    let workItems = 0;
    for (; pages < maxPages; pages += 1) {
      const job = await this.jobs.findById(pipelineJobId);
      if (
        !job ||
        ["complete", "complete_with_errors", "terminal"].includes(job.status)
      )
        break;
      const planner = await this.workItems.findPlanningForJob(pipelineJobId);
      if (
        !planner ||
        planner.state === "complete" ||
        planner.state === "terminal"
      )
        break;
      const page = await new ReconciliationPlannerService({
        db: this.dependencies.db,
        now: () => new Date(timestamp),
        newId: this.newId,
      }).planPage({
        pipelineJobId,
        plannerWorkItemId: planner.id,
        ...(job.plannerCursor ? { cursor: job.plannerCursor } : {}),
        ...(job.plannerDividendCursor
          ? { dividendCursor: job.plannerDividendCursor }
          : {}),
        ...(planner.processingLeaseUntil
          ? { plannerLeaseUntil: planner.processingLeaseUntil }
          : {}),
        pageSize: this.plannerPageSize,
        latestCompletedTradingDate,
        previousCompletedTradingDate: previousTorontoWeekday(
          latestCompletedTradingDate,
        ),
      });
      workItems += page.globalWork.length;
      if (page.dividendRecalculations.length > 0) {
        await this.dependencies.db.batch(
          page.dividendRecalculations.map((event) =>
            this.dependencies.db
              .prepare(
                `INSERT OR IGNORE INTO pipeline_job_dividend_recalculations
                 (pipeline_job_id, instrument_id, ex_date, created_at)
                 VALUES (?1, ?2, ?3, ?4)`,
              )
              .bind(pipelineJobId, event.instrumentId, event.exDate, timestamp),
          ),
        );
      }
      if (
        !(await this.jobs.updatePlannerCursor({
          id: pipelineJobId,
          cursor: page.nextCursor,
          dividendCursor: page.nextDividendCursor,
          leaseUntil: page.plannerLeaseUntil,
          now: timestamp,
        }))
      ) {
        throw new Error("pipeline_planner_cursor_conflict");
      }
      if (page.complete) {
        pages += 1;
        break;
      }
    }
    return { pages, workItems };
  }

  private async completeIfSettled(
    pipelineJobId: string,
    timestamp: string,
  ): Promise<void> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT pipeline.status AS pipelineStatus,
                pipeline.planner_cursor AS plannerCursor,
                pipeline.planner_dividend_cursor AS plannerDividendCursor,
                planner.state AS plannerState,
                SUM(CASE WHEN link.outcome = 'pending'
                           AND work.scope = 'global_fact'
                           AND work.state IN ('pending', 'dispatching', 'queued', 'processing')
                         THEN 1 ELSE 0 END) AS unsettled,
                SUM(CASE WHEN work.scope = 'global_fact'
                           AND (work.state = 'terminal' OR link.outcome = 'failed')
                         THEN 1 ELSE 0 END) AS terminal
           FROM pipeline_jobs pipeline
           LEFT JOIN work_items planner
             ON planner.pipeline_job_id = pipeline.id
            AND planner.scope = 'job_planning'
           LEFT JOIN job_work_items link
             ON link.pipeline_job_id = pipeline.id
           LEFT JOIN work_items work
             ON work.id = link.work_item_id
          WHERE pipeline.id = ?1
          GROUP BY pipeline.id, planner.id`,
      )
      .bind(pipelineJobId)
      .first<{
        pipelineStatus: PipelineJobRecord["status"];
        plannerCursor: string | null;
        plannerDividendCursor: string | null;
        plannerState: string | null;
        unsettled: number | null;
        terminal: number | null;
      }>();
    if (
      !row ||
      !["pending", "planning", "running"].includes(row.pipelineStatus) ||
      row.plannerState !== "complete" ||
      row.plannerCursor !== null ||
      row.plannerDividendCursor !== null ||
      Number(row.unsettled ?? 0) > 0
    ) {
      return;
    }
    await this.jobs.transition({
      id: pipelineJobId,
      from: row.pipelineStatus,
      to: Number(row.terminal ?? 0) > 0 ? "complete_with_errors" : "complete",
      now: timestamp,
    });
  }
}
