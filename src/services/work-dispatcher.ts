import {
  type DispatchBatchRecord,
  DispatchBatchRepository,
} from "../db/dispatch-batches";
import { type WorkItemRecord, WorkItemRepository } from "../db/work-items";
import type { PipelineDispatchMessage } from "../shared/contracts";

const MARKET_FACT_WORK_TYPE = "market_fact";
const DEFAULT_DAILY_CEILING = 2_500;
const DEFAULT_MAX_BATCH_DAYS = 90;
const DEFAULT_DISPATCH_LEASE_MS = 5 * 60_000;

export interface WorkDispatcherDependencies {
  db: D1Database;
  queue: Queue<PipelineDispatchMessage>;
  now?: () => Date;
  newId?: () => string;
  dailyCeiling?: number;
  maxBatchCalendarDays?: number;
  dispatchLeaseMs?: number;
}

export interface DispatchWorkInput {
  maxWorkItems?: number;
}

export interface DispatchResult {
  dispatchedBatches: number;
  dispatchedWorkItems: number;
  sentBatches: number;
  sendFailures: number;
  recoveredDispatchBatches: number;
  recoveredProcessingBatches: number;
  ceilingRemaining: number;
}

interface WorkItemRow {
  id: string;
  scope: WorkItemRecord["scope"];
  pipelineJobId: string | null;
  workType: string;
  instrumentId: string | null;
  effectiveDate: string | null;
  dependencyRevision: string | null;
  forcedRefreshGeneration: number | null;
  deterministicKey: string;
  state: WorkItemRecord["state"];
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  dispatchLeaseUntil: string | null;
  processingLeaseUntil: string | null;
  resultRevision: string | null;
  terminalErrorCode: string | null;
  terminalErrorMessage: string | null;
  availableAt: string | null;
  retentionUntil: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface DispatchGroup {
  work: WorkItemRecord[];
  priority: number;
  workType: string;
  instrumentId: string;
  requestedStartDate: string;
  requestedEndDate: string;
}

const nextDate = (date: string): string => {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
};

const calendarDays = (startDate: string, endDate: string): number =>
  Math.floor(
    (Date.parse(`${endDate}T12:00:00.000Z`) -
      Date.parse(`${startDate}T12:00:00.000Z`)) /
      86_400_000,
  ) + 1;

const mapWork = (row: WorkItemRow): WorkItemRecord => ({
  id: row.id,
  scope: row.scope,
  pipelineJobId: row.pipelineJobId,
  workType: row.workType,
  instrumentId: row.instrumentId,
  effectiveDate: row.effectiveDate,
  dependencyRevision: row.dependencyRevision,
  forcedRefreshGeneration: row.forcedRefreshGeneration,
  deterministicKey: row.deterministicKey,
  state: row.state,
  priority: row.priority,
  attemptCount: row.attemptCount,
  maxAttempts: row.maxAttempts,
  dispatchLeaseUntil: row.dispatchLeaseUntil,
  processingLeaseUntil: row.processingLeaseUntil,
  resultRevision: row.resultRevision,
  terminalErrorCode: row.terminalErrorCode,
  terminalErrorMessage: row.terminalErrorMessage,
  availableAt: row.availableAt,
  retentionUntil: row.retentionUntil,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  completedAt: row.completedAt,
});

export class WorkDispatcherService {
  private readonly batches: DispatchBatchRepository;
  private readonly workItems: WorkItemRepository;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly dailyCeiling: number;
  private readonly maxBatchCalendarDays: number;
  private readonly dispatchLeaseMs: number;

  constructor(private readonly dependencies: WorkDispatcherDependencies) {
    this.batches = new DispatchBatchRepository(dependencies.db);
    this.workItems = new WorkItemRepository(dependencies.db);
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
    this.dailyCeiling = dependencies.dailyCeiling ?? DEFAULT_DAILY_CEILING;
    this.maxBatchCalendarDays = Math.min(
      DEFAULT_MAX_BATCH_DAYS,
      Math.max(
        1,
        Math.floor(dependencies.maxBatchCalendarDays ?? DEFAULT_MAX_BATCH_DAYS),
      ),
    );
    this.dispatchLeaseMs = Math.max(
      1_000,
      Math.floor(dependencies.dispatchLeaseMs ?? DEFAULT_DISPATCH_LEASE_MS),
    );
  }

