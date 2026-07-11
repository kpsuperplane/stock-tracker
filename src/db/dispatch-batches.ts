import { FactRevisionBucketRepository } from "./revision-buckets";
import type { WorkItemRecord } from "./work-items";

export type DispatchBatchState =
  | "dispatching"
  | "queued"
  | "processing"
  | "complete"
  | "terminal";

export interface DispatchBatchRecord {
  id: string;
  workType: string;
  instrumentId: string;
  requestedStartDate: string;
  requestedEndDate: string;
  state: DispatchBatchState;
  dispatchLeaseUntil: string | null;
  processingLeaseUntil: string | null;
  attemptCount: number;
  maxAttempts: number;
  dispatchAttemptCount?: number;
  dispatchMaxAttempts?: number;
  dlqState?: "none" | "pending" | "sending" | "delivered";
  dlqAttemptCount?: number;
  dlqLeaseUntil?: string | null;
  dlqLastError?: string | null;
  dlqDeliveredAt?: string | null;
  terminalErrorCode: string | null;
  terminalErrorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  retentionUntil: string | null;
}

interface DispatchBatchRow {
  id: string;
  work_type: string;
  instrument_id: string;
  requested_start_date: string;
  requested_end_date: string;
  state: DispatchBatchState;
  dispatch_lease_until: string | null;
  processing_lease_until: string | null;
  attempt_count: number;
  max_attempts: number;
  dispatch_attempt_count: number;
  dispatch_max_attempts: number;
  dlq_state: "none" | "pending" | "sending" | "delivered";
  dlq_attempt_count: number;
  dlq_lease_until: string | null;
  dlq_last_error: string | null;
  dlq_delivered_at: string | null;
  terminal_error_code: string | null;
  terminal_error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  retention_until: string | null;
}

const mapBatch = (row: DispatchBatchRow): DispatchBatchRecord => ({
  id: row.id,
  workType: row.work_type,
  instrumentId: row.instrument_id,
  requestedStartDate: row.requested_start_date,
  requestedEndDate: row.requested_end_date,
  state: row.state,
  dispatchLeaseUntil: row.dispatch_lease_until,
  processingLeaseUntil: row.processing_lease_until,
  attemptCount: row.attempt_count,
  maxAttempts: row.max_attempts,
  dispatchAttemptCount: row.dispatch_attempt_count ?? 0,
  dispatchMaxAttempts: row.dispatch_max_attempts ?? 3,
  dlqState: row.dlq_state ?? "none",
  dlqAttemptCount: row.dlq_attempt_count ?? 0,
  dlqLeaseUntil: row.dlq_lease_until ?? null,
  dlqLastError: row.dlq_last_error ?? null,
  dlqDeliveredAt: row.dlq_delivered_at ?? null,
  terminalErrorCode: row.terminal_error_code,
  terminalErrorMessage: row.terminal_error_message,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  retentionUntil: row.retention_until,
});

interface DispatchableWorkRow {
  id: string;
  scope: "job_planning" | "global_fact";
  state:
    | "pending"
    | "dispatching"
    | "queued"
    | "processing"
    | "complete"
    | "terminal";
  work_type: string;
  instrument_id: string | null;
  effective_date: string | null;
}

interface DispatchWorkItemRow {
  id: string;
  scope: WorkItemRecord["scope"];
  pipeline_job_id: string | null;
  work_type: string;
  instrument_id: string | null;
  effective_date: string | null;
  dependency_revision: string | null;
  forced_refresh_generation: number | null;
  deterministic_key: string;
  state: WorkItemRecord["state"];
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

const transitions: Readonly<
  Record<DispatchBatchState, readonly DispatchBatchState[]>
> = {
  dispatching: ["queued", "terminal"],
  queued: ["processing", "terminal"],
  processing: ["complete", "terminal"],
  complete: [],
  terminal: [],
};

export class DispatchBatchRepository {
  private readonly revisions: FactRevisionBucketRepository;

  constructor(private readonly db: D1Database) {
    this.revisions = new FactRevisionBucketRepository(db);
  }

