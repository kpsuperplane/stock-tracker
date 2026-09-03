import type { SyncSliceMessage } from "../shared/contracts";
import {
  nextUtcReset,
  RESOURCE_ENVELOPES,
  type ResourceEnvelope,
  ResourceGovernor,
  utcUsageDate,
} from "./resource-governor";

export type SyncDataset =
  | "market"
  | "analysis"
  | "dividends"
  | "earnings"
  | "portfolio_history";
export type SyncPriorityClass = "current" | "future" | "recent" | "history";

interface EligibilityInterval {
  instrumentId: string;
  startDate: string;
  endDate: string;
}

interface PipelineJobRow {
  id: string;
  status: string;
  syncLane: "current" | "history";
  priority: number;
  requestedStartDate: string | null;
  requestedEndDate: string | null;
  affectedInstrumentsJson: string;
  eligibilityIntervalsJson: string;
  supersededAt: string | null;
}

export interface SyncIntentRow {
  id: string;
  pipelineJobId: string | null;
  instrumentId: string;
  dataset: SyncDataset;
  priorityClass: SyncPriorityClass;
  targetStartDate: string;
  targetEndDate: string;
  cursorEndDate: string;
  status:
    | "pending"
    | "waiting"
    | "dispatching"
    | "active"
    | "current"
    | "blocked"
    | "superseded";
  priority: number;
  attemptCount: number;
  maxAttempts: number;
}

export interface SyncSliceRow {
  id: string;
  intentId: string;
  reservationId: string;
  requestedStartDate: string;
  requestedEndDate: string;
  state: string;
  leaseToken: string;
  leaseUntil: string;
  attemptCount: number;
  maxAttempts: number;
}

export const dateAdd = (date: string, days: number): string => {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const parseIntervals = (value: string): EligibilityInterval[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((candidate): candidate is EligibilityInterval => {
      if (typeof candidate !== "object" || candidate === null) return false;
      const row = candidate as Record<string, unknown>;
      return (
        typeof row.instrumentId === "string" &&
        typeof row.startDate === "string" &&
        typeof row.endDate === "string" &&
        row.startDate <= row.endDate
      );
    });
  } catch {
    return [];
  }
};