  async dispatch(input: DispatchWorkInput = {}): Promise<DispatchResult> {
    const timestamp = this.now().toISOString();
    const recovered = await this.recover(timestamp);
    let dispatchedBatches = 0;
    let dispatchedWorkItems = 0;
    let sentBatches = 0;
    let sendFailures = 0;

    for (const batchId of recovered.dispatchBatchIds) {
      const sent = await this.sendExisting(batchId, timestamp);
      if (sent) sentBatches += 1;
      else sendFailures += 1;
    }
    for (const batchId of recovered.processingBatchIds) {
      const sent = await this.sendQueued(batchId);
      if (sent) sentBatches += 1;
      else sendFailures += 1;
    }

    const dayStart = `${timestamp.slice(0, 10)}T00:00:00.000Z`;
    const dispatchedToday = await this.countDispatchedWork(dayStart);
    const ceilingRemaining = Math.max(0, this.dailyCeiling - dispatchedToday);
    const requested = input.maxWorkItems ?? ceilingRemaining;
    const allowance = Math.max(0, Math.min(ceilingRemaining, requested));
    if (allowance === 0) {
      return {
        dispatchedBatches,
        dispatchedWorkItems,
        sentBatches,
        sendFailures,
        recoveredDispatchBatches: recovered.dispatchBatchIds.length,
        recoveredProcessingBatches: recovered.processingBatchIds.length,
        ceilingRemaining,
      };
    }

    const pending = await this.listPendingWork(allowance);
    const groups = this.buildGroups(pending);
    let remaining = allowance;
    for (const group of groups) {
      if (remaining <= 0) break;
      const selected = group.work.slice(0, remaining);
      const leaseUntil = new Date(
        Date.parse(timestamp) + this.dispatchLeaseMs,
      ).toISOString();
      const claimed: WorkItemRecord[] = [];
      for (const item of selected) {
        if (
          await this.workItems.claimForDispatch({
            id: item.id,
            now: timestamp,
            leaseUntil,
          })
        ) {
          claimed.push({
            ...item,
            state: "dispatching",
            dispatchLeaseUntil: leaseUntil,
            updatedAt: timestamp,
          });
        }
      }
      if (claimed.length === 0) continue;

      const batch: DispatchBatchRecord = {
        id: this.newId(),
        workType: group.workType,
        instrumentId: group.instrumentId,
        requestedStartDate:
          claimed[0]?.effectiveDate ?? group.requestedStartDate,
        requestedEndDate:
          claimed.at(-1)?.effectiveDate ?? group.requestedEndDate,
        state: "dispatching",
        dispatchLeaseUntil: leaseUntil,
        processingLeaseUntil: null,
        attemptCount: 0,
        maxAttempts: 3,
        terminalErrorCode: null,
        terminalErrorMessage: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        retentionUntil: null,
      };
      try {
        await this.batches.createForWork({ batch, work: claimed });
      } catch (error) {
        await Promise.all(
          claimed.map((item) =>
            this.workItems.releaseDispatchClaim({
              id: item.id,
              expectedLeaseUntil: leaseUntil,
              now: timestamp,
            }),
          ),
        );
        if (/dispatch_batch/i.test(String(error))) continue;
        throw error;
      }
      dispatchedBatches += 1;
      dispatchedWorkItems += claimed.length;
      remaining -= claimed.length;
      const sent = await this.sendBatch(batch);
      if (sent) sentBatches += 1;
      else sendFailures += 1;
    }

    return {
      dispatchedBatches,
      dispatchedWorkItems,
      sentBatches,
      sendFailures,
      recoveredDispatchBatches: recovered.dispatchBatchIds.length,
      recoveredProcessingBatches: recovered.processingBatchIds.length,
      ceilingRemaining: Math.max(0, ceilingRemaining - dispatchedWorkItems),
    };
  }

