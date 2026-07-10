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
    for (const item of input.work) {
      if (
        item.scope !== "global_fact" ||
        item.state !== "dispatching" ||
        item.workType !== input.batch.workType ||
        item.instrumentId !== input.batch.instrumentId ||
        !item.effectiveDate ||
        item.effectiveDate < input.batch.requestedStartDate ||
        item.effectiveDate > input.batch.requestedEndDate
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
    const completedAt =
      input.to === "complete" || input.to === "terminal" ? input.now : null;
    const result = await this.db
      .prepare(
        `UPDATE dispatch_batches
         SET state = ?1, processing_lease_until = ?2,
             terminal_error_code = ?3, terminal_error_message = ?4,
             completed_at = ?5, retention_until = ?6, updated_at = ?7
         WHERE id = ?8 AND state = ?9`,
      )
      .bind(
        input.to,
        input.processingLeaseUntil ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        completedAt,
        input.retentionUntil ?? null,
        input.now,
        input.id,
        input.from,
      )
      .run();
    return result.meta.changes === 1;
  }
}
