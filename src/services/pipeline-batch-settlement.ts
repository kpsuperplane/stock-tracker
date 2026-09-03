import { DispatchBatchRepository } from "../db/dispatch-batches";
import { WorkItemRepository } from "../db/work-items";
import { PipelineJobSettlementService } from "./pipeline-job-settlement";

export interface PipelineBatchSettlementResult {
  settled: boolean;
  planningPipelineJobIds: string[];
}

/**
 * Completes the bookkeeping for one known dispatch batch. All queries are
 * scoped by the batch's primary key, so recovery cost is independent of the
 * total historical work retained in D1.
 */
export class PipelineBatchSettlementService {
  private readonly batches: DispatchBatchRepository;
  private readonly jobs: PipelineJobSettlementService;
  private readonly workItems: WorkItemRepository;

  constructor(db: D1Database) {
    this.batches = new DispatchBatchRepository(db);
    this.jobs = new PipelineJobSettlementService(db);
    this.workItems = new WorkItemRepository(db);
  }

  async settle(
    dispatchBatchId: string,
    now: string,
  ): Promise<PipelineBatchSettlementResult> {
    const batch = await this.batches.findById(dispatchBatchId);
    if (!batch || !["complete", "terminal"].includes(batch.state)) {
      return { settled: false, planningPipelineJobIds: [] };
    }
    if (batch.state === "terminal") {
      await this.workItems.terminalizeUnsettledBatchItems({
        dispatchBatchId,
        now,
        errorCode: batch.terminalErrorCode ?? "dispatch_terminal",
        errorMessage:
          batch.terminalErrorMessage ?? "Dispatch batch was terminalized.",
      });
    }
    await this.workItems.reconcileJobLinksForBatch({ dispatchBatchId, now });
    await this.jobs.settleForBatch(dispatchBatchId, now);
    const planningPipelineJobIds =
      await this.jobs.planningContinuationsForBatch(dispatchBatchId);
    const settled =
      batch.settledAt !== null && batch.settledAt !== undefined
        ? true
        : await this.batches.markSettled({ id: dispatchBatchId, now });
    return { settled, planningPipelineJobIds };
  }
}