  async run(input: DispatchWorkInput = {}): Promise<DispatchResult> {
    return this.dispatch(input);
  }

  async dispatchPending(
    input: DispatchWorkInput = {},
  ): Promise<DispatchResult> {
    return this.dispatch(input);
  }

  private async sendBatch(batch: DispatchBatchRecord): Promise<boolean> {
    if (!batch.dispatchLeaseUntil) return false;
    try {
      await this.dependencies.queue.send({ dispatchBatchId: batch.id });
    } catch {
      return false;
    }
    const transitioned = await this.batches.transition({
      id: batch.id,
      from: "dispatching",
      to: "queued",
      now: this.now().toISOString(),
      expectedDispatchLeaseUntil: batch.dispatchLeaseUntil,
    });
    if (transitioned) {
      await this.workItems.queueBatchItems({
        dispatchBatchId: batch.id,
        now: this.now().toISOString(),
      });
    }
    return true;
  }

  private async sendExisting(
    batchId: string,
    timestamp: string,
  ): Promise<boolean> {
    const batch = await this.batches.findById(batchId);
    if (batch?.state !== "dispatching" || !batch.dispatchLeaseUntil) {
      return false;
    }
    try {
      await this.dependencies.queue.send({ dispatchBatchId: batch.id });
    } catch {
      return false;
    }
    const transitioned = await this.batches.transition({
      id: batch.id,
      from: "dispatching",
      to: "queued",
      now: timestamp,
      expectedDispatchLeaseUntil: batch.dispatchLeaseUntil,
    });
    if (transitioned) {
      await this.workItems.queueBatchItems({
        dispatchBatchId: batch.id,
        now: timestamp,
      });
    }
    return true;
  }

  private async sendQueued(batchId: string): Promise<boolean> {
    const batch = await this.batches.findById(batchId);
    if (batch?.state !== "queued") return false;
    try {
      await this.dependencies.queue.send({ dispatchBatchId: batch.id });
      return true;
    } catch {
      return false;
    }
  }

