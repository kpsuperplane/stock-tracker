import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { PipelineJobRepository } from "../../src/db/pipeline-jobs";
import { SyncIntentScheduler } from "../../src/services/sync-intents";
import { SyncSliceProcessor } from "../../src/services/sync-slice-processor";
import {
  isReadModelRefreshMessage,
  isSyncSliceMessage,
  type SyncSliceMessage,
} from "../../src/shared/contracts";

const now = "2026-07-10T12:00:00.000Z";

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
    const processor = new SyncSliceProcessor({
      db: env.DB,
      now: () => new Date(now),
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
  });
});
