import {
  type DispatchBatchRecord,
  DispatchBatchRepository,
} from "../db/dispatch-batches";
import { type WorkItemRecord, WorkItemRepository } from "../db/work-items";
import { isWithinDelayedBarHorizon } from "../services/scheduled-reconciliation";
import {
  isPipelineDispatchMessage,
  type PipelineDispatchMessage,
} from "../shared/contracts";

const DEFAULT_PROCESSING_LEASE_MS = 10 * 60_000;
const DEFAULT_RETRY_DELAY_SECONDS = 30;

export type PipelineWorkOutcomeKind = "complete" | "retry" | "terminal";

export interface PipelineWorkOutcome {
  workItemId: string;
  kind: PipelineWorkOutcomeKind;
  resultRevision?: string | null;
  errorCode?: string;
  errorMessage?: string;
}

const delayedBarError = (code: string | undefined): boolean =>
  code !== undefined &&
  /(?:delayed[_-]?bar|bar[_-]?(?:not[_-]?final|pending)|market[_-]?bar[_-]?pending)/i.test(
    code,
  );

export interface PipelineWorkProcessor {
  process?(input: {
    batch: DispatchBatchRecord;
    work: readonly WorkItemRecord[];
  }): Promise<readonly PipelineWorkOutcome[] | undefined>;
  processMarketFact?(input: {
    batch: DispatchBatchRecord;
    work: readonly WorkItemRecord[];
  }): Promise<readonly PipelineWorkOutcome[] | undefined>;
  processAnalysis?(input: {
    batch: DispatchBatchRecord;
    work: readonly WorkItemRecord[];
  }): Promise<readonly PipelineWorkOutcome[] | undefined>;
}

export interface PipelineQueueConsumerDependencies {
  db: D1Database;
  processor?: PipelineWorkProcessor;
  dlq?: Queue<PipelineDispatchMessage>;
  now?: () => Date;
  processingLeaseMs?: number;
  retryDelaySeconds?: number;
  dlqLeaseMs?: number;
}

const retryable = (error: unknown): boolean =>
  error instanceof TypeError ||
  /http_(429|5\d\d)|\b429\b|\b5\d\d\b|timed?out|network|abort/i.test(
    String(error),
  );

const validMessage = isPipelineDispatchMessage;

const missingOutcomes = (
  work: readonly WorkItemRecord[],
  outcomes: readonly PipelineWorkOutcome[],
): PipelineWorkOutcome[] => {
  const seen = new Set(outcomes.map((outcome) => outcome.workItemId));
  return work
    .filter((item) => !seen.has(item.id))
    .map((item) => ({
      workItemId: item.id,
      kind: "retry" as const,
      errorCode: "provider_partial_range",
      errorMessage: `No result was returned for ${item.effectiveDate ?? item.id}.`,
    }));
};

export class PipelineQueueConsumer {
  private readonly batches: DispatchBatchRepository;
  private readonly workItems: WorkItemRepository;
  private readonly now: () => Date;
  private readonly processingLeaseMs: number;
  private readonly retryDelaySeconds: number;
  private readonly dlqLeaseMs: number;

  constructor(
    private readonly dependencies: PipelineQueueConsumerDependencies,
  ) {
    this.batches = new DispatchBatchRepository(dependencies.db);
    this.workItems = new WorkItemRepository(dependencies.db);
    this.now = dependencies.now ?? (() => new Date());
    this.processingLeaseMs = Math.max(
      1_000,
      Math.floor(dependencies.processingLeaseMs ?? DEFAULT_PROCESSING_LEASE_MS),
    );
    this.retryDelaySeconds = Math.max(
      1,
      Math.floor(dependencies.retryDelaySeconds ?? DEFAULT_RETRY_DELAY_SECONDS),
    );
    this.dlqLeaseMs = Math.max(
      1_000,
      Math.floor(dependencies.dlqLeaseMs ?? DEFAULT_PROCESSING_LEASE_MS),
    );
  }

  async handle(batch: MessageBatch<PipelineDispatchMessage>): Promise<void> {
    await Promise.all(
      batch.messages.map((message) => this.handleMessage(message)),
    );
  }

  async process(batch: MessageBatch<PipelineDispatchMessage>): Promise<void> {
    return this.handle(batch);
  }

  async handleQueue(
    batch: MessageBatch<PipelineDispatchMessage>,
  ): Promise<void> {
    return this.handle(batch);
  }

