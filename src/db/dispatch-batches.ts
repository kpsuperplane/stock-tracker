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
  constructor(private readonly db: D1Database) {}

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

  createStatement(batch: DispatchBatchRecord): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO dispatch_batches
         (id, work_type, instrument_id, requested_start_date,
          requested_end_date, state, dispatch_lease_until,
          processing_lease_until, attempt_count, max_attempts,
          terminal_error_code, terminal_error_message, created_at,
          updated_at, completed_at, retention_until)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                 ?13, ?14, ?15, ?16)`,
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
         SET state = ?1, processing_lease_until = ?2,
             terminal_error_code = ?3, terminal_error_message = ?4,
             completed_at = ?5, retention_until = ?6, updated_at = ?7
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
}