  async createForWork(input: {
    batch: DispatchBatchRecord;
    work: readonly WorkItemRecord[];
  }): Promise<void> {
    if (input.work.length === 0) throw new Error("dispatch_batch_empty");
    if (input.batch.state !== "dispatching") {
      throw new Error("dispatch_batch_not_dispatching");
    }
    const workIds = [...new Set(input.work.map((item) => item.id))];
    if (workIds.length !== input.work.length) {
      throw new Error("dispatch_batch_duplicate_work");
    }
    const placeholders = workIds
      .map((_id, index) => `?${index + 1}`)
      .join(", ");
    const current = await this.db
      .prepare(
        `SELECT id, scope, state, work_type, instrument_id, effective_date
         FROM work_items WHERE id IN (${placeholders})`,
      )
      .bind(...workIds)
      .all<DispatchableWorkRow>();
    if (current.results.length !== workIds.length) {
      throw new Error("dispatch_batch_incompatible_work");
    }
    for (const item of current.results) {
      if (
        item.scope !== "global_fact" ||
        item.state !== "dispatching" ||
        item.work_type !== input.batch.workType ||
        item.instrument_id !== input.batch.instrumentId ||
        !item.effective_date ||
        item.effective_date < input.batch.requestedStartDate ||
        item.effective_date > input.batch.requestedEndDate
      ) {
        throw new Error("dispatch_batch_incompatible_work");
      }
    }
    await this.db.batch([
      this.createStatement(input.batch),
      ...input.work.map((item) =>
        this.db
          .prepare(
            `INSERT INTO dispatch_batch_items
             (dispatch_batch_id, work_item_id, created_at)
             VALUES (?1, ?2, ?3)`,
          )
          .bind(input.batch.id, item.id, input.batch.createdAt),
      ),
    ]);
  }

  /**
   * Claims work and writes the dispatch batch plus its outbox rows in one D1
   * transaction. If any claim or compatibility check loses a race, the whole
   * transaction rolls back so no work can remain stranded without a batch.
   */
  async createClaimedForWork(input: {
    batch: DispatchBatchRecord;
    work: readonly WorkItemRecord[];
  }): Promise<void> {
    if (input.work.length === 0) throw new Error("dispatch_batch_empty");
    if (input.batch.state !== "dispatching") {
      throw new Error("dispatch_batch_not_dispatching");
    }
    const workIds = [...new Set(input.work.map((item) => item.id))];
    if (workIds.length !== input.work.length) {
      throw new Error("dispatch_batch_duplicate_work");
    }
    const claimStatements = input.work.map((item) =>
      this.db
        .prepare(
          `UPDATE work_items
           SET state = 'dispatching', dispatch_lease_until = ?1,
               attempt_count = attempt_count + 1, updated_at = ?2
           WHERE id = ?3 AND scope = 'global_fact' AND state = 'pending'
             AND attempt_count < max_attempts
             AND (available_at IS NULL OR available_at <= ?2)`,
        )
        .bind(input.batch.dispatchLeaseUntil, input.batch.createdAt, item.id),
    );
    const guardedBatchStatement = this.createStatementWithReservation(
      input.batch,
    );
    await this.db.batch([
      this.db
        .prepare(
          `UPDATE dispatch_daily_reservations
           SET expires_at = expires_at
           WHERE dispatch_batch_id = ?1 AND expires_at > ?2`,
        )
        .bind(input.batch.id, input.batch.createdAt),
      ...claimStatements,
      guardedBatchStatement,
      ...input.work.map((item) =>
        this.db
          .prepare(
            `INSERT INTO dispatch_batch_items
             (dispatch_batch_id, work_item_id, created_at)
             VALUES (?1, ?2, ?3)`,
          )
          .bind(input.batch.id, item.id, input.batch.createdAt),
      ),
      this.revisions.bumpWorkItemsForBatchStatement(
        input.batch.id,
        input.batch.createdAt,
      ),
      this.revisions.bumpLatestForWorkItemsForBatchStatement(
        input.batch.id,
        input.batch.createdAt,
      ),
    ]);
  }