const parseInstrumentIds = (value: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

const mergedIntervals = (
  intervals: readonly EligibilityInterval[],
): EligibilityInterval[] => {
  const grouped = new Map<string, EligibilityInterval[]>();
  for (const interval of intervals) {
    const list = grouped.get(interval.instrumentId) ?? [];
    list.push(interval);
    grouped.set(interval.instrumentId, list);
  }
  const result: EligibilityInterval[] = [];
  for (const [instrumentId, values] of grouped) {
    const sorted = [...values].sort((left, right) =>
      left.startDate.localeCompare(right.startDate),
    );
    for (const interval of sorted) {
      const previous = result.at(-1);
      if (
        !previous ||
        previous.instrumentId !== instrumentId ||
        interval.startDate > dateAdd(previous.endDate, 1)
      ) {
        result.push({ ...interval });
      } else if (interval.endDate > previous.endDate) {
        previous.endDate = interval.endDate;
      }
    }
  }
  return result;
};

const rowToIntent = (row: SyncIntentRow): SyncIntentRow => row;

export const intentSelection = `
  SELECT id, pipeline_job_id AS pipelineJobId,
         instrument_id AS instrumentId, dataset,
         priority_class AS priorityClass,
         target_start_date AS targetStartDate,
         target_end_date AS targetEndDate,
         cursor_end_date AS cursorEndDate, status, priority,
         attempt_count AS attemptCount, max_attempts AS maxAttempts
    FROM sync_intents`;

const envelopeFor = (intent: SyncIntentRow): ResourceEnvelope => {
  if (intent.dataset === "analysis") {
    return intent.priorityClass === "history"
      ? RESOURCE_ENVELOPES.historyAnalysis
      : RESOURCE_ENVELOPES.foregroundAnalysis;
  }
  return intent.priorityClass === "history"
    ? RESOURCE_ENVELOPES.historyMarket
    : RESOURCE_ENVELOPES.foregroundMarket;
};

export interface SyncIntentSchedulerDependencies {
  db: D1Database;
  foregroundQueue: Queue<SyncSliceMessage>;
  historyQueue: Queue<SyncSliceMessage>;
  now?: () => Date;
  newId?: () => string;
  maxSliceCalendarDays?: number;
  enabledPriorityClasses?: readonly SyncPriorityClass[];
}

export class SyncIntentScheduler {
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly maxSliceDays: number;
  private readonly governor: ResourceGovernor;
  private readonly enabledPriorityClasses: ReadonlySet<SyncPriorityClass>;

  constructor(private readonly dependencies: SyncIntentSchedulerDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.newId = dependencies.newId ?? (() => crypto.randomUUID());
    this.maxSliceDays = Math.max(
      1,
      Math.min(90, Math.floor(dependencies.maxSliceCalendarDays ?? 90)),
    );
    this.governor = new ResourceGovernor(dependencies.db, this.now, this.newId);
    this.enabledPriorityClasses = new Set(
      dependencies.enabledPriorityClasses ?? [
        "current",
        "future",
        "recent",
        "history",
      ],
    );
  }

  async createForPipelineJob(jobId: string): Promise<number> {
    const job = await this.dependencies.db
      .prepare(
        `SELECT id, status, sync_lane AS syncLane, priority,
                requested_start_date AS requestedStartDate,
                requested_end_date AS requestedEndDate,
                affected_instruments_json AS affectedInstrumentsJson,
                eligibility_intervals_json AS eligibilityIntervalsJson,
                superseded_at AS supersededAt
           FROM pipeline_jobs WHERE id = ?1`,
      )
      .bind(jobId)
      .first<PipelineJobRow>();
    if (
      !job ||
      job.supersededAt ||
      !["pending", "planning", "running"].includes(job.status)
    ) {
      return 0;
    }
    let intervals = parseIntervals(job.eligibilityIntervalsJson);
    if (
      intervals.length === 0 &&
      job.requestedStartDate &&
      job.requestedEndDate
    ) {
      intervals = parseInstrumentIds(job.affectedInstrumentsJson).map(
        (instrumentId) => ({
          instrumentId,
          startDate: job.requestedStartDate as string,
          endDate: job.requestedEndDate as string,
        }),
      );
    }
    intervals = mergedIntervals(intervals);
    const timestamp = this.now().toISOString();
    const priorityClass: SyncPriorityClass =
      job.syncLane === "history" ? "history" : "current";
    const statements = intervals.map((interval) => {
      const deterministicKey = [
        "intent",
        job.id,
        "market",
        interval.instrumentId,
        interval.startDate,
        interval.endDate,
      ].join(":");
      return this.dependencies.db
        .prepare(
          `INSERT OR IGNORE INTO sync_intents
           (id, deterministic_key, pipeline_job_id, instrument_id, dataset,
            priority_class, target_start_date, target_end_date,
            cursor_end_date, status, priority, attempt_count, max_attempts,
            created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, 'market', ?5, ?6, ?7, ?7, 'pending',
                   ?8, 0, 5, ?9, ?9)`,
        )
        .bind(
          this.newId(),
          deterministicKey,
          job.id,
          interval.instrumentId,
          priorityClass,
          interval.startDate,
          interval.endDate,
          job.priority,
          timestamp,
        );
    });
    const results =
      statements.length > 0 ? await this.dependencies.db.batch(statements) : [];
    await this.dependencies.db.batch([
      this.dependencies.db
        .prepare(
          `UPDATE work_items
              SET state = 'complete', completed_at = ?1, updated_at = ?1,
                  result_revision = 'compact-intents-v1'
            WHERE pipeline_job_id = ?2 AND scope = 'job_planning'
              AND state NOT IN ('complete', 'terminal')`,
        )
        .bind(timestamp, job.id),
      this.dependencies.db
        .prepare(
          `UPDATE job_work_items
              SET outcome = 'processed', updated_at = ?1
            WHERE pipeline_job_id = ?2 AND outcome = 'pending'
              AND work_item_id IN (
                SELECT id FROM work_items WHERE pipeline_job_id = ?2
                  AND scope = 'job_planning'
              )`,
        )
        .bind(timestamp, job.id),
      this.dependencies.db
        .prepare(
          `UPDATE pipeline_jobs
              SET status = CASE WHEN sync_intents_pending = 0
                                THEN 'complete' ELSE 'running' END,
                  started_at = COALESCE(started_at, ?1), updated_at = ?1,
                  completed_at = CASE WHEN sync_intents_pending = 0
                                      THEN ?1 ELSE NULL END
            WHERE id = ?2 AND status IN ('pending', 'planning', 'running')`,
        )
        .bind(timestamp, job.id),
    ]);
    return results.filter((result) => result.meta.changes > 0).length;
  }

  async ensureForegroundCoverage(
    instruments: readonly { id: string; latestCompletedDate: string }[],
    includeRecent: boolean,
  ): Promise<number> {
    if (instruments.length === 0) return 0;
    const timestamp = this.now().toISOString();
    const statements: D1PreparedStatement[] = [];
    for (const instrument of instruments) {
      const definitions: Array<{
        priorityClass: "current" | "recent";
        startDate: string;
        priority: number;
      }> = [
        {
          priorityClass: "current",
          startDate: instrument.latestCompletedDate,
          priority: 100,
        },
        ...(includeRecent
          ? [
              {
                priorityClass: "recent" as const,
                startDate: dateAdd(instrument.latestCompletedDate, -89),
                priority: 80,
              },
            ]
          : []),
      ];
      for (const definition of definitions) {
        const deterministicKey = `intent:scheduled:${definition.priorityClass}:${instrument.id}`;
        statements.push(
          this.dependencies.db
            .prepare(
              `INSERT INTO sync_intents
               (id, deterministic_key, pipeline_job_id, instrument_id,
                dataset, priority_class, target_start_date, target_end_date,
                cursor_end_date, status, priority, attempt_count, max_attempts,
                created_at, updated_at)
               VALUES (?1, ?2, NULL, ?3, 'market', ?4, ?5, ?6, ?6,
                       'pending', ?7, 0, 5, ?8, ?8)
               ON CONFLICT(deterministic_key) DO UPDATE SET
                 target_start_date = excluded.target_start_date,
                 target_end_date = excluded.target_end_date,
                 cursor_end_date = CASE
                   WHEN excluded.target_end_date > sync_intents.target_end_date
                   THEN excluded.target_end_date ELSE sync_intents.cursor_end_date END,
                 status = CASE
                   WHEN excluded.target_end_date > sync_intents.target_end_date
                   THEN 'pending' ELSE sync_intents.status END,
                 next_attempt_at = CASE
                   WHEN excluded.target_end_date > sync_intents.target_end_date
                   THEN NULL ELSE sync_intents.next_attempt_at END,
                 updated_at = CASE
                   WHEN excluded.target_end_date > sync_intents.target_end_date
                   THEN excluded.updated_at ELSE sync_intents.updated_at END`,
            )
            .bind(
              this.newId(),
              deterministicKey,
              instrument.id,
              definition.priorityClass,
              definition.startDate,
              instrument.latestCompletedDate,
              definition.priority,
              timestamp,
            ),
        );
      }
    }
    const results = await this.dependencies.db.batch(statements);
    return results.reduce((sum, result) => sum + result.meta.changes, 0);
  }

  async dispatch(limit = 16): Promise<{ dispatched: number; waiting: number }> {
    const timestamp = this.now().toISOString();
    const rows = await this.dependencies.db
      .prepare(
        `${intentSelection}
          WHERE status IN ('pending', 'waiting')
            AND attempt_count < max_attempts
            AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
            AND (priority_class <> 'history' OR id = (
              SELECT candidate.id FROM sync_intents candidate
               WHERE candidate.instrument_id = sync_intents.instrument_id
                 AND candidate.priority_class = 'history'
                 AND candidate.status IN ('pending', 'waiting')
                 AND candidate.attempt_count < candidate.max_attempts
                 AND (candidate.next_attempt_at IS NULL
                   OR candidate.next_attempt_at <= ?1)
               ORDER BY COALESCE(candidate.last_served_at, candidate.created_at),
                        candidate.priority DESC, candidate.id
               LIMIT 1
            ))
          ORDER BY CASE priority_class
                     WHEN 'current' THEN 0 WHEN 'future' THEN 1
                     WHEN 'recent' THEN 2 ELSE 3 END,
                   priority DESC, COALESCE(last_served_at, created_at), id
          LIMIT ?2`,
      )
      .bind(timestamp, Math.max(1, Math.min(100, Math.floor(limit))))
      .all<SyncIntentRow>();
    let dispatched = 0;
    let waiting = 0;
    const historyServed = new Set<string>();
    for (const row of rows.results) {
      const intent = rowToIntent(row);
      if (!this.enabledPriorityClasses.has(intent.priorityClass)) continue;
      if (
        intent.priorityClass === "history" &&
        historyServed.has(intent.instrumentId)
      ) {
        continue;
      }
      const result = await this.dispatchIntent(intent);
      if (result === "dispatched") {
        dispatched += 1;
        if (intent.priorityClass === "history") {
          historyServed.add(intent.instrumentId);
        }
      } else if (result === "waiting") {
        waiting += 1;
      }
    }
    return { dispatched, waiting };
  }

  private async dispatchIntent(
    intent: SyncIntentRow,
  ): Promise<"dispatched" | "waiting" | "skipped"> {
    const timestamp = this.now().toISOString();
    const endDate = intent.cursorEndDate;
    const covered = await this.dependencies.db
      .prepare(
        `SELECT start_date AS startDate FROM coverage_intervals
          WHERE instrument_id = ?1 AND dataset = ?2
            AND start_date <= ?3 AND end_date >= ?3
          ORDER BY start_date LIMIT 1`,
      )
      .bind(intent.instrumentId, intent.dataset, endDate)
      .first<{ startDate: string }>();
    if (covered) {
      const nextCursor = dateAdd(covered.startDate, -1);
      const complete = nextCursor < intent.targetStartDate;
      await this.dependencies.db
        .prepare(
          `UPDATE sync_intents
              SET status = ?1,
                  cursor_end_date = CASE WHEN ?1 = 'current'
                                         THEN cursor_end_date ELSE ?2 END,
                  completed_at = CASE WHEN ?1 = 'current' THEN ?3 ELSE NULL END,
                  updated_at = ?3
            WHERE id = ?4 AND status IN ('pending', 'waiting')`,
        )
        .bind(
          complete ? "current" : "pending",
          nextCursor,
          timestamp,
          intent.id,
        )
        .run();
      return "skipped";
    }
    const startDate = [
      intent.targetStartDate,
      dateAdd(endDate, -(this.maxSliceDays - 1)),
    ]
      .sort()
      .at(-1) as string;
    const reservationKey = [
      "sync",
      intent.id,
      startDate,
      endDate,
      intent.attemptCount,
      utcUsageDate(this.now()),
    ].join(":");
    const reservation = await this.governor.reserve(
      reservationKey,
      envelopeFor(intent),
    );
    if (!reservation) {
      await this.dependencies.db
        .prepare(
          `UPDATE sync_intents
              SET status = 'waiting', next_attempt_at = ?1,
                  last_error_code = 'daily_budget',
                  last_error_message = 'Daily capacity is reserved for a later UTC day.',
                  updated_at = ?2
            WHERE id = ?3 AND status IN ('pending', 'waiting')`,
        )
        .bind(nextUtcReset(this.now()), timestamp, intent.id)
        .run();
      return "waiting";
    }
    let sliceId = this.newId();
    const leaseToken = this.newId();
    const leaseUntil = new Date(
      Date.parse(timestamp) + 10 * 60_000,
    ).toISOString();
    try {
      const reusable = await this.dependencies.db
        .prepare(
          `SELECT id FROM sync_slices
            WHERE reservation_id = ?1 AND intent_id = ?2
              AND state IN ('cancelled', 'retry')`,
        )
        .bind(reservation.id, intent.id)
        .first<{ id: string }>();
      const sliceStatement = reusable
        ? this.dependencies.db
            .prepare(
              `UPDATE sync_slices
                  SET state = 'dispatching', lease_token = ?1,
                      lease_until = ?2, error_code = NULL,
                      error_message = NULL, completed_at = NULL, updated_at = ?3
                WHERE id = ?4 AND state IN ('cancelled', 'retry')`,
            )
            .bind(leaseToken, leaseUntil, timestamp, reusable.id)
        : this.dependencies.db
            .prepare(
              `INSERT INTO sync_slices
               (id, idempotency_key, intent_id, reservation_id, requested_start_date,
                requested_end_date, state, lease_token, lease_until,
                attempt_count, max_attempts, created_at, updated_at)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'dispatching', ?7, ?8, 0, 5, ?9, ?9)`,
            )
            .bind(
              sliceId,
              reservationKey,
              intent.id,
              reservation.id,
              startDate,
              endDate,
              leaseToken,
              leaseUntil,
              timestamp,
            );
      if (reusable) sliceId = reusable.id;
      await this.dependencies.db.batch([
        sliceStatement,
        this.dependencies.db
          .prepare(
            `UPDATE sync_intents
                SET status = 'dispatching', last_served_at = ?1,
                    next_attempt_at = NULL, updated_at = ?1
              WHERE id = ?2 AND status IN ('pending', 'waiting')`,
          )
          .bind(timestamp, intent.id),
      ]);
    } catch (error) {
      await this.governor.release(reservation.id);
      if (
        /sync_queue_full|sync_slices_one_active_intent/i.test(String(error))
      ) {
        return "skipped";
      }
      throw error;
    }
    const queue =
      intent.priorityClass === "history"
        ? this.dependencies.historyQueue
        : this.dependencies.foregroundQueue;
    try {
      await queue.send({ syncSliceId: sliceId, leaseToken });
    } catch {
      await this.dependencies.db.batch([
        this.dependencies.db
          .prepare(
            `UPDATE sync_slices
                SET state = 'cancelled', error_code = 'queue_send_failed',
                    error_message = 'The queue did not accept the slice.',
                    completed_at = ?1, updated_at = ?1
              WHERE id = ?2 AND state = 'dispatching'`,
          )
          .bind(timestamp, sliceId),
        this.dependencies.db
          .prepare(
            `UPDATE sync_intents SET status = 'pending', updated_at = ?1
              WHERE id = ?2 AND status = 'dispatching'`,
          )
          .bind(timestamp, intent.id),
      ]);
      await this.governor.release(reservation.id);
      return "skipped";
    }
    await this.dependencies.db.batch([
      this.dependencies.db
        .prepare(
          `UPDATE sync_slices SET state = 'queued', updated_at = ?1
            WHERE id = ?2 AND state = 'dispatching' AND lease_token = ?3`,
        )
        .bind(timestamp, sliceId, leaseToken),
      this.dependencies.db
        .prepare(
          `UPDATE sync_intents SET status = 'active', updated_at = ?1
            WHERE id = ?2 AND status = 'dispatching'`,
        )
        .bind(timestamp, intent.id),
    ]);
    return "dispatched";
  }

  async recoverExpired(limit = 16): Promise<number> {
    const timestamp = this.now().toISOString();
    const rows = await this.dependencies.db
      .prepare(
        `SELECT slice.id, slice.intent_id AS intentId,
                slice.reservation_id AS reservationId
           FROM sync_slices slice
          WHERE slice.state IN ('dispatching', 'queued', 'processing')
            AND slice.lease_until <= ?1
          ORDER BY slice.lease_until, slice.id LIMIT ?2`,
      )
      .bind(timestamp, Math.max(1, Math.min(100, Math.floor(limit))))
      .all<{ id: string; intentId: string; reservationId: string }>();
    for (const row of rows.results) {
      await this.dependencies.db.batch([
        this.dependencies.db
          .prepare(
            `UPDATE sync_slices
                SET state = 'retry', error_code = 'lease_expired',
                    error_message = 'The processing lease expired.',
                    completed_at = ?1, updated_at = ?1
              WHERE id = ?2 AND state IN ('dispatching', 'queued', 'processing')`,
          )
          .bind(timestamp, row.id),
        this.dependencies.db
          .prepare(
            `UPDATE sync_intents
                SET status = 'pending', next_attempt_at = ?1, updated_at = ?1
              WHERE id = ?2 AND status IN ('dispatching', 'active')`,
          )
          .bind(timestamp, row.intentId),
      ]);
      await this.governor.release(row.reservationId);
    }
    return rows.results.length;
  }
}
