import { PipelineJobRepository } from "../db/pipeline-jobs";
import { BackfillPipelineAdapter } from "../services/backfill-pipeline";
import { ScheduledReconciliationService } from "../services/scheduled-reconciliation";
import { WorkDispatcherService } from "../services/work-dispatcher";
import type { PlanningContinuationMessage } from "../shared/contracts";
import type { Env } from "./env";

export const shouldEnqueuePlanningContinuation = (input: {
  active: boolean;
  paused: boolean;
  dispatchedBatches: number;
}): boolean => !input.paused && (input.active || input.dispatchedBatches >= 8);

export const continuePlanningFromQueue = async (
  env: Env,
  message: PlanningContinuationMessage,
  now = new Date(),
): Promise<void> => {
  const job = await new PipelineJobRepository(env.DB).findById(
    message.planningPipelineJobId,
  );
  const result =
    job?.triggerType === "backfill"
      ? await new BackfillPipelineAdapter({
          db: env.DB,
          listActiveSymbols: async () => [],
        }).continuePlanning(message.planningPipelineJobId, now.toISOString(), 5)
      : await new ScheduledReconciliationService({
          db: env.DB,
          now: () => now,
          plannerPageSize: 1_000,
        }).continueJob(message.planningPipelineJobId, now, 5);
  const dispatch = await new WorkDispatcherService({
    db: env.DB,
    queue: env.NORMALIZED_WORK_QUEUE,
    dlq: env.NORMALIZED_WORK_DLQ,
    now: () => now,
  }).dispatch();
  // A paused planner is waiting for already-materialized work to settle. A
  // timer-driven self-message cannot make that happen and, on the Queues free
  // tier, the write/read/delete loop can consume the entire daily allowance.
  // The recurring scheduler is the durable recovery trigger once capacity is
  // available or the preceding phase has settled.
  if (
    shouldEnqueuePlanningContinuation({
      active: result.active,
      paused: result.paused,
      dispatchedBatches: dispatch.dispatchedBatches,
    })
  ) {
    await env.NORMALIZED_WORK_QUEUE.send(message);
  }
};