  private async countDispatchedWork(dayStart: string): Promise<number> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT COUNT(*) AS count FROM dispatch_batch_items
         WHERE created_at >= ?1`,
      )
      .bind(dayStart)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  private async listPendingWork(limit: number): Promise<WorkItemRecord[]> {
    const rows = await this.dependencies.db
      .prepare(
        `SELECT id, scope, pipeline_job_id AS pipelineJobId,
                work_type AS workType, instrument_id AS instrumentId,
                effective_date AS effectiveDate,
                dependency_revision AS dependencyRevision,
                forced_refresh_generation AS forcedRefreshGeneration,
                deterministic_key AS deterministicKey, state, priority,
                attempt_count AS attemptCount, max_attempts AS maxAttempts,
                dispatch_lease_until AS dispatchLeaseUntil,
                processing_lease_until AS processingLeaseUntil,
                result_revision AS resultRevision,
                terminal_error_code AS terminalErrorCode,
                terminal_error_message AS terminalErrorMessage,
                available_at AS availableAt,
                retention_until AS retentionUntil,
                created_at AS createdAt, updated_at AS updatedAt,
                completed_at AS completedAt
         FROM work_items
         WHERE scope = 'global_fact' AND state = 'pending'
           AND attempt_count < max_attempts
           AND (available_at IS NULL OR available_at <= ?1)
         ORDER BY priority DESC, effectiveDate, instrumentId, workType, id
         LIMIT ?2`,
      )
      .bind(this.now().toISOString(), limit)
      .all<WorkItemRow>();
    return rows.results.map(mapWork);
  }

  private buildGroups(work: readonly WorkItemRecord[]): DispatchGroup[] {
    const market = new Map<string, WorkItemRecord[]>();
    const other: WorkItemRecord[] = [];
    for (const item of work) {
      if (
        item.instrumentId &&
        item.effectiveDate &&
        item.workType === MARKET_FACT_WORK_TYPE
      ) {
        const key = `${item.workType}:${item.instrumentId}:${item.priority}`;
        const list = market.get(key) ?? [];
        list.push(item);
        market.set(key, list);
      } else {
        other.push(item);
      }
    }
    const groups: DispatchGroup[] = [];
    for (const items of market.values()) {
      const sorted = [...items].sort((left, right) =>
        (left.effectiveDate ?? "").localeCompare(right.effectiveDate ?? ""),
      );
      let current: WorkItemRecord[] = [];
      for (const item of sorted) {
        const previous = current.at(-1);
        const contiguous =
          previous?.effectiveDate !== null &&
          previous?.effectiveDate !== undefined &&
          item.effectiveDate === nextDate(previous.effectiveDate);
        const withinLimit =
          current.length === 0 ||
          calendarDays(
            current[0]?.effectiveDate ?? item.effectiveDate ?? "",
            item.effectiveDate ?? "",
          ) <= this.maxBatchCalendarDays;
        if (current.length > 0 && (!contiguous || !withinLimit)) {
          groups.push(this.groupFrom(current));
          current = [];
        }
        current.push(item);
      }
      if (current.length > 0) groups.push(this.groupFrom(current));
    }
    for (const item of other) {
      if (!item.instrumentId || !item.effectiveDate) continue;
      groups.push(this.groupFrom([item]));
    }
    return groups.sort(
      (left, right) =>
        right.priority - left.priority ||
        left.requestedStartDate.localeCompare(right.requestedStartDate) ||
        left.instrumentId.localeCompare(right.instrumentId),
    );
  }

  private groupFrom(work: WorkItemRecord[]): DispatchGroup {
    const first = work[0];
    const last = work.at(-1) ?? first;
    if (!first?.instrumentId || !first.effectiveDate || !last?.effectiveDate) {
      throw new Error("dispatch_work_missing_identity");
    }
    return {
      work,
      priority: Math.max(...work.map((item) => item.priority)),
      workType: first.workType,
      instrumentId: first.instrumentId,
      requestedStartDate: first.effectiveDate,
      requestedEndDate: last.effectiveDate,
    };
  }

  private async recover(timestamp: string): Promise<{
    dispatchBatchIds: string[];
    processingBatchIds: string[];
  }> {
    await this.workItems.recoverOrphanedDispatches(timestamp);
    const expiredDispatches = await this.dependencies.db
      .prepare(
        `SELECT id, dispatch_lease_until AS leaseUntil
         FROM dispatch_batches
         WHERE state = 'dispatching' AND dispatch_lease_until IS NOT NULL
           AND dispatch_lease_until <= ?1`,
      )
      .bind(timestamp)
      .all<{ id: string; leaseUntil: string }>();
    const dispatchBatchIds: string[] = [];
    for (const row of expiredDispatches.results) {
      const leaseUntil = new Date(
        Date.parse(timestamp) + this.dispatchLeaseMs,
      ).toISOString();
      if (
        await this.batches.reclaimExpiredDispatch({
          id: row.id,
          expectedLeaseUntil: row.leaseUntil,
          now: timestamp,
          leaseUntil,
        })
      ) {
        dispatchBatchIds.push(row.id);
      }
    }

    const expiredProcessing = await this.dependencies.db
      .prepare(
        `SELECT id, processing_lease_until AS leaseUntil
         FROM dispatch_batches
         WHERE state = 'processing' AND processing_lease_until IS NOT NULL
           AND processing_lease_until <= ?1`,
      )
      .bind(timestamp)
      .all<{ id: string; leaseUntil: string }>();
    const processingBatchIds: string[] = [];
    for (const row of expiredProcessing.results) {
      if (
        await this.batches.reclaimExpiredProcessing({
          id: row.id,
          expectedLeaseUntil: row.leaseUntil,
          now: timestamp,
        })
      ) {
        await this.workItems.requeueBatchItems({
          dispatchBatchId: row.id,
          now: timestamp,
        });
        processingBatchIds.push(row.id);
      }
    }
    return { dispatchBatchIds, processingBatchIds };
  }
}

export const createWorkDispatcher = (
  dependencies: WorkDispatcherDependencies,
) => new WorkDispatcherService(dependencies);

export {
  WorkDispatcherService as WorkDispatcher,
  WorkDispatcherService as PipelineWorkDispatcher,
};