  private async handleMessage(
    message: Message<PipelineDispatchMessage>,
  ): Promise<void> {
    if (!validMessage(message.body)) {
      message.ack();
      return;
    }
    const batch = await this.batches.findById(message.body.dispatchBatchId);
    if (!batch) {
      message.ack();
      return;
    }
    const timestamp = this.now().toISOString();
    if (batch.state === "complete") {
      await this.reconcileSettledLinks(batch.id, timestamp);
      message.ack();
      return;
    }
    if (batch.state === "terminal") {
      await this.ackAfterDlq(batch.id, timestamp, message);
      return;
    }
    if (
      batch.state === "processing" &&
      batch.processingLeaseUntil !== null &&
      batch.processingLeaseUntil <= timestamp
    ) {
      const recovered = await this.batches.reclaimExpiredProcessing({
        id: batch.id,
        expectedLeaseUntil: batch.processingLeaseUntil,
        now: timestamp,
      });
      if (recovered) {
        await this.workItems.requeueBatchItems({
          dispatchBatchId: batch.id,
          now: timestamp,
          expectedLeaseUntil: batch.processingLeaseUntil,
        });
      }
    }
    const current = await this.batches.findById(batch.id);
    if (!current) {
      message.ack();
      return;
    }
    if (current.state === "complete") {
      await this.reconcileSettledLinks(current.id, timestamp);
      message.ack();
      return;
    }
    if (current.state === "terminal") {
      await this.ackAfterDlq(current.id, timestamp, message);
      return;
    }
    const leaseUntil = new Date(
      Date.parse(timestamp) + this.processingLeaseMs,
    ).toISOString();
    const claimed = await this.batches.claimForProcessing({
      id: current.id,
      now: timestamp,
      leaseUntil,
    });
    if (!claimed) {
      const latest = await this.batches.findById(current.id);
      if (!latest) {
        message.ack();
        return;
      }
      if (latest.state === "complete") {
        await this.reconcileSettledLinks(latest.id, timestamp);
        message.ack();
        return;
      }
      if (latest.state === "terminal") {
        await this.ackAfterDlq(latest.id, timestamp, message);
        return;
      }
      if (
        latest.state === "processing" &&
        latest.processingLeaseUntil !== null &&
        latest.processingLeaseUntil > timestamp
      ) {
        message.retry({ delaySeconds: this.retryDelaySeconds });
        return;
      }
      if (latest.attemptCount >= latest.maxAttempts) {
        await this.terminalizeUnclaimedBatch(latest, timestamp, message);
        return;
      }
      message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    const claimedBatch: DispatchBatchRecord = {
      ...current,
      state: "processing",
      processingLeaseUntil: leaseUntil,
      dispatchLeaseUntil: null,
      attemptCount: current.attemptCount + 1,
      updatedAt: timestamp,
    };
    await this.workItems.claimForBatchProcessing({
      dispatchBatchId: current.id,
      now: timestamp,
      leaseUntil,
    });
    const work = await this.batches.listWork(current.id);
    const activeWork = work.filter((item) => item.state === "processing");
    if (activeWork.length === 0) {
      await this.finalizeSettledBatch({
        batch: claimedBatch,
        leaseUntil,
        timestamp,
        message,
      });
      return;
    }

    let outcomes: readonly PipelineWorkOutcome[];
    try {
      outcomes = await this.execute(claimedBatch, activeWork);
    } catch (error) {
      await this.handleFailure({
        batch: claimedBatch,
        leaseUntil,
        timestamp,
        error,
        message,
      });
      return;
    }
    const normalized = [...outcomes, ...missingOutcomes(activeWork, outcomes)];
    await this.applyOutcomes({
      batch: claimedBatch,
      work: activeWork,
      outcomes: normalized,
      leaseUntil,
      timestamp,
      message,
    });
  }

  private async execute(
    batch: DispatchBatchRecord,
    work: readonly WorkItemRecord[],
  ): Promise<readonly PipelineWorkOutcome[]> {
    const processor = this.dependencies.processor;
    if (!processor) {
      return work.map((item) => ({ workItemId: item.id, kind: "complete" }));
    }
    if (processor.process) {
      return (await processor.process({ batch, work })) ?? [];
    }
    const groups = new Map<string, WorkItemRecord[]>();
    for (const item of work) {
      const list = groups.get(item.workType) ?? [];
      list.push(item);
      groups.set(item.workType, list);
    }
    const outcomes: PipelineWorkOutcome[] = [];
    for (const [workType, items] of groups) {
      const method =
        workType === "market_fact"
          ? processor.processMarketFact
          : processor.processAnalysis;
      if (!method) {
        outcomes.push(
          ...items.map((item) => ({
            workItemId: item.id,
            kind: "complete" as const,
          })),
        );
        continue;
      }
      const result = await method({ batch, work: items });
      if (result) outcomes.push(...result);
    }
    return outcomes;
  }

  private async applyOutcomes(input: {
    batch: DispatchBatchRecord;
    work: readonly WorkItemRecord[];
    outcomes: readonly PipelineWorkOutcome[];
    leaseUntil: string;
    timestamp: string;
    message: Message<PipelineDispatchMessage>;
  }): Promise<void> {
    const outcomeById = new Map(
      input.outcomes.map((outcome) => [outcome.workItemId, outcome]),
    );
    let hasRetry = false;
    let hasDelayedRetry = false;
    let hasTerminal = false;
    let lostLease = false;
    for (const item of input.work) {
      const outcome = outcomeById.get(item.id);
      if (!outcome || outcome.kind === "retry") {
        const delayed =
          outcome !== undefined && delayedBarError(outcome.errorCode);
        if (
          delayed &&
          !isWithinDelayedBarHorizon(
            // The batch timestamp is the first dispatch attempt and is shared
            // by every item in a provider range.  Using the item creation time
            // would let a planner retry indefinitely by recreating children.
            new Date(input.batch.createdAt),
            new Date(input.timestamp),
          )
        ) {
          const changed = await this.workItems.transition({
            id: item.id,
            from: "processing",
            to: "terminal",
            now: input.timestamp,
            expectedProcessingLeaseUntil: input.leaseUntil,
            errorCode: "delayed_bar_horizon_exhausted",
            errorMessage:
              "The market bar was not finalized within the six-hour retry horizon.",
          });
          if (!changed) lostLease = true;
          else hasTerminal = true;
        } else {
          hasRetry = true;
          hasDelayedRetry = hasDelayedRetry || delayed;
        }
        continue;
      }
      if (outcome.kind === "terminal") {
        const changed = await this.workItems.transition({
          id: item.id,
          from: "processing",
          to: "terminal",
          now: input.timestamp,
          expectedProcessingLeaseUntil: input.leaseUntil,
          errorCode: outcome.errorCode ?? "pipeline_terminal",
          errorMessage:
            outcome.errorMessage ?? "Pipeline work was terminalized.",
        });
        if (!changed) lostLease = true;
        else hasTerminal = true;
      } else {
        const changed = await this.workItems.transition({
          id: item.id,
          from: "processing",
          to: "complete",
          now: input.timestamp,
          expectedProcessingLeaseUntil: input.leaseUntil,
          resultRevision: outcome.resultRevision ?? null,
        });
        if (!changed) lostLease = true;
      }
    }
    if (lostLease) {
      input.message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    if (hasRetry) {
      const requeued = await this.workItems.requeueBatchItems({
        dispatchBatchId: input.batch.id,
        now: input.timestamp,
        expectedLeaseUntil: input.leaseUntil,
      });
      const batchRequeued = await this.batches.requeueProcessing({
        id: input.batch.id,
        expectedLeaseUntil: input.leaseUntil,
        now: input.timestamp,
        resetAttemptCount: hasDelayedRetry,
      });
      if (!requeued && !batchRequeued) {
        input.message.retry({ delaySeconds: this.retryDelaySeconds });
        return;
      }
      input.message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    const settled = await this.batches.listWork(input.batch.id);
    hasTerminal =
      hasTerminal || settled.some((item) => item.state === "terminal");
    const transitioned = await this.batches.transition({
      id: input.batch.id,
      from: "processing",
      to: hasTerminal ? "terminal" : "complete",
      now: input.timestamp,
      expectedProcessingLeaseUntil: input.leaseUntil,
      ...(hasTerminal
        ? {
            errorCode: "pipeline_work_terminal",
            errorMessage: "One or more pipeline work items failed permanently.",
          }
        : {}),
    });
    if (!transitioned) {
      input.message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    await this.reconcileSettledLinks(input.batch.id, input.timestamp);
    if (
      hasTerminal &&
      !(await this.deliverDlq(input.batch.id, input.timestamp))
    ) {
      input.message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    input.message.ack();
  }

  private async finalizeSettledBatch(input: {
    batch: DispatchBatchRecord;
    leaseUntil: string;
    timestamp: string;
    message: Message<PipelineDispatchMessage>;
  }): Promise<void> {
    const work = await this.batches.listWork(input.batch.id);
    if (
      work.some(
        (item) =>
          item.state === "processing" ||
          item.state === "queued" ||
          item.state === "dispatching",
      )
    ) {
      input.message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    const hasTerminal = work.some((item) => item.state === "terminal");
    const transitioned = await this.batches.transition({
      id: input.batch.id,
      from: "processing",
      to: hasTerminal ? "terminal" : "complete",
      now: input.timestamp,
      expectedProcessingLeaseUntil: input.leaseUntil,
      ...(hasTerminal
        ? {
            errorCode: "pipeline_work_terminal",
            errorMessage: "One or more pipeline work items failed permanently.",
          }
        : {}),
    });
    if (!transitioned) {
      input.message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    await this.reconcileSettledLinks(input.batch.id, input.timestamp);
    if (
      hasTerminal &&
      !(await this.deliverDlq(input.batch.id, input.timestamp))
    ) {
      input.message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    input.message.ack();
  }

  private async reconcileSettledLinks(
    batchId: string,
    timestamp: string,
  ): Promise<void> {
    await this.workItems.reconcileJobLinksForBatch({
      dispatchBatchId: batchId,
      now: timestamp,
    });
  }

  private async handleFailure(input: {
    batch: DispatchBatchRecord;
    leaseUntil: string;
    timestamp: string;
    error: unknown;
    message: Message<PipelineDispatchMessage>;
  }): Promise<void> {
    const attemptsExhausted =
      input.batch.attemptCount >= input.batch.maxAttempts;
    if (retryable(input.error) && !attemptsExhausted) {
      await this.workItems.requeueBatchItems({
        dispatchBatchId: input.batch.id,
        now: input.timestamp,
        expectedLeaseUntil: input.leaseUntil,
      });
      await this.batches.requeueProcessing({
        id: input.batch.id,
        expectedLeaseUntil: input.leaseUntil,
        now: input.timestamp,
      });
      input.message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    const transitioned = await this.batches.terminalizeBatchAndItems({
      id: input.batch.id,
      from: "processing",
      now: input.timestamp,
      errorCode: attemptsExhausted
        ? "pipeline_attempts_exhausted"
        : "pipeline_failed",
      errorMessage: String(input.error),
      expectedProcessingLeaseUntil: input.leaseUntil,
    });
    if (!transitioned) {
      input.message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    await this.reconcileSettledLinks(input.batch.id, input.timestamp);
    if (!(await this.deliverDlq(input.batch.id, input.timestamp))) {
      input.message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    input.message.ack();
  }

  private async ackAfterDlq(
    batchId: string,
    timestamp: string,
    message: Message<PipelineDispatchMessage>,
  ): Promise<void> {
    const batch = await this.batches.findById(batchId);
    if (batch?.state === "terminal") {
      await this.workItems.terminalizeUnsettledBatchItems({
        dispatchBatchId: batchId,
        now: timestamp,
        errorCode: batch.terminalErrorCode ?? "dispatch_terminal",
        errorMessage:
          batch.terminalErrorMessage ?? "Dispatch batch was terminalized.",
      });
    }
    await this.reconcileSettledLinks(batchId, timestamp);
    if (await this.deliverDlq(batchId, timestamp)) message.ack();
    else message.retry({ delaySeconds: this.retryDelaySeconds });
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

  private async terminalizeUnclaimedBatch(
    batch: DispatchBatchRecord,
    timestamp: string,
    message: Message<PipelineDispatchMessage>,
  ): Promise<void> {
    const current = await this.batches.findById(batch.id);
    if (!current) {
      message.ack();
      return;
    }
    if (current.state === "complete") {
      await this.reconcileSettledLinks(current.id, timestamp);
      message.ack();
      return;
    }
    if (current.state === "terminal") {
      await this.ackAfterDlq(current.id, timestamp, message);
      return;
    }
    let transitioned = false;
    if (current.state === "dispatching") {
      if (!current.dispatchLeaseUntil) {
        message.retry({ delaySeconds: this.retryDelaySeconds });
        return;
      }
      transitioned = await this.batches.terminalizeBatchAndItems({
        id: current.id,
        from: "dispatching",
        now: timestamp,
        errorCode: "pipeline_attempts_exhausted",
        errorMessage: "Dispatch attempt ceiling exhausted.",
        expectedDispatchLeaseUntil: current.dispatchLeaseUntil,
      });
    } else if (current.state === "processing") {
      if (!current.processingLeaseUntil) {
        message.retry({ delaySeconds: this.retryDelaySeconds });
        return;
      }
      transitioned = await this.batches.terminalizeBatchAndItems({
        id: current.id,
        from: "processing",
        now: timestamp,
        errorCode: "pipeline_attempts_exhausted",
        errorMessage: "Dispatch attempt ceiling exhausted.",
        expectedProcessingLeaseUntil: current.processingLeaseUntil,
      });
    } else {
      transitioned = await this.batches.terminalizeBatchAndItems({
        id: current.id,
        from: "queued",
        now: timestamp,
        errorCode: "pipeline_attempts_exhausted",
        errorMessage: "Dispatch attempt ceiling exhausted.",
      });
    }
    if (!transitioned) {
      message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    await this.reconcileSettledLinks(current.id, timestamp);
    if (!(await this.deliverDlq(current.id, timestamp))) {
      message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    message.ack();
  }
}

export const handlePipelineQueue = async (
  batch: MessageBatch<PipelineDispatchMessage>,
  dependencies: PipelineQueueConsumerDependencies,
): Promise<void> => {
  await new PipelineQueueConsumer(dependencies).handle(batch);
};

export const handleQueue = handlePipelineQueue;

export {
  PipelineQueueConsumer as PipelineConsumer,
  PipelineQueueConsumer as PipelineQueueHandler,
};
