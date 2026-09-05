import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { PipelineJobRepository } from "../../src/db/pipeline-jobs";
import { D1UsageMeter } from "../../src/services/d1-usage";
import { SyncIntentScheduler } from "../../src/services/sync-intents";
import { SyncSliceProcessor } from "../../src/services/sync-slice-processor";
import {
  isReadModelRefreshMessage,
  isSyncSliceMessage,
  type SyncSliceMessage,
} from "../../src/shared/contracts";

const now = "2026-07-11T12:00:00.000Z";

const insertInstrument = async (id: string): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO instruments
     (id, symbol, company_name, exchange, currency, instrument_type,
      provider, provider_symbol, created_at, updated_at)
     VALUES (?1, ?1, ?1, 'NYSE', 'USD', 'stock', 'yahoo', ?1, ?2, ?2)`,
  )
    .bind(id, now)
    .run();
};

const queue = (failureCount = 0) => {
  const sent: SyncSliceMessage[] = [];
  let remainingFailures = failureCount;
  return {
    sent,
    binding: {
      send: vi.fn(async (message: SyncSliceMessage) => {
        if (remainingFailures > 0) {
          remainingFailures -= 1;
          throw new Error("queue unavailable");
        }
        sent.push(message);
      }),
    } as unknown as Queue<SyncSliceMessage>,
  };
};

const scheduler = (
  foreground: Queue<SyncSliceMessage>,
  history: Queue<SyncSliceMessage>,
) =>
  new SyncIntentScheduler({
    db: env.DB,
    foregroundQueue: foreground,
    historyQueue: history,
    now: () => new Date(now),
  });

describe("compact quota-aware sync intents", () => {
  it("rejects queue envelopes with missing or extra fields", () => {
    expect(
      isSyncSliceMessage({ syncSliceId: "slice", leaseToken: "lease" }),
    ).toBe(true);
    expect(
      isSyncSliceMessage({
        syncSliceId: "slice",
        leaseToken: "lease",
        extra: true,
      }),
    ).toBe(false);
    expect(
      isReadModelRefreshMessage({
        readModelRefreshId: "refresh",
        leaseToken: "lease",
      }),
    ).toBe(true);
    expect(isReadModelRefreshMessage({ readModelRefreshId: "refresh" })).toBe(
      false,
    );
  });

  it("releases a failed queue send without consuming a provider attempt", async () => {
    await insertInstrument("queue-failure");
    const foreground = queue(1);
    const history = queue();
    const service = scheduler(foreground.binding, history.binding);
    await service.ensureForegroundCoverage(
      [{ id: "queue-failure", latestCompletedDate: "2026-07-10" }],
      false,
    );

    expect(await service.dispatch(1)).toEqual({ dispatched: 0, waiting: 0 });
    expect(
      await env.DB.prepare(
        `SELECT status, attempt_count AS attempts FROM sync_intents
          WHERE instrument_id = 'queue-failure'`,
      ).first(),
    ).toEqual({ status: "pending", attempts: 0 });
    expect(
      await env.DB.prepare("SELECT state FROM resource_reservations").first(),
    ).toEqual({ state: "released" });

    expect(await service.dispatch(1)).toEqual({ dispatched: 1, waiting: 0 });
    expect(foreground.sent).toHaveLength(1);
  });

  it("waits for finalized daily bars without reserving provider capacity", async () => {
    await insertInstrument("provider-settlement");
    const foreground = queue();
    const history = queue();
    const early = new Date("2026-07-10T22:00:00.000Z");
    const service = new SyncIntentScheduler({
      db: env.DB,
      foregroundQueue: foreground.binding,
      historyQueue: history.binding,
      now: () => early,
    });
    await service.ensureForegroundCoverage(
      [{ id: "provider-settlement", latestCompletedDate: "2026-07-10" }],
      false,
    );

    expect(await service.dispatch(1)).toEqual({ dispatched: 0, waiting: 0 });
    expect(foreground.sent).toHaveLength(0);
    expect(
      await env.DB.prepare(
        `SELECT status, next_attempt_at AS nextAttemptAt, attempt_count AS attempts
           FROM sync_intents WHERE instrument_id = 'provider-settlement'`,
      ).first(),
    ).toEqual({
      status: "pending",
      nextAttemptAt: "2026-07-11T02:00:00.000Z",
      attempts: 0,
    });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM resource_reservations
          WHERE lane = 'foreground'`,
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("resets attempts when the scheduled coverage date advances", async () => {
    await insertInstrument("daily-attempt-reset");
    const foreground = queue();
    const history = queue();
    const service = scheduler(foreground.binding, history.binding);
    await service.ensureForegroundCoverage(
      [{ id: "daily-attempt-reset", latestCompletedDate: "2026-07-09" }],
      false,
    );
    await env.DB.prepare(
      `UPDATE sync_intents SET status = 'waiting', attempt_count = 4,
              last_error_code = 'invalid_price', next_attempt_at = ?1
        WHERE instrument_id = 'daily-attempt-reset'`,
    )
      .bind("2026-07-12T00:00:00.000Z")
      .run();

    await service.ensureForegroundCoverage(
      [{ id: "daily-attempt-reset", latestCompletedDate: "2026-07-10" }],
      false,
    );
    expect(
      await env.DB.prepare(
        `SELECT target_end_date AS targetEndDate, status,
                attempt_count AS attempts, last_error_code AS errorCode
           FROM sync_intents WHERE instrument_id = 'daily-attempt-reset'`,
      ).first(),
    ).toEqual({
      targetEndDate: "2026-07-10",
      status: "pending",
      attempts: 0,
      errorCode: null,
    });
  });

  it("preempts history, bounds lane depth, and rotates history instruments", async () => {
    const foreground = queue();
    const history = queue();
    for (let index = 0; index < 6; index += 1) {
      await insertInstrument(`history-${index}`);
      await env.DB.prepare(
        `INSERT INTO sync_intents
         (id, deterministic_key, instrument_id, dataset, priority_class,
          target_start_date, target_end_date, cursor_end_date, status,
          priority, attempt_count, max_attempts, created_at, updated_at)
         VALUES (?1, ?1, ?2, 'market', 'history', '2000-01-01',
                 '2026-07-10', '2026-07-10', 'pending', 10, 0, 5, ?3, ?3)`,
      )
        .bind(`intent-history-${index}`, `history-${index}`, now)
        .run();
    }
    await insertInstrument("current-first");
    const service = scheduler(foreground.binding, history.binding);
    await service.ensureForegroundCoverage(
      [{ id: "current-first", latestCompletedDate: "2026-07-10" }],
      false,
    );

    expect(await service.dispatch(20)).toEqual({ dispatched: 5, waiting: 0 });
    expect(foreground.sent).toHaveLength(1);
    expect(history.sent).toHaveLength(4);
    const ranges = await env.DB.prepare(
      `SELECT requested_start_date AS startDate,
              requested_end_date AS endDate
         FROM sync_slices slice JOIN sync_intents intent ON intent.id = slice.intent_id
        WHERE intent.priority_class = 'history'`,
    ).all<{ startDate: string; endDate: string }>();
    expect(ranges.results).toHaveLength(4);
    expect(
      ranges.results.every((range) => range.endDate === "2026-07-10"),
    ).toBe(true);
  });

  it("services completed-slice analyses before extending the same history frontier", async () => {
    await insertInstrument("history-downstream");
    const foreground = queue();
    const history = queue();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sync_intents
         (id, deterministic_key, instrument_id, dataset, priority_class,
          target_start_date, target_end_date, cursor_end_date, status,
          priority, attempt_count, max_attempts, last_served_at,
          created_at, updated_at)
         VALUES ('history-market', 'history-market', 'history-downstream',
                 'market', 'history', '2020-01-01', '2026-07-10',
                 '2026-04-11', 'pending', 10, 1, 5, ?1, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO sync_intents
         (id, deterministic_key, instrument_id, dataset, priority_class,
          target_start_date, target_end_date, cursor_end_date, status,
          priority, attempt_count, max_attempts, created_at, updated_at)
         VALUES ('history-analysis', 'history-analysis', 'history-downstream',
                 'analysis', 'history', '2026-06-01', '2026-06-01',
                 '2026-06-01', 'pending', 10, 0, 3, ?1, ?1)`,
      ).bind(now),
    ]);

    expect(
      await scheduler(foreground.binding, history.binding).dispatch(1),
    ).toEqual({ dispatched: 1, waiting: 0 });
    expect(
      await env.DB.prepare(
        `SELECT intent.dataset FROM sync_slices slice
          JOIN sync_intents intent ON intent.id = slice.intent_id`,
      ).first(),
    ).toEqual({ dataset: "analysis" });
  });

  it("represents a 46,637-date job with one compact intent and bounded slices", async () => {
    await insertInstrument("fixture-instrument");
    await new PipelineJobRepository(env.DB)
      .createStatement({
        id: "fixture-job",
        triggerType: "backfill",
        requestedStartDate: "1898-11-01",
        requestedEndDate: "2026-07-10",
        affectedInstrumentsJson: '["fixture-instrument"]',
        eligibilityIntervalsJson:
          '[{"instrumentId":"fixture-instrument","startDate":"1898-11-01","endDate":"2026-07-10"}]',
        priority: 10,
        status: "pending",
        syncLane: "history",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const foreground = queue();
    const history = queue();
    const service = scheduler(foreground.binding, history.binding);

    expect(await service.createForPipelineJob("fixture-job")).toBe(1);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS intents,
                MIN(target_start_date) AS startDate,
                MAX(target_end_date) AS endDate FROM sync_intents`,
      ).first(),
    ).toEqual({
      intents: 1,
      startDate: "1898-11-01",
      endDate: "2026-07-10",
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS work FROM work_items").first(),
    ).toEqual({ work: 0 });

    await service.dispatch(16);
    expect(history.sent).toHaveLength(1);
    expect(
      await env.DB.prepare(
        `SELECT requested_start_date AS startDate,
                requested_end_date AS endDate FROM sync_slices`,
      ).first(),
    ).toEqual({ startDate: "2026-04-12", endDate: "2026-07-10" });
  });

  it("settles a leased slice once and advances compact coverage", async () => {
    await insertInstrument("processor-once");
    const foreground = queue();
    const history = queue();
    const service = scheduler(foreground.binding, history.binding);
    await service.ensureForegroundCoverage(
      [{ id: "processor-once", latestCompletedDate: "2026-07-10" }],
      false,
    );
    await service.dispatch(1);
    const message = foreground.sent[0];
    if (!message) throw new Error("slice was not queued");
    const processMarketFact = vi.fn(
      async (input: { work: readonly { id: string }[] }) =>
        input.work.map((work) => ({
          workItemId: work.id,
          kind: "complete" as const,
          resultRevision: "provider-r1",
        })),
    );
    const meter = new D1UsageMeter(env.DB);
    const processor = new SyncSliceProcessor({
      db: meter.db,
      now: () => new Date(now),
      actualUsage: () => meter.resourceUnits(),
      processor: { processMarketFact },
    });

    expect(await processor.process(message)).toBe("processed");
    expect(await processor.process(message)).toBe("stale");
    expect(processMarketFact).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        `SELECT status, attempt_count AS attempts FROM sync_intents
          WHERE instrument_id = 'processor-once'`,
      ).first(),
    ).toEqual({ status: "current", attempts: 1 });
    expect(
      await env.DB.prepare(
        `SELECT start_date AS startDate, end_date AS endDate
           FROM coverage_intervals WHERE instrument_id = 'processor-once'`,
      ).first(),
    ).toEqual({ startDate: "2026-07-10", endDate: "2026-07-10" });
    const budget = await env.DB.prepare(
      `SELECT reserved_units AS reserved, actual_units AS actual
         FROM resource_budget_days
        WHERE lane = 'foreground' AND resource_type = 'd1_rows_read'
          AND resource_key = ''`,
    ).first<{ reserved: number; actual: number }>();
    expect(budget?.actual).toBeGreaterThan(0);
    expect(budget?.reserved).toBe(budget?.actual);
    expect(budget?.reserved).toBeLessThan(10_000);
  });

  it("defers a provisional current bar until the next UTC day", async () => {
    await insertInstrument("provisional-current");
    const foreground = queue();
    const history = queue();
    const service = scheduler(foreground.binding, history.binding);
    await service.ensureForegroundCoverage(
      [{ id: "provisional-current", latestCompletedDate: "2026-07-10" }],
      false,
    );
    await service.dispatch(1);
    const message = foreground.sent[0];
    if (!message) throw new Error("slice was not queued");
    const processMarketFact = vi.fn(
      async (input: { work: readonly { id: string }[] }) =>
        input.work.map((work) => ({
          workItemId: work.id,
          kind: "retry" as const,
          errorCode: "invalid_price",
          errorMessage: "Daily bar has not settled.",
        })),
    );

    expect(
      await new SyncSliceProcessor({
        db: env.DB,
        now: () => new Date(now),
        processor: { processMarketFact },
      }).process(message),
    ).toBe("processed");
    expect(
      await env.DB.prepare(
        `SELECT status, next_attempt_at AS nextAttemptAt,
                attempt_count AS attempts, last_error_code AS errorCode
           FROM sync_intents WHERE instrument_id = 'provisional-current'`,
      ).first(),
    ).toEqual({
      status: "waiting",
      nextAttemptAt: "2026-07-12T00:00:00.000Z",
      attempts: 1,
      errorCode: "invalid_price",
    });
  });
});
