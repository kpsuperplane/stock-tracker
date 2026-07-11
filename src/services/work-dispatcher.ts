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
  dlq?: Queue<PipelineDispatchMessage>;
  now?: () => Date;
  newId?: () => string;
  dailyCeiling?: number;
  maxBatchCalendarDays?: number;
  dispatchLeaseMs?: number;
  dispatchMaxAttempts?: number;
  dlqLeaseMs?: number;
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
  private readonly dispatchMaxAttempts: number;
  private readonly dlqLeaseMs: number;

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
    this.dispatchMaxAttempts = Math.max(
      1,
      Math.floor(dependencies.dispatchMaxAttempts ?? 3),
    );
    this.dlqLeaseMs = Math.max(
      1_000,
      Math.floor(dependencies.dlqLeaseMs ?? DEFAULT_DISPATCH_LEASE_MS),
    );
  }

  async dispatch(input: DispatchWorkInput = {}): Promise<DispatchResult> {
    const timestamp = this.now().toISOString();
    await this.batches.recoverExpiredDailyReservations(timestamp);
    await this.reconcileSettledLinks(timestamp);
    await this.recoverPendingDlq(timestamp);
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
      if (selected.length === 0) continue;

      const batch: DispatchBatchRecord = {
        id: this.newId(),
        workType: group.workType,
        instrumentId: group.instrumentId,
        requestedStartDate:
          selected[0]?.effectiveDate ?? group.requestedStartDate,
        requestedEndDate:
          selected.at(-1)?.effectiveDate ?? group.requestedEndDate,
        state: "dispatching",
        dispatchLeaseUntil: leaseUntil,
        processingLeaseUntil: null,
        attemptCount: 0,
        maxAttempts: 3,
        dispatchAttemptCount: 0,
        dispatchMaxAttempts: this.dispatchMaxAttempts,
        dlqState: "none",
        dlqAttemptCount: 0,
        dlqLeaseUntil: null,
        dlqLastError: null,
        dlqDeliveredAt: null,
        terminalErrorCode: null,
        terminalErrorMessage: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        completedAt: null,
        retentionUntil: null,
      };
      const reserved = await this.batches.reserveDailyCapacity({
        dispatchBatchId: batch.id,
        reservationDay: timestamp.slice(0, 10),
        workCount: selected.length,
        dailyCeiling: this.dailyCeiling,
        createdAt: timestamp,
        expiresAt: leaseUntil,
      });
      if (!reserved) break;
      try {
        await this.batches.createClaimedForWork({ batch, work: selected });
      } catch (error) {
        await this.batches.releaseDailyCapacity(batch.id);
        if (/dispatch_batch|constraint|unique/i.test(String(error))) continue;
        throw error;
      }
      dispatchedBatches += 1;
      dispatchedWorkItems += selected.length;
      remaining -= selected.length;
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
    return this.sendDispatching(batch.id, batch.dispatchLeaseUntil);
  }

  private async sendExisting(
    batchId: string,
    timestamp: string,
  ): Promise<boolean> {
    const batch = await this.batches.findById(batchId);
    if (batch?.state !== "dispatching" || !batch.dispatchLeaseUntil) {
      return false;
    }
    return this.sendDispatching(batch.id, batch.dispatchLeaseUntil, timestamp);
  }

  private async sendQueued(batchId: string): Promise<boolean> {
    const batch = await this.batches.findById(batchId);
    if (batch?.state !== "queued") return false;
    const timestamp = this.now().toISOString();
    if (
      !(await this.batches.claimDispatchAttempt({
        id: batch.id,
        now: timestamp,
      }))
    ) {
      const current = await this.batches.findById(batch.id);
      if (
        current?.state === "queued" &&
        (current.dispatchAttemptCount ?? 0) >=
          (current.dispatchMaxAttempts ?? 3)
      ) {
        await this.terminalizeDispatchBatch(current, timestamp);
      }
      return false;
    }
    try {
      await this.dependencies.queue.send({ dispatchBatchId: batch.id });
    } catch {
      const current = await this.batches.findById(batch.id);
      if (
        current?.state === "queued" &&
        (current.dispatchAttemptCount ?? 0) >=
          (current.dispatchMaxAttempts ?? 3)
      ) {
        await this.terminalizeDispatchBatch(current, timestamp);
      } else if (current?.state === "queued") {
        await this.batches.moveQueuedToDispatching({
          id: current.id,
          now: timestamp,
          leaseUntil: new Date(
            Date.parse(timestamp) + this.dispatchLeaseMs,
          ).toISOString(),
        });
      }
      return false;
    }
    return true;
  }

  private async sendDispatching(
    batchId: string,
    expectedLeaseUntil: string,
    timestamp = this.now().toISOString(),
  ): Promise<boolean> {
    if (
      !(await this.batches.claimDispatchAttempt({
        id: batchId,
        now: timestamp,
        expectedDispatchLeaseUntil: expectedLeaseUntil,
      }))
    ) {
      const current = await this.batches.findById(batchId);
      if (
        current?.state === "dispatching" &&
        (current.dispatchAttemptCount ?? 0) >=
          (current.dispatchMaxAttempts ?? 3)
      ) {
        await this.terminalizeDispatchBatch(current, timestamp);
      }
      return false;
    }
    try {
      await this.dependencies.queue.send({ dispatchBatchId: batchId });
    } catch {
      const current = await this.batches.findById(batchId);
      if (
        current?.state === "dispatching" &&
        (current.dispatchAttemptCount ?? 0) >=
          (current.dispatchMaxAttempts ?? 3)
      ) {
        await this.terminalizeDispatchBatch(current, timestamp);
      }
      return false;
    }
    const transitioned = await this.batches.transition({
      id: batchId,
      from: "dispatching",
      to: "queued",
      now: timestamp,
      expectedDispatchLeaseUntil: expectedLeaseUntil,
    });
    if (transitioned) {
      await this.workItems.queueBatchItems({
        dispatchBatchId: batchId,
        now: timestamp,
      });
    }
    return true;
  }

  private async terminalizeDispatchBatch(
    batch: DispatchBatchRecord,
    timestamp: string,
  ): Promise<boolean> {
    if (batch.state !== "dispatching" && batch.state !== "queued") {
      return batch.state === "terminal";
    }
    const transitioned =
      batch.state === "dispatching"
        ? batch.dispatchLeaseUntil
          ? await this.batches.transition({
              id: batch.id,
              from: "dispatching",
              to: "terminal",
              now: timestamp,
              errorCode: "dispatch_attempts_exhausted",
              errorMessage: "Queue dispatch attempt ceiling exhausted.",
              expectedDispatchLeaseUntil: batch.dispatchLeaseUntil,
            })
          : false
        : await this.batches.transition({
            id: batch.id,
            from: "queued",
            to: "terminal",
            now: timestamp,
            errorCode: "dispatch_attempts_exhausted",
            errorMessage: "Queue dispatch attempt ceiling exhausted.",
          });
    if (!transitioned) return false;
    if (batch.state === "dispatching" && batch.dispatchLeaseUntil) {
      await this.workItems.terminalizeBatchItems({
        dispatchBatchId: batch.id,
        now: timestamp,
        errorCode: "dispatch_attempts_exhausted",
        errorMessage: "Queue dispatch attempt ceiling exhausted.",
        expectedDispatchLeaseUntil: batch.dispatchLeaseUntil,
      });
    } else {
      await this.workItems.terminalizeBatchItems({
        dispatchBatchId: batch.id,
        now: timestamp,
        errorCode: "dispatch_attempts_exhausted",
        errorMessage: "Queue dispatch attempt ceiling exhausted.",
      });
    }
    await this.markSettledLinks(batch.id, timestamp);
    await this.deliverDlq(batch.id, timestamp);
    return true;
  }

  private async markSettledLinks(
    batchId: string,
    timestamp: string,
  ): Promise<void> {
    await this.workItems.reconcileJobLinksForBatch({
      dispatchBatchId: batchId,
      now: timestamp,
    });
  }

  private async deliverDlq(
    batchId: string,
    timestamp: string,
  ): Promise<boolean> {
    const leaseUntil = new Date(
      Date.parse(timestamp) + this.dlqLeaseMs,
    ).toISOString();
    const claimed = await this.batches.claimDlqDelivery({
      id: batchId,
      now: timestamp,
      leaseUntil,
    });
    if (!claimed) {
      const current = await this.batches.findById(batchId);
      return current?.dlqState === "delivered";
    }
    if (!this.dependencies.dlq) {
      return this.batches.markDlqDelivered({
        id: batchId,
        now: timestamp,
        expectedLeaseUntil: leaseUntil,
      });
    }
    try {
      await this.dependencies.dlq.send({ dispatchBatchId: batchId });
      return this.batches.markDlqDelivered({
        id: batchId,
        now: timestamp,
        expectedLeaseUntil: leaseUntil,
      });
    } catch (error) {
      await this.batches.releaseDlqDelivery({
        id: batchId,
        now: timestamp,
        expectedLeaseUntil: leaseUntil,
        error: String(error),
      });
      return false;
    }
  }

  private async countDispatchedWork(dayStart: string): Promise<number> {
    return this.batches.countReservedWork(dayStart.slice(0, 10));
  }

  private async recoverPendingDlq(timestamp: string): Promise<void> {
    const rows = await this.dependencies.db
      .prepare(
        `SELECT id FROM dispatch_batches
         WHERE state = 'terminal'
           AND (
             dlq_state = 'pending'
             OR (dlq_state = 'sending' AND dlq_lease_until IS NOT NULL
                 AND dlq_lease_until <= ?1)
           )`,
      )
      .bind(timestamp)
      .all<{ id: string }>();
    await Promise.all(
      rows.results.map(async (row) => {
        await this.markSettledLinks(row.id, timestamp);
        await this.deliverDlq(row.id, timestamp);
      }),
    );
  }

  private async reconcileSettledLinks(timestamp: string): Promise<void> {
    const rows = await this.dependencies.db
      .prepare(
        `SELECT DISTINCT batch.id
         FROM dispatch_batches batch
         JOIN dispatch_batch_items item
           ON item.dispatch_batch_id = batch.id
         JOIN job_work_items link ON link.work_item_id = item.work_item_id
         WHERE batch.state IN ('complete', 'terminal')
           AND link.outcome = 'pending'`,
      )
      .all<{ id: string }>();
    await Promise.all(
      rows.results.map((row) => this.markSettledLinks(row.id, timestamp)),
    );
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
        const withinLimit =
          current.length === 0 ||
          calendarDays(
            current[0]?.effectiveDate ?? item.effectiveDate ?? "",
            item.effectiveDate ?? "",
          ) <= this.maxBatchCalendarDays;
        // Provider ranges are calendar ranges, so trading dates separated by
        // weekends/holidays remain compatible as long as the requested span
        // stays within the 90-calendar-day ceiling.
        if (current.length > 0 && !withinLimit) {
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
      const current = await this.batches.findById(row.id);
      if (
        current &&
        (current.dispatchAttemptCount ?? 0) >=
          (current.dispatchMaxAttempts ?? 3)
      ) {
        await this.terminalizeDispatchBatch(current, timestamp);
        continue;
      }
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
          expectedLeaseUntil: row.leaseUntil,
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
