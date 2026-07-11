export interface PlanningWorkRecord {
  id: string;
  pipelineJobId: string;
  workType: string;
  deterministicKey: string;
  priority: number;
  maxAttempts: number;
  createdAt: string;
  updatedAt: string;
}

export type WorkItemState =
  | "pending"
  | "dispatching"
  | "queued"
  | "processing"
  | "complete"
  | "terminal";

export interface GlobalFactWorkRecord {
  id: string;
  workType: string;
  instrumentId: string;
  effectiveDate: string;
  dependencyRevision: string;
  forcedRefreshGeneration: number | null;
  deterministicKey: string;
  priority: number;
  maxAttempts: number;
  availableAt: string | null;
  retentionUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemRecord {
  id: string;
  scope: "job_planning" | "global_fact";
  pipelineJobId: string | null;
  workType: string;
  instrumentId: string | null;
  effectiveDate: string | null;
  dependencyRevision: string | null;
  forcedRefreshGeneration: number | null;
  deterministicKey: string;
  state: WorkItemState;
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

interface WorkItemRow {
  id: string;
  scope: WorkItemRecord["scope"];
  pipeline_job_id: string | null;
  work_type: string;
  instrument_id: string | null;
  effective_date: string | null;
  dependency_revision: string | null;
  forced_refresh_generation: number | null;
  deterministic_key: string;
  state: WorkItemState;
  priority: number;
  attempt_count: number;
  max_attempts: number;
  dispatch_lease_until: string | null;
  processing_lease_until: string | null;
  result_revision: string | null;
  terminal_error_code: string | null;
  terminal_error_message: string | null;
  available_at: string | null;
  retention_until: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

const mapWorkItem = (row: WorkItemRow): WorkItemRecord => ({
  id: row.id,
  scope: row.scope,
  pipelineJobId: row.pipeline_job_id,
  workType: row.work_type,
  instrumentId: row.instrument_id,
  effectiveDate: row.effective_date,
  dependencyRevision: row.dependency_revision,
  forcedRefreshGeneration: row.forced_refresh_generation,
  deterministicKey: row.deterministic_key,
  state: row.state,
  priority: row.priority,
  attemptCount: row.attempt_count,
  maxAttempts: row.max_attempts,
  dispatchLeaseUntil: row.dispatch_lease_until,
  processingLeaseUntil: row.processing_lease_until,
  resultRevision: row.result_revision,
  terminalErrorCode: row.terminal_error_code,
  terminalErrorMessage: row.terminal_error_message,
  availableAt: row.available_at,
  retentionUntil: row.retention_until,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

const allowedTransitions: Readonly<
  Record<WorkItemState, readonly WorkItemState[]>
> = {
  pending: ["dispatching", "complete", "terminal"],
  dispatching: ["pending", "queued", "terminal"],
  queued: ["pending", "processing", "terminal"],
  processing: ["pending", "complete", "terminal"],
  complete: [],
  terminal: [],
};

export class WorkItemRepository {
  constructor(private readonly db: D1Database) {}

  createPlanningStatement(work: PlanningWorkRecord): D1PreparedStatement {
    if (!work.deterministicKey.startsWith(`job:${work.pipelineJobId}:`)) {
      throw new Error("invalid_planning_work_key");
    }
    return this.db
      .prepare(
        `INSERT INTO work_items
         (id, scope, pipeline_job_id, work_type, deterministic_key, state,
          priority, attempt_count, max_attempts, created_at, updated_at)
         VALUES (?1, 'job_planning', ?2, ?3, ?4, 'pending', ?5, 0, ?6, ?7, ?8)`,
      )
      .bind(
        work.id,
        work.pipelineJobId,
        work.workType,
        work.deterministicKey,
        work.priority,
        work.maxAttempts,
        work.createdAt,
        work.updatedAt,
      );
  }

  static planningKey(pipelineJobId: string, workType: string): string {
    return `job:${pipelineJobId}:${workType}`;
  }

  static globalFactKey(input: {
    workType: string;
    instrumentId: string;
    effectiveDate: string;
    dependencyRevision: string;
    forcedRefreshGeneration?: number | null;
  }): string {
    return JSON.stringify([
      "fact",
      input.workType,
      input.instrumentId,
      input.effectiveDate,
      input.dependencyRevision,
      input.forcedRefreshGeneration ?? 0,
    ]);
  }

  createGlobalStatement(work: GlobalFactWorkRecord): D1PreparedStatement {
    if (work.deterministicKey !== WorkItemRepository.globalFactKey(work)) {
      throw new Error("invalid_global_fact_key");
    }
    return this.db
      .prepare(
        `INSERT INTO work_items
         (id, scope, pipeline_job_id, work_type, instrument_id, effective_date,
          dependency_revision, forced_refresh_generation, deterministic_key,
          state, priority, attempt_count, max_attempts, available_at,
          retention_until, created_at, updated_at)
         VALUES (?1, 'global_fact', NULL, ?2, ?3, ?4, ?5, ?6, ?7,
                 'pending', ?8, 0, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(deterministic_key) DO NOTHING`,
      )
      .bind(
        work.id,
        work.workType,
        work.instrumentId,
        work.effectiveDate,
        work.dependencyRevision,
        work.forcedRefreshGeneration,
        work.deterministicKey,
        work.priority,
        work.maxAttempts,
        work.availableAt,
        work.retentionUntil,
        work.createdAt,
        work.updatedAt,
      );
  }

  async ensureGlobal(work: GlobalFactWorkRecord): Promise<WorkItemRecord> {
    await this.createGlobalStatement(work).run();
    const existing = await this.findByDeterministicKey(work.deterministicKey);
    if (!existing) throw new Error("global_work_missing_after_insert");
    return existing;
  }

  async findByDeterministicKey(
    deterministicKey: string,
  ): Promise<WorkItemRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM work_items WHERE deterministic_key = ?1")
      .bind(deterministicKey)
      .first<WorkItemRow>();
    return row ? mapWorkItem(row) : null;
  }

  async findById(id: string): Promise<WorkItemRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM work_items WHERE id = ?1")
      .bind(id)
      .first<WorkItemRow>();
    return row ? mapWorkItem(row) : null;
  }

  async findPlanningForJob(
    pipelineJobId: string,
  ): Promise<WorkItemRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM work_items
         WHERE scope = 'job_planning' AND pipeline_job_id = ?1
         ORDER BY id LIMIT 1`,
      )
      .bind(pipelineJobId)
      .first<WorkItemRow>();
    return row ? mapWorkItem(row) : null;
  }

  async isLinkedToJob(input: {
    pipelineJobId: string;
    workItemId: string;
  }): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS linked FROM job_work_items
         WHERE pipeline_job_id = ?1 AND work_item_id = ?2 LIMIT 1`,
      )
      .bind(input.pipelineJobId, input.workItemId)
      .first<{ linked: number }>();
    return row?.linked === 1;
  }

  async claimPlanning(input: {
    id: string;
    pipelineJobId: string;
    now: string;
    leaseUntil: string;
    expectedLeaseUntil?: string;
  }): Promise<boolean> {
    const result = input.expectedLeaseUntil
      ? await this.db
          .prepare(
            `UPDATE work_items
             SET processing_lease_until = ?1, updated_at = ?2
             WHERE id = ?3 AND pipeline_job_id = ?4
               AND scope = 'job_planning' AND state = 'processing'
               AND processing_lease_until IS ?5
               AND processing_lease_until > ?2`,
          )
          .bind(
            input.leaseUntil,
            input.now,
            input.id,
            input.pipelineJobId,
            input.expectedLeaseUntil,
          )
          .run()
      : await this.db
          .prepare(
            `UPDATE work_items
             SET state = 'processing', processing_lease_until = ?1,
                 attempt_count = attempt_count + 1, updated_at = ?2
             WHERE id = ?3 AND pipeline_job_id = ?4
               AND scope = 'job_planning' AND state = 'pending'
               AND attempt_count < max_attempts
               AND (available_at IS NULL OR available_at <= ?2)`,
          )
          .bind(input.leaseUntil, input.now, input.id, input.pipelineJobId)
          .run();
    return result.meta.changes === 1;
  }

  async reclaimExpiredPlanning(input: {
    id: string;
    pipelineJobId: string;
    now: string;
    leaseUntil: string;
    expectedLeaseUntil: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE work_items
         SET state = 'processing', processing_lease_until = ?1,
             attempt_count = attempt_count + 1, updated_at = ?2
         WHERE id = ?3 AND pipeline_job_id = ?4
           AND scope = 'job_planning' AND state = 'processing'
           AND processing_lease_until IS ?5
           AND processing_lease_until <= ?2
           AND attempt_count < max_attempts`,
      )
      .bind(
        input.leaseUntil,
        input.now,
        input.id,
        input.pipelineJobId,
        input.expectedLeaseUntil,
      )
      .run();
    return result.meta.changes === 1;
  }

  async completePlanning(input: {
    id: string;
    pipelineJobId: string;
    now: string;
    expectedLeaseUntil: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE work_items
         SET state = 'complete', processing_lease_until = NULL,
             completed_at = ?1, updated_at = ?1
         WHERE id = ?2 AND pipeline_job_id = ?3
           AND scope = 'job_planning' AND state = 'processing'
           AND processing_lease_until IS ?4`,
      )
      .bind(input.now, input.id, input.pipelineJobId, input.expectedLeaseUntil)
      .run();
    return result.meta.changes === 1;
  }

  promotePriorityStatement(input: {
    id: string;
    priority: number;
    updatedAt: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `UPDATE work_items
         SET priority = CASE WHEN priority < ?1 THEN ?1 ELSE priority END,
             updated_at = ?2
         WHERE id = ?3 AND scope = 'global_fact'`,
      )
      .bind(input.priority, input.updatedAt, input.id);
  }

  linkToJobStatement(input: {
    pipelineJobId: string;
    workItemId: string;
    relationship: "required" | "optional";
    createdAt: string;
  }): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO job_work_items
         (pipeline_job_id, work_item_id, relationship, outcome, created_at)
         VALUES (?1, ?2, ?3, 'pending', ?4)`,
      )
      .bind(
        input.pipelineJobId,
        input.workItemId,
        input.relationship,
        input.createdAt,
      );
  }

  async attachToJob(input: {
    pipelineJobId: string;
    workItemId: string;
    relationship: "required" | "optional";
    outcome?: "pending" | "reused" | "skipped" | "processed" | "failed";
    now: string;
  }): Promise<boolean> {
    const work = await this.findById(input.workItemId);
    if (!work) throw new Error("work_item_not_found");
    if (
      work.scope === "job_planning" &&
      work.pipelineJobId !== input.pipelineJobId
    ) {
      throw new Error("job_planning_owner_mismatch");
    }
    const result = await this.db
      .prepare(
        `INSERT INTO job_work_items
         (pipeline_job_id, work_item_id, relationship, outcome, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?5)
         ON CONFLICT(pipeline_job_id, work_item_id) DO NOTHING`,
      )
      .bind(
        input.pipelineJobId,
        input.workItemId,
        input.relationship,
        input.outcome ?? "pending",
        input.now,
      )
      .run();
    return result.meta.changes === 1;
  }

  async transition(input: {
    id: string;
    from: WorkItemState;
    to: WorkItemState;
    now: string;
    dispatchLeaseUntil?: string | null;
    processingLeaseUntil?: string | null;
    resultRevision?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    retentionUntil?: string | null;
    expectedDispatchLeaseUntil?: string;
    expectedProcessingLeaseUntil?: string;
  }): Promise<boolean> {
    if (!allowedTransitions[input.from].includes(input.to)) {
      throw new Error("invalid_work_item_transition");
    }
    if (input.to === "terminal" && !input.errorCode) {
      throw new Error("terminal_work_item_requires_error");
    }
    if (input.to !== "terminal" && (input.errorCode || input.errorMessage)) {
      throw new Error("nonterminal_work_item_has_error");
    }
    if (input.from === "dispatching" && !input.expectedDispatchLeaseUntil) {
      throw new Error("dispatch_transition_requires_lease");
    }
    if (input.from === "processing" && !input.expectedProcessingLeaseUntil) {
      throw new Error("processing_transition_requires_lease");
    }
    const completedAt =
      input.to === "complete" || input.to === "terminal" ? input.now : null;
    const leasePredicate =
      input.from === "dispatching"
        ? " AND dispatch_lease_until IS ?12"
        : input.from === "processing"
          ? " AND processing_lease_until IS ?12"
          : "";
    const statement = this.db.prepare(
      `UPDATE work_items
         SET state = ?1, dispatch_lease_until = ?2, processing_lease_until = ?3,
             result_revision = ?4, terminal_error_code = ?5,
             terminal_error_message = ?6, retention_until = ?7,
             completed_at = ?8, updated_at = ?9
         WHERE id = ?10 AND state = ?11${leasePredicate}`,
    );
    const bindings = [
      input.to,
      input.dispatchLeaseUntil ?? null,
      input.processingLeaseUntil ?? null,
      input.resultRevision ?? null,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      input.retentionUntil ?? null,
      completedAt,
      input.now,
      input.id,
      input.from,
    ];
    const result = await (input.from === "dispatching"
      ? statement.bind(...bindings, input.expectedDispatchLeaseUntil)
      : input.from === "processing"
        ? statement.bind(...bindings, input.expectedProcessingLeaseUntil)
        : statement.bind(...bindings)
    ).run();
    return result.meta.changes === 1;
  }

  async claimForDispatch(input: {
    id: string;
    now: string;
    leaseUntil: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE work_items
         SET state = 'dispatching', dispatch_lease_until = ?1,
             attempt_count = attempt_count + 1, updated_at = ?2
         WHERE id = ?3 AND scope = 'global_fact' AND state = 'pending'
           AND attempt_count < max_attempts
           AND (available_at IS NULL OR available_at <= ?2)`,
      )
      .bind(input.leaseUntil, input.now, input.id)
      .run();
    return result.meta.changes === 1;
  }

  async recoverExpiredDispatch(input: {
    id: string;
    expectedLeaseUntil: string;
    now: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE work_items
         SET state = 'pending', dispatch_lease_until = NULL, updated_at = ?1
         WHERE id = ?2 AND state = 'dispatching'
           AND dispatch_lease_until IS ?3 AND dispatch_lease_until <= ?1`,
      )
      .bind(input.now, input.id, input.expectedLeaseUntil)
      .run();
    return result.meta.changes === 1;
  }

  async recoverOrphanedDispatches(now: string): Promise<number> {
    const terminalize = this.db
      .prepare(
        `UPDATE work_items
         SET state = 'terminal', dispatch_lease_until = NULL,
             terminal_error_code = 'dispatch_attempts_exhausted',
             terminal_error_message = 'Orphaned dispatch attempt ceiling exhausted.',
             completed_at = ?1, updated_at = ?1
         WHERE scope = 'global_fact' AND state = 'dispatching'
           AND dispatch_lease_until IS NOT NULL
           AND dispatch_lease_until <= ?1
           AND attempt_count >= max_attempts
           AND NOT EXISTS (
             SELECT 1 FROM dispatch_batch_items item
             WHERE item.work_item_id = work_items.id
           )`,
      )
      .bind(now);
    const failLinks = this.db
      .prepare(
        `UPDATE job_work_items
         SET outcome = 'failed', updated_at = ?1
         WHERE outcome = 'pending'
           AND work_item_id IN (
             SELECT id FROM work_items
             WHERE state = 'terminal'
               AND terminal_error_code = 'dispatch_attempts_exhausted'
               AND completed_at = ?1
           )`,
      )
      .bind(now);
    const reclaim = this.db
      .prepare(
        `UPDATE work_items
         SET state = 'pending', dispatch_lease_until = NULL, updated_at = ?1
         WHERE scope = 'global_fact' AND state = 'dispatching'
           AND dispatch_lease_until IS NOT NULL
           AND dispatch_lease_until <= ?1
           AND attempt_count < max_attempts
           AND NOT EXISTS (
             SELECT 1 FROM dispatch_batch_items item
             WHERE item.work_item_id = work_items.id
           )`,
      )
      .bind(now);
    const results = await this.db.batch([terminalize, failLinks, reclaim]);
    return (results[0]?.meta.changes ?? 0) + (results[2]?.meta.changes ?? 0);
  }

  async releaseDispatchClaim(input: {
    id: string;
    expectedLeaseUntil: string;
    now: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE work_items
         SET state = 'pending', dispatch_lease_until = NULL, updated_at = ?1
         WHERE id = ?2 AND scope = 'global_fact' AND state = 'dispatching'
           AND dispatch_lease_until IS ?3`,
      )
      .bind(input.now, input.id, input.expectedLeaseUntil)
      .run();
    return result.meta.changes === 1;
  }

  async claimForBatchProcessing(input: {
    dispatchBatchId: string;
    now: string;
    leaseUntil: string;
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE work_items
         SET state = 'processing', processing_lease_until = ?1,
             dispatch_lease_until = NULL, updated_at = ?2
         WHERE scope = 'global_fact'
           AND state IN ('dispatching', 'queued')
           AND id IN (
             SELECT work_item_id FROM dispatch_batch_items
             WHERE dispatch_batch_id = ?3
           )`,
      )
      .bind(input.leaseUntil, input.now, input.dispatchBatchId)
      .run();
    return result.meta.changes;
  }

  async queueBatchItems(input: {
    dispatchBatchId: string;
    now: string;
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE work_items
         SET state = 'queued', dispatch_lease_until = NULL,
             updated_at = ?1
         WHERE scope = 'global_fact' AND state = 'dispatching'
           AND id IN (
             SELECT work_item_id FROM dispatch_batch_items
             WHERE dispatch_batch_id = ?2
           )`,
      )
      .bind(input.now, input.dispatchBatchId)
      .run();
    return result.meta.changes;
  }

  async requeueBatchItems(input: {
    dispatchBatchId: string;
    now: string;
    expectedLeaseUntil?: string;
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE work_items
         SET state = 'queued', processing_lease_until = NULL,
             updated_at = ?1
         WHERE scope = 'global_fact' AND state = 'processing'
           AND id IN (
             SELECT work_item_id FROM dispatch_batch_items
             WHERE dispatch_batch_id = ?2
           )
           AND (?3 IS NULL OR processing_lease_until IS ?3)`,
      )
      .bind(input.now, input.dispatchBatchId, input.expectedLeaseUntil ?? null)
      .run();
    return result.meta.changes;
  }

  async recoverExpiredProcessing(input: {
    now: string;
    expectedLeaseUntil?: string;
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE work_items
         SET state = 'queued', processing_lease_until = NULL,
             updated_at = ?1
         WHERE scope = 'global_fact' AND state = 'processing'
           AND processing_lease_until IS NOT NULL
           AND processing_lease_until <= ?1
           AND (?2 IS NULL OR processing_lease_until IS ?2)`,
      )
      .bind(input.now, input.expectedLeaseUntil ?? null)
      .run();
    return result.meta.changes;
  }

  async terminalizeBatchItems(input: {
    dispatchBatchId: string;
    now: string;
    errorCode: string;
    errorMessage: string;
    expectedLeaseUntil?: string;
    expectedDispatchLeaseUntil?: string;
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE work_items
         SET state = 'terminal', processing_lease_until = NULL,
             terminal_error_code = ?1, terminal_error_message = ?2,
             completed_at = ?3, updated_at = ?3
         WHERE scope = 'global_fact' AND state IN ('processing', 'queued', 'dispatching')
           AND id IN (
             SELECT work_item_id FROM dispatch_batch_items
             WHERE dispatch_batch_id = ?4
           )
           AND (
             (?5 IS NULL AND ?6 IS NULL)
             OR (?5 IS NOT NULL AND processing_lease_until IS ?5)
             OR (
               ?6 IS NOT NULL
               AND (dispatch_lease_until IS ?6 OR state = 'queued')
             )
           )`,
      )
      .bind(
        input.errorCode,
        input.errorMessage,
        input.now,
        input.dispatchBatchId,
        input.expectedLeaseUntil ?? null,
        input.expectedDispatchLeaseUntil ?? null,
      )
      .run();
    return result.meta.changes;
  }

  async terminalizeUnsettledBatchItems(input: {
    dispatchBatchId: string;
    now: string;
    errorCode: string;
    errorMessage: string;
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE work_items
         SET state = 'terminal', dispatch_lease_until = NULL,
             processing_lease_until = NULL, terminal_error_code = ?1,
             terminal_error_message = ?2, completed_at = ?3, updated_at = ?3
         WHERE scope = 'global_fact'
           AND state IN ('dispatching', 'queued', 'processing')
           AND id IN (
             SELECT work_item_id FROM dispatch_batch_items
             WHERE dispatch_batch_id = ?4
           )`,
      )
      .bind(
        input.errorCode,
        input.errorMessage,
        input.now,
        input.dispatchBatchId,
      )
      .run();
    return result.meta.changes;
  }

  async markJobLinksForBatch(input: {
    dispatchBatchId: string;
    outcome: "processed" | "failed";
    now: string;
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE job_work_items
         SET outcome = ?1, updated_at = ?2
         WHERE work_item_id IN (
           SELECT work_item_id FROM dispatch_batch_items
           WHERE dispatch_batch_id = ?3
         ) AND outcome = 'pending'`,
      )
      .bind(input.outcome, input.now, input.dispatchBatchId)
      .run();
    return result.meta.changes;
  }

  async markJobLinkForItem(input: {
    workItemId: string;
    outcome: "processed" | "failed";
    now: string;
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE job_work_items
         SET outcome = ?1, updated_at = ?2
         WHERE work_item_id = ?3 AND outcome = 'pending'`,
      )
      .bind(input.outcome, input.now, input.workItemId)
      .run();
    return result.meta.changes;
  }

  async reconcileJobLinksForBatch(input: {
    dispatchBatchId: string;
    now: string;
  }): Promise<number> {
    const result = await this.db
      .prepare(
        `UPDATE job_work_items
         SET outcome = CASE
             WHEN work.state = 'complete' THEN 'processed'
             WHEN work.state = 'terminal' THEN 'failed'
             ELSE job_work_items.outcome
           END,
           updated_at = ?1
         FROM dispatch_batch_items item
         JOIN work_items work ON work.id = item.work_item_id
         WHERE job_work_items.work_item_id = item.work_item_id
           AND item.dispatch_batch_id = ?2
           AND job_work_items.outcome = 'pending'
           AND work.state IN ('complete', 'terminal')`,
      )
      .bind(input.now, input.dispatchBatchId)
      .run();
    return result.meta.changes;
  }
}