  private createStatementWithReservation(
    batch: DispatchBatchRecord,
  ): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO dispatch_batches
         (id, work_type, instrument_id, requested_start_date,
          requested_end_date, state, dispatch_lease_until,
          processing_lease_until, attempt_count, max_attempts,
          dispatch_attempt_count, dispatch_max_attempts, dlq_state,
          dlq_attempt_count, dlq_lease_until, dlq_last_error, dlq_delivered_at,
          terminal_error_code, terminal_error_message, created_at,
          updated_at, completed_at, retention_until)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
         WHERE EXISTS (
           SELECT 1 FROM dispatch_daily_reservations
           WHERE dispatch_batch_id = ?1 AND expires_at > ?20
         )`,
      )
      .bind(
        batch.id,
        batch.workType,
        batch.instrumentId,
        batch.requestedStartDate,
        batch.requestedEndDate,
        batch.state,
        batch.dispatchLeaseUntil,
        batch.processingLeaseUntil,
        batch.attemptCount,
        batch.maxAttempts,
        batch.dispatchAttemptCount ?? 0,
        batch.dispatchMaxAttempts ?? 3,
        batch.dlqState ?? "none",
        batch.dlqAttemptCount ?? 0,
        batch.dlqLeaseUntil ?? null,
        batch.dlqLastError ?? null,
        batch.dlqDeliveredAt ?? null,
        batch.terminalErrorCode,
        batch.terminalErrorMessage,
        batch.createdAt,
        batch.updatedAt,
        batch.completedAt,
        batch.retentionUntil,
      );
  }

  async reserveDailyCapacity(input: {
    dispatchBatchId: string;
    reservationDay: string;
    workCount: number;
    dailyCeiling: number;
    createdAt: string;
    expiresAt: string;
  }): Promise<boolean> {
    if (input.workCount <= 0 || input.dailyCeiling <= 0) return false;
    const result = await this.db
      .prepare(
        `INSERT INTO dispatch_daily_reservations
         (dispatch_batch_id, reservation_day, work_count, created_at, expires_at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE COALESCE(
           (SELECT SUM(work_count)
            FROM dispatch_daily_reservations
            WHERE reservation_day = ?2), 0
         ) + COALESCE(
           (SELECT COUNT(*)
            FROM dispatch_batch_items item
            JOIN dispatch_batches batch ON batch.id = item.dispatch_batch_id
            LEFT JOIN dispatch_daily_reservations reservation
              ON reservation.dispatch_batch_id = item.dispatch_batch_id
            WHERE reservation.dispatch_batch_id IS NULL
              AND substr(item.created_at, 1, 10) = ?2), 0
         ) + ?3 <= ?6
           AND NOT EXISTS (
             SELECT 1 FROM dispatch_daily_reservations
             WHERE dispatch_batch_id = ?1
           )`,
      )
      .bind(
        input.dispatchBatchId,
        input.reservationDay,
        input.workCount,
        input.createdAt,
        input.expiresAt,
        input.dailyCeiling,
      )
      .run();
    return result.meta.changes === 1;
  }

  async releaseDailyCapacity(dispatchBatchId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        "DELETE FROM dispatch_daily_reservations WHERE dispatch_batch_id = ?1",
      )
      .bind(dispatchBatchId)
      .run();
    return result.meta.changes === 1;
  }

  async recoverExpiredDailyReservations(now: string): Promise<number> {
    const result = await this.db
      .prepare(
        `DELETE FROM dispatch_daily_reservations
         WHERE expires_at <= ?1
           AND NOT EXISTS (
             SELECT 1 FROM dispatch_batches
             WHERE dispatch_batches.id = dispatch_daily_reservations.dispatch_batch_id
           )`,
      )
      .bind(now)
      .run();
    return result.meta.changes;
  }

  async countReservedWork(reservationDay: string): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COALESCE(SUM(work_count), 0) AS count
         FROM dispatch_daily_reservations
         WHERE reservation_day = ?1`,
      )
      .bind(reservationDay)
      .first<{ count: number }>();
    const legacy = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM dispatch_batch_items item
         JOIN dispatch_batches batch ON batch.id = item.dispatch_batch_id
         LEFT JOIN dispatch_daily_reservations reservation
           ON reservation.dispatch_batch_id = item.dispatch_batch_id
         WHERE reservation.dispatch_batch_id IS NULL
           AND substr(item.created_at, 1, 10) = ?1`,
      )
      .bind(reservationDay)
      .first<{ count: number }>();
    return (row?.count ?? 0) + (legacy?.count ?? 0);
  }

  createStatement(batch: DispatchBatchRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO dispatch_batches
         (id, work_type, instrument_id, requested_start_date,
         requested_end_date, state, dispatch_lease_until,
         processing_lease_until, attempt_count, max_attempts,
         dispatch_attempt_count, dispatch_max_attempts, dlq_state,
         dlq_attempt_count, dlq_lease_until, dlq_last_error, dlq_delivered_at,
         terminal_error_code, terminal_error_message, created_at,
         updated_at, completed_at, retention_until)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                 ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)`,
      )
      .bind(
        batch.id,
        batch.workType,
        batch.instrumentId,
        batch.requestedStartDate,
        batch.requestedEndDate,
        batch.state,
        batch.dispatchLeaseUntil,
        batch.processingLeaseUntil,
        batch.attemptCount,
        batch.maxAttempts,
        batch.dispatchAttemptCount ?? 0,
        batch.dispatchMaxAttempts ?? 3,
        batch.dlqState ?? "none",
        batch.dlqAttemptCount ?? 0,
        batch.dlqLeaseUntil ?? null,
        batch.dlqLastError ?? null,
        batch.dlqDeliveredAt ?? null,
        batch.terminalErrorCode,
        batch.terminalErrorMessage,
        batch.createdAt,
        batch.updatedAt,
        batch.completedAt,
        batch.retentionUntil,
      );
  }

  async findById(id: string): Promise<DispatchBatchRecord | null> {
    const row = await this.db
      .prepare("SELECT * FROM dispatch_batches WHERE id = ?1")
      .bind(id)
      .first<DispatchBatchRow>();
    return row ? mapBatch(row) : null;
  }

  async listWork(batchId: string): Promise<WorkItemRecord[]> {
    const rows = await this.db
      .prepare(
        `SELECT work.*
         FROM dispatch_batch_items item
         JOIN work_items work ON work.id = item.work_item_id
         WHERE item.dispatch_batch_id = ?1
         ORDER BY work.effective_date, work.id`,
      )
      .bind(batchId)
      .all<DispatchWorkItemRow>();
    return rows.results.map((row) => ({
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
    }));
  }

  async claimForProcessing(input: {
    id: string;
    now: string;
    leaseUntil: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE dispatch_batches
         SET state = 'processing', processing_lease_until = ?1,
             dispatch_lease_until = NULL, attempt_count = attempt_count + 1,
             updated_at = ?2
         WHERE id = ?3
           AND attempt_count < max_attempts
           AND (
             (state = 'dispatching' AND dispatch_lease_until IS NOT NULL
              AND dispatch_lease_until > ?2)
             OR state = 'queued'
           )`,
      )
      .bind(input.leaseUntil, input.now, input.id)
      .run();
    return result.meta.changes === 1;
  }

  async reclaimExpiredProcessing(input: {
    id: string;
    expectedLeaseUntil: string;
    now: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE dispatch_batches
         SET state = 'queued', processing_lease_until = NULL,
             updated_at = ?1
         WHERE id = ?2 AND state = 'processing'
           AND processing_lease_until IS ?3
           AND processing_lease_until <= ?1`,
      )
      .bind(input.now, input.id, input.expectedLeaseUntil)
      .run();
    return result.meta.changes === 1;
  }

  async requeueProcessing(input: {
    id: string;
    expectedLeaseUntil: string;
    now: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE dispatch_batches
         SET state = 'queued', processing_lease_until = NULL,
             updated_at = ?1
         WHERE id = ?2 AND state = 'processing'
           AND processing_lease_until IS ?3`,
      )
      .bind(input.now, input.id, input.expectedLeaseUntil)
      .run();
    return result.meta.changes === 1;
  }

  async claimDispatchAttempt(input: {
    id: string;
    now: string;
    expectedDispatchLeaseUntil?: string;
  }): Promise<boolean> {
    const result = input.expectedDispatchLeaseUntil
      ? await this.db
          .prepare(
            `UPDATE dispatch_batches
             SET dispatch_attempt_count = dispatch_attempt_count + 1,
                 updated_at = ?1
             WHERE id = ?2 AND state = 'dispatching'
               AND dispatch_lease_until IS ?3
               AND dispatch_attempt_count < dispatch_max_attempts`,
          )
          .bind(input.now, input.id, input.expectedDispatchLeaseUntil)
          .run()
      : await this.db
          .prepare(
            `UPDATE dispatch_batches
             SET dispatch_attempt_count = dispatch_attempt_count + 1,
                 updated_at = ?1
             WHERE id = ?2 AND state = 'queued'
               AND dispatch_attempt_count < dispatch_max_attempts`,
          )
          .bind(input.now, input.id)
          .run();
    return result.meta.changes === 1;
  }

  async claimDlqDelivery(input: {
    id: string;
    now: string;
    leaseUntil: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE dispatch_batches
         SET dlq_state = 'sending', dlq_lease_until = ?1,
             dlq_attempt_count = dlq_attempt_count + 1,
             dlq_last_error = NULL, updated_at = ?2
         WHERE id = ?3 AND state = 'terminal'
           AND (
             dlq_state = 'none'
             OR
             dlq_state = 'pending'
             OR (dlq_state = 'sending' AND dlq_lease_until IS NOT NULL
                 AND dlq_lease_until <= ?2)
           )`,
      )
      .bind(input.leaseUntil, input.now, input.id)
      .run();
    return result.meta.changes === 1;
  }

  /**
   * Atomically terminalizes a batch, its linked work, and pending job links.
   * The batch CAS is the ownership fence; all following statements require
   * the terminal batch state, so a stale owner cannot mutate a newly claimed
   * batch and a crash cannot leave a queued terminal batch half-settled.
   */
  async terminalizeBatchAndItems(input: {
    id: string;
    from: "dispatching" | "queued" | "processing";
    now: string;
    errorCode: string;
    errorMessage: string;
    expectedDispatchLeaseUntil?: string;
    expectedProcessingLeaseUntil?: string;
  }): Promise<boolean> {
    if (input.from === "dispatching" && !input.expectedDispatchLeaseUntil) {
      throw new Error("terminal_dispatch_batch_requires_lease");
    }
    if (input.from === "processing" && !input.expectedProcessingLeaseUntil) {
      throw new Error("terminal_processing_batch_requires_lease");
    }
    const leasePredicate =
      input.from === "dispatching"
        ? " AND dispatch_lease_until IS ?6"
        : input.from === "processing"
          ? " AND processing_lease_until IS ?6"
          : "";
    const batchBindings =
      input.from === "dispatching"
        ? [
            input.errorCode,
            input.errorMessage,
            input.now,
            input.id,
            input.from,
            input.expectedDispatchLeaseUntil,
          ]
        : input.from === "processing"
          ? [
              input.errorCode,
              input.errorMessage,
              input.now,
              input.id,
              input.from,
              input.expectedProcessingLeaseUntil,
            ]
          : [
              input.errorCode,
              input.errorMessage,
              input.now,
              input.id,
              input.from,
            ];
    const batchStatement = this.db.prepare(
      `UPDATE dispatch_batches
       SET state = 'terminal', dispatch_lease_until = NULL,
           processing_lease_until = NULL, terminal_error_code = ?1,
           terminal_error_message = ?2, completed_at = ?3, updated_at = ?3,
           dlq_state = CASE WHEN dlq_state = 'delivered'
                            THEN 'delivered' ELSE 'pending' END,
           dlq_lease_until = NULL
       WHERE id = ?4 AND state = ?5${leasePredicate}`,
    );
    const itemStatement = this.db
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
           )
           AND EXISTS (
             SELECT 1 FROM dispatch_batches batch
             WHERE batch.id = ?4 AND batch.state = 'terminal'
           )`,
      )
      .bind(input.errorCode, input.errorMessage, input.now, input.id);
    const linkStatement = this.db
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
           AND EXISTS (
             SELECT 1 FROM dispatch_batches batch
             WHERE batch.id = ?2 AND batch.state = 'terminal'
           )
           AND work.state IN ('complete', 'terminal')`,
      )
      .bind(input.now, input.id);
    const results = await this.db.batch([
      batchStatement.bind(...batchBindings),
      itemStatement,
      linkStatement,
      this.revisions.bumpWorkItemsForBatchStatement(input.id, input.now),
      this.revisions.bumpLatestForWorkItemsForBatchStatement(
        input.id,
        input.now,
      ),
    ]);
    return results[0]?.meta.changes === 1;
  }

  async markDlqDelivered(input: {
    id: string;
    now: string;
    expectedLeaseUntil: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE dispatch_batches
         SET dlq_state = 'delivered', dlq_lease_until = NULL,
             dlq_delivered_at = ?1, dlq_last_error = NULL, updated_at = ?1
         WHERE id = ?2 AND state = 'terminal' AND dlq_state = 'sending'
           AND dlq_lease_until IS ?3`,
      )
      .bind(input.now, input.id, input.expectedLeaseUntil)
      .run();
    return result.meta.changes === 1;
  }

  async releaseDlqDelivery(input: {
    id: string;
    now: string;
    expectedLeaseUntil: string;
    error: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE dispatch_batches
         SET dlq_state = 'pending', dlq_lease_until = NULL,
             dlq_last_error = ?1, updated_at = ?2
         WHERE id = ?3 AND state = 'terminal' AND dlq_state = 'sending'
           AND dlq_lease_until IS ?4`,
      )
      .bind(input.error, input.now, input.id, input.expectedLeaseUntil)
      .run();
    return result.meta.changes === 1;
  }

  async transition(input: {
    id: string;
    from: DispatchBatchState;
    to: DispatchBatchState;
    now: string;
    processingLeaseUntil?: string | null;
    errorCode?: string | null;
    errorMessage?: string | null;
    retentionUntil?: string | null;
    expectedDispatchLeaseUntil?: string;
    expectedProcessingLeaseUntil?: string;
  }): Promise<boolean> {
    if (!transitions[input.from].includes(input.to)) {
      throw new Error("invalid_dispatch_batch_transition");
    }
    if (input.to === "terminal" && !input.errorCode) {
      throw new Error("terminal_dispatch_batch_requires_error");
    }
    if (input.to !== "terminal" && (input.errorCode || input.errorMessage)) {
      throw new Error("nonterminal_dispatch_batch_has_error");
    }
    if (input.from === "dispatching" && !input.expectedDispatchLeaseUntil) {
      throw new Error("dispatch_batch_transition_requires_lease");
    }
    if (input.from === "processing" && !input.expectedProcessingLeaseUntil) {
      throw new Error("processing_batch_transition_requires_lease");
    }
    const completedAt =
      input.to === "complete" || input.to === "terminal" ? input.now : null;
    const leasePredicate =
      input.from === "dispatching"
        ? " AND dispatch_lease_until IS ?10"
        : input.from === "processing"
          ? " AND processing_lease_until IS ?10"
          : "";
    const statement = this.db.prepare(
      `UPDATE dispatch_batches
         SET state = ?1, dispatch_lease_until = NULL,
             processing_lease_until = ?2,
             terminal_error_code = ?3, terminal_error_message = ?4,
             completed_at = ?5, retention_until = ?6, updated_at = ?7
             ${
               input.to === "terminal"
                 ? ", dlq_state = CASE WHEN dlq_state = 'delivered' THEN 'delivered' ELSE 'pending' END, dlq_lease_until = NULL"
                 : ""
}
         WHERE id = ?8 AND state = ?9${leasePredicate}`,
    );
    const bindings = [
      input.to,
      input.processingLeaseUntil ?? null,
      input.errorCode ?? null,
      input.errorMessage ?? null,
      completedAt,
      input.retentionUntil ?? null,
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

  async reclaimExpiredDispatch(input: {
    id: string;
    expectedLeaseUntil: string;
    now: string;
    leaseUntil: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE dispatch_batches
         SET dispatch_lease_until = ?1, updated_at = ?2
         WHERE id = ?3 AND state = 'dispatching'
           AND dispatch_lease_until IS ?4 AND dispatch_lease_until <= ?2`,
      )
      .bind(input.leaseUntil, input.now, input.id, input.expectedLeaseUntil)
      .run();
    return result.meta.changes === 1;
  }

  async moveQueuedToDispatching(input: {
    id: string;
    now: string;
    leaseUntil: string;
  }): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE dispatch_batches
         SET state = 'dispatching', dispatch_lease_until = ?1,
             updated_at = ?2
         WHERE id = ?3 AND state = 'queued'`,
      )
      .bind(input.leaseUntil, input.now, input.id)
      .run();
    return result.meta.changes === 1;
  }
}
