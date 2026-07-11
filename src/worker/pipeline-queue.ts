import {
  type DispatchBatchRecord,
  DispatchBatchRepository,
} from "../db/dispatch-batches";
import { type WorkItemRecord, WorkItemRepository } from "../db/work-items";
import type { PipelineDispatchMessage } from "../shared/contracts";

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
}

const retryable = (error: unknown): boolean =>
  error instanceof TypeError ||
  /http_(429|5\d\d)|\b429\b|\b5\d\d\b|timed?out|network|abort/i.test(
    String(error),
  );

const validMessage = (body: unknown): body is PipelineDispatchMessage => {
  if (typeof body !== "object" || body === null) return false;
  const keys = Object.keys(body);
  return (
    keys.length === 1 &&
    keys[0] === "dispatchBatchId" &&
    typeof (body as { dispatchBatchId?: unknown }).dispatchBatchId ===
      "string" &&
    (body as { dispatchBatchId: string }).dispatchBatchId.length > 0
  );
};

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
    if (!batch || batch.state === "complete" || batch.state === "terminal") {
      message.ack();
      return;
    }
    const timestamp = this.now().toISOString();
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
        });
      }
    }
    const current = await this.batches.findById(batch.id);
    if (
      !current ||
      current.state === "complete" ||
      current.state === "terminal"
    ) {
      message.ack();
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
      if (current.attemptCount >= current.maxAttempts) {
        await this.terminalizeUnclaimedBatch(current, timestamp, message);
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
      await this.batches.transition({
        id: current.id,
        from: "processing",
        to: "complete",
        now: timestamp,
        expectedProcessingLeaseUntil: leaseUntil,
      });
      message.ack();
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
    let hasTerminal = false;
    for (const item of input.work) {
      const outcome = outcomeById.get(item.id);
      if (!outcome || outcome.kind === "retry") {
        hasRetry = true;
        continue;
      }
      if (outcome.kind === "terminal") {
        hasTerminal = true;
        await this.workItems.transition({
          id: item.id,
          from: "processing",
          to: "terminal",
          now: input.timestamp,
          expectedProcessingLeaseUntil: input.leaseUntil,
          errorCode: outcome.errorCode ?? "pipeline_terminal",
          errorMessage:
            outcome.errorMessage ?? "Pipeline work was terminalized.",
        });
      } else {
        await this.workItems.transition({
          id: item.id,
          from: "processing",
          to: "complete",
          now: input.timestamp,
          expectedProcessingLeaseUntil: input.leaseUntil,
          resultRevision: outcome.resultRevision ?? null,
        });
      }
    }
    if (
      !hasRetry &&
      (await this.batches.listWork(input.batch.id)).some(
        (item) => item.state === "terminal",
      )
    ) {
      hasTerminal = true;
    }
    if (hasRetry) {
      await this.workItems.requeueBatchItems({
        dispatchBatchId: input.batch.id,
        now: input.timestamp,
      });
      await this.batches.requeueProcessing({
        id: input.batch.id,
        expectedLeaseUntil: input.leaseUntil,
        now: input.timestamp,
      });
      input.message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    if (hasTerminal) {
      await this.batches.transition({
        id: input.batch.id,
        from: "processing",
        to: "terminal",
        now: input.timestamp,
        expectedProcessingLeaseUntil: input.leaseUntil,
        errorCode: "pipeline_work_terminal",
        errorMessage: "One or more pipeline work items failed permanently.",
      });
      await this.workItems.markJobLinksForBatch({
        dispatchBatchId: input.batch.id,
        outcome: "failed",
        now: input.timestamp,
      });
      await this.sendDlq(input.message.body);
      input.message.ack();
      return;
    }
    await this.batches.transition({
      id: input.batch.id,
      from: "processing",
      to: "complete",
      now: input.timestamp,
      expectedProcessingLeaseUntil: input.leaseUntil,
    });
    await this.workItems.markJobLinksForBatch({
      dispatchBatchId: input.batch.id,
      outcome: "processed",
      now: input.timestamp,
    });
    input.message.ack();
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
      });
      await this.batches.requeueProcessing({
        id: input.batch.id,
        expectedLeaseUntil: input.leaseUntil,
        now: input.timestamp,
      });
      input.message.retry({ delaySeconds: this.retryDelaySeconds });
      return;
    }
    await this.workItems.terminalizeBatchItems({
      dispatchBatchId: input.batch.id,
      now: input.timestamp,
      expectedLeaseUntil: input.leaseUntil,
      errorCode: attemptsExhausted
        ? "pipeline_attempts_exhausted"
        : "pipeline_failed",
      errorMessage: String(input.error),
    });
    await this.batches.transition({
      id: input.batch.id,
      from: "processing",
      to: "terminal",
      now: input.timestamp,
      expectedProcessingLeaseUntil: input.leaseUntil,
      errorCode: attemptsExhausted
        ? "pipeline_attempts_exhausted"
        : "pipeline_failed",
      errorMessage: String(input.error),
    });
    await this.workItems.markJobLinksForBatch({
      dispatchBatchId: input.batch.id,
      outcome: "failed",
      now: input.timestamp,
    });
    await this.sendDlq(input.message.body);
    input.message.ack();
  }

  private async sendDlq(body: PipelineDispatchMessage): Promise<void> {
    if (!this.dependencies.dlq) return;
    await this.dependencies.dlq.send(body);
  }

  private async terminalizeUnclaimedBatch(
    batch: DispatchBatchRecord,
    timestamp: string,
    message: Message<PipelineDispatchMessage>,
  ): Promise<void> {
    await this.workItems.terminalizeBatchItems({
      dispatchBatchId: batch.id,
      now: timestamp,
      errorCode: "pipeline_attempts_exhausted",
      errorMessage: "Dispatch attempt ceiling exhausted.",
    });
    const current = await this.batches.findById(batch.id);
    if (
      current &&
      current.state !== "terminal" &&
      current.state !== "complete"
    ) {
      if (current.state === "dispatching") {
        if (!current.dispatchLeaseUntil) return;
        await this.batches.transition({
          id: batch.id,
          from: "dispatching",
          to: "terminal",
          now: timestamp,
          errorCode: "pipeline_attempts_exhausted",
          errorMessage: "Dispatch attempt ceiling exhausted.",
          expectedDispatchLeaseUntil: current.dispatchLeaseUntil,
        });
      } else if (current.state === "processing") {
        if (!current.processingLeaseUntil) return;
        await this.batches.transition({
          id: batch.id,
          from: "processing",
          to: "terminal",
          now: timestamp,
          errorCode: "pipeline_attempts_exhausted",
          errorMessage: "Dispatch attempt ceiling exhausted.",
          expectedProcessingLeaseUntil: current.processingLeaseUntil,
        });
      } else {
        await this.batches.transition({
          id: batch.id,
          from: "queued",
          to: "terminal",
          now: timestamp,
          errorCode: "pipeline_attempts_exhausted",
          errorMessage: "Dispatch attempt ceiling exhausted.",
        });
      }
    }
    await this.workItems.markJobLinksForBatch({
      dispatchBatchId: batch.id,
      outcome: "failed",
      now: timestamp,
    });
    await this.sendDlq(message.body);
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
