import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  type DispatchBatchRecord,
  DispatchBatchRepository,
} from "../../src/db/dispatch-batches";
import { WorkItemRepository } from "../../src/db/work-items";
import { YahooMarketDataProvider } from "../../src/providers/yahoo";
import {
  type WorkDispatcherDependencies,
  WorkDispatcherService,
} from "../../src/services/work-dispatcher";
import type { PipelineDispatchMessage } from "../../src/shared/contracts";
import { PipelineQueueConsumer } from "../../src/worker/pipeline-queue";
import { handleQueue } from "../../src/worker/queue";

const now = "2026-07-10T21:00:00.000Z";

const insertInstrument = async (id = "instrument-1"): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO instruments
     (id, symbol, company_name, exchange, currency, instrument_type,
      provider, provider_symbol, created_at, updated_at)
     VALUES (?1, ?2, 'Dispatcher Corp', 'NYSE', 'USD', 'stock',
             'yahoo', ?2, ?3, ?3)`,
  )
    .bind(id, `DISPATCH-${id}`, now)
    .run();
};

const dateAfter = (date: string, days: number): string => {
  const value = new Date(`${date}T12:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

const insertWork = async (input: {
  id: string;
  date: string;
  priority?: number;
  workType?: string;
  instrumentId?: string;
  maxAttempts?: number;
}): Promise<void> => {
  const instrumentId = input.instrumentId ?? "instrument-1";
  await new WorkItemRepository(env.DB).ensureGlobal({
    id: input.id,
    workType: input.workType ?? "market_fact",
    instrumentId,
    effectiveDate: input.date,
    dependencyRevision: "market-r1",
    forcedRefreshGeneration: null,
    deterministicKey: WorkItemRepository.globalFactKey({
      workType: input.workType ?? "market_fact",
      instrumentId,
      effectiveDate: input.date,
      dependencyRevision: "market-r1",
      forcedRefreshGeneration: null,
    }),
    priority: input.priority ?? 100,
    maxAttempts: input.maxAttempts ?? 3,
    availableAt: now,
    retentionUntil: null,
    createdAt: now,
    updatedAt: now,
  });
};

const fakeQueue = () => {
  const sent: PipelineDispatchMessage[] = [];
  const queue = {
    send: vi.fn(async (body: PipelineDispatchMessage) => {
      sent.push(body);
    }),
  } as unknown as Queue<PipelineDispatchMessage>;
  return { queue, sent };
};

const dispatcher = (
  dependencies: Omit<WorkDispatcherDependencies, "db" | "queue"> = {},
) => {
  const { queue, sent } = fakeQueue();
  return {
    queue,
    sent,
    service: new WorkDispatcherService({
      db: env.DB,
      queue,
      now: () => new Date(now),
      newId: (() => {
        let next = 0;
        return () => `batch-${++next}`;
      })(),
      ...dependencies,
    }),
  };
};

const message = (body: PipelineDispatchMessage) => ({
  body,
  ack: vi.fn(),
  retry: vi.fn(),
});

describe("normalized work dispatcher and queue consumer", () => {
  it("range-batches contiguous market work into at most 90 calendar days", async () => {
    await insertInstrument();
    for (let index = 0; index < 95; index += 1) {
      await insertWork({
        id: `range-${index}`,
        date: dateAfter("2026-01-01", index),
      });
    }
    const { service, sent } = dispatcher({ dailyCeiling: 200 });
    const result = await service.dispatch();
    expect(result.dispatchedWorkItems).toBe(95);
    expect(result.dispatchedBatches).toBe(2);
    expect(
      sent.every(
        (body) => JSON.stringify(Object.keys(body)) === '["dispatchBatchId"]',
      ),
    ).toBe(true);
    const ranges = await env.DB.prepare(
      `SELECT requested_start_date, requested_end_date
       FROM dispatch_batches ORDER BY requested_start_date`,
    ).all<{ requested_start_date: string; requested_end_date: string }>();
    expect(ranges.results).toHaveLength(2);
    expect(
      ranges.results.every(
        (range) =>
          Date.parse(`${range.requested_end_date}T12:00:00Z`) -
            Date.parse(`${range.requested_start_date}T12:00:00Z`) <=
          89 * 86_400_000,
      ),
    ).toBe(true);
  });

  it("respects priority fairness and the daily work ceiling", async () => {
    await insertInstrument();
    await insertWork({ id: "automatic", date: "2026-01-01", priority: 100 });
    await insertWork({ id: "backfill", date: "2026-01-02", priority: 200 });
    await insertWork({ id: "current", date: "2026-01-03", priority: 300 });
    const { service } = dispatcher({ dailyCeiling: 2 });
    const result = await service.dispatch();
    expect(result.dispatchedWorkItems).toBe(2);
    const rows = await env.DB.prepare(
      `SELECT effective_date, priority, state FROM work_items
       WHERE scope = 'global_fact' ORDER BY effective_date`,
    ).all<{ effective_date: string; priority: number; state: string }>();
    expect(rows.results).toEqual([
      { effective_date: "2026-01-01", priority: 100, state: "pending" },
      { effective_date: "2026-01-02", priority: 200, state: "queued" },
      { effective_date: "2026-01-03", priority: 300, state: "queued" },
    ]);
  });

  it("leaves a send failure in dispatching and retries it after lease recovery", async () => {
    await insertInstrument();
    await insertWork({ id: "send-failure", date: "2026-01-01" });
    const first = dispatcher();
    first.queue.send = vi.fn(async () => {
      throw new Error("queue_unavailable");
    });
    const failed = await first.service.dispatch();
    expect(failed.sendFailures).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT state FROM dispatch_batches WHERE id = 'batch-1'",
      ).first(),
    ).toEqual({ state: "dispatching" });

    const recoveredQueue = fakeQueue();
    const recovered = new WorkDispatcherService({
      db: env.DB,
      queue: recoveredQueue.queue,
      now: () => new Date("2026-07-10T21:06:00.000Z"),
      newId: () => "batch-retry",
    });
    const result = await recovered.dispatch();
    expect(result.recoveredDispatchBatches).toBe(1);
    expect(recoveredQueue.sent).toEqual([{ dispatchBatchId: "batch-1" }]);
    expect(
      await env.DB.prepare(
        "SELECT state FROM dispatch_batches WHERE id = 'batch-1'",
      ).first(),
    ).toEqual({ state: "queued" });
  });

  it("resends a queued D1 batch after a flag-off consumer acknowledgement", async () => {
    await insertInstrument();
    await insertWork({ id: "queued-flag-off", date: "2026-01-01" });
    const first = dispatcher();
    await first.service.dispatch();
    const messageBody = first.sent[0];
    if (!messageBody) throw new Error("dispatch_message_missing");
    const flagOffMessage = {
      body: messageBody,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await handleQueue({ messages: [flagOffMessage] } as never, env);
    expect(flagOffMessage.ack).toHaveBeenCalledOnce();
    const recoveredQueue = fakeQueue();
    const recovered = new WorkDispatcherService({
      db: env.DB,
      queue: recoveredQueue.queue,
      now: () => new Date("2026-07-10T21:15:00.000Z"),
      newId: () => "batch-recovery",
    });
    const result = await recovered.dispatch();
    expect(result.recoveredQueuedBatches).toBe(1);
    expect(recoveredQueue.sent).toEqual([messageBody]);
  });

  it("runs a normalized batch through the provider processor when writes are enabled", async () => {
    await insertInstrument();
    await insertWork({ id: "normalized-provider", date: "2026-07-10" });
    const first = dispatcher();
    await first.service.dispatch();
    const messageBody = first.sent[0];
    if (!messageBody) throw new Error("dispatch_message_missing");
    vi.spyOn(
      YahooMarketDataProvider.prototype,
      "getInstrument",
    ).mockResolvedValue({
      metadata: {
        symbol: "DISPATCH-instrument-1",
        companyName: "Dispatcher Corp",
        exchange: "NYSE",
        currency: "USD",
        instrumentType: "EQUITY",
      },
      bars: [
        { date: "2026-07-09", close: 100, adjustedClose: 100 },
        { date: "2026-07-10", close: 110, adjustedClose: 110 },
      ],
      corporateActionDates: new Set<string>(),
    });
    const enabledEnv = new Proxy(env, {
      get(target, property) {
        if (property === "PORTFOLIO_NEW_WRITES_ENABLED") return "true";
        return Reflect.get(target, property);
      },
    });
    const normalizedMessage = message(messageBody);
    await handleQueue({ messages: [normalizedMessage] } as never, enabledEnv);
    expect(normalizedMessage.ack).toHaveBeenCalledOnce();
    expect(normalizedMessage.retry).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        `SELECT batch.state, work.state AS work_state,
                fact.current_raw_close_decimal, fact.movement_percent_decimal
           FROM dispatch_batches batch
           JOIN dispatch_batch_items item ON item.dispatch_batch_id = batch.id
           JOIN work_items work ON work.id = item.work_item_id
           JOIN daily_market_facts fact
             ON fact.instrument_id = work.instrument_id
            AND fact.trading_date = work.effective_date
          WHERE batch.id = ?1`,
      )
        .bind(messageBody.dispatchBatchId)
        .first(),
    ).toEqual({
      state: "complete",
      work_state: "complete",
      current_raw_close_decimal: "110",
      movement_percent_decimal: "10",
    });
  });

  it("recovers an expired processing lease and redelivers the queued batch", async () => {
    await insertInstrument();
    await insertWork({ id: "processing-expired", date: "2026-01-01" });
    const first = dispatcher();
    await first.service.dispatch();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE dispatch_batches
         SET state = 'processing', dispatch_lease_until = NULL,
             processing_lease_until = '2026-07-10T20:00:00.000Z'
         WHERE id = 'batch-1'`,
      ),
      env.DB.prepare(
        `UPDATE work_items SET state = 'processing', dispatch_lease_until = NULL,
             processing_lease_until = '2026-07-10T20:00:00.000Z'
         WHERE id = 'processing-expired'`,
      ),
    ]);
    const recovered = dispatcher();
    const result = await recovered.service.dispatch();
    expect(result.recoveredProcessingBatches).toBe(1);
    expect(recovered.sent).toEqual([{ dispatchBatchId: "batch-1" }]);
    expect(
      await env.DB.prepare(
        `SELECT batch.state AS batch_state, work.state AS work_state
         FROM dispatch_batches batch
         JOIN dispatch_batch_items item ON item.dispatch_batch_id = batch.id
         JOIN work_items work ON work.id = item.work_item_id
         WHERE batch.id = 'batch-1'`,
      ).first(),
    ).toEqual({ batch_state: "queued", work_state: "queued" });
  });

  it("releases a failed recovery send back to dispatch recovery", async () => {
    await insertInstrument();
    await insertWork({ id: "recovery-send-failure", date: "2026-01-01" });
    const first = dispatcher();
    await first.service.dispatch();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE dispatch_batches
         SET state = 'processing', dispatch_lease_until = NULL,
             processing_lease_until = '2026-07-10T20:00:00.000Z'
         WHERE id = 'batch-1'`,
      ),
      env.DB.prepare(
        `UPDATE work_items SET state = 'processing', dispatch_lease_until = NULL,
         processing_lease_until = '2026-07-10T20:00:00.000Z'
         WHERE id = 'recovery-send-failure'`,
      ),
    ]);
    const recovered = dispatcher();
    recovered.queue.send = vi.fn(async () => {
      throw new Error("queue_unavailable");
    });
    const failed = await recovered.service.dispatch();
    expect(failed.sendFailures).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT state FROM dispatch_batches WHERE id = 'batch-1'",
      ).first(),
    ).toEqual({ state: "dispatching" });
  });

  it("claims, completes, and idempotently acknowledges duplicate delivery", async () => {
    await insertInstrument();
    await insertWork({ id: "consumer-work", date: "2026-01-01" });
    const { service, sent } = dispatcher();
    await service.dispatch();
    const firstMessage = message(sent[0] as PipelineDispatchMessage);
    const consumer = new PipelineQueueConsumer({
      db: env.DB,
      now: () => new Date(now),
    });
    await consumer.handle({ messages: [firstMessage] } as never);
    expect(firstMessage.ack).toHaveBeenCalledOnce();
    expect(firstMessage.retry).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT state FROM dispatch_batches WHERE id = 'batch-1'",
      ).first(),
    ).toEqual({ state: "complete" });
    const duplicate = message(sent[0] as PipelineDispatchMessage);
    await consumer.handle({ messages: [duplicate] } as never);
    expect(duplicate.ack).toHaveBeenCalledOnce();
  });

  it("retries partial provider ranges and terminalizes after an exhausted retry", async () => {
    await insertInstrument();
    await insertWork({ id: "partial-a", date: "2026-01-01" });
    await insertWork({ id: "partial-b", date: "2026-01-02" });
    const { service, sent } = dispatcher();
    await service.dispatch();
    const first = message(sent[0] as PipelineDispatchMessage);
    const processor = {
      process: vi.fn(async ({ work }: { work: readonly { id: string }[] }) => [
        { workItemId: work[0]?.id ?? "", kind: "complete" as const },
      ]),
    };
    const consumer = new PipelineQueueConsumer({
      db: env.DB,
      processor,
      now: () => new Date(now),
    });
    await consumer.handle({ messages: [first] } as never);
    expect(first.retry).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        "SELECT state FROM work_items WHERE id = 'partial-b'",
      ).first(),
    ).toEqual({ state: "queued" });

    await env.DB.prepare(
      "UPDATE dispatch_batches SET attempt_count = max_attempts WHERE id = 'batch-1'",
    ).run();
    const dlq = fakeQueue();
    const terminalMessage = message(sent[0] as PipelineDispatchMessage);
    const terminalConsumer = new PipelineQueueConsumer({
      db: env.DB,
      processor: {
        process: async () => {
          throw new Error("market_http_503");
        },
      },
      dlq: dlq.queue,
      now: () => new Date(now),
    });
    await terminalConsumer.handle({ messages: [terminalMessage] } as never);
    expect(terminalMessage.ack).toHaveBeenCalledOnce();
    expect(terminalMessage.retry).not.toHaveBeenCalled();
    expect(dlq.sent).toEqual([{ dispatchBatchId: "batch-1" }]);
    expect(
      await env.DB.prepare(
        "SELECT state, terminal_error_code FROM dispatch_batches WHERE id = 'batch-1'",
      ).first(),
    ).toEqual({
      state: "terminal",
      terminal_error_code: "pipeline_attempts_exhausted",
    });
  });

  it("does not let a stale dispatch acknowledgement overwrite consumer processing", async () => {
    await insertInstrument();
    await insertWork({ id: "race-work", date: "2026-01-01" });
    const consumer = new PipelineQueueConsumer({
      db: env.DB,
      now: () => new Date(now),
    });
    const sent: PipelineDispatchMessage[] = [];
    let dispatchLease: string | null = null;
    const queue = {
      send: vi.fn(async (body: PipelineDispatchMessage) => {
        sent.push(body);
        const before = await new DispatchBatchRepository(env.DB).findById(
          body.dispatchBatchId,
        );
        dispatchLease = before?.dispatchLeaseUntil ?? null;
        const consumerMessage = message(body);
        await consumer.handle({ messages: [consumerMessage] } as never);
        expect(consumerMessage.ack).toHaveBeenCalledOnce();
      }),
    } as unknown as Queue<PipelineDispatchMessage>;
    const service = new WorkDispatcherService({
      db: env.DB,
      queue,
      now: () => new Date(now),
      newId: () => "batch-1",
    });
    await service.dispatch();
    expect(sent).toEqual([{ dispatchBatchId: "batch-1" }]);
    if (!dispatchLease) throw new Error("dispatch_lease_missing");
    expect(
      await new DispatchBatchRepository(env.DB).transition({
        id: "batch-1",
        from: "dispatching",
        to: "queued",
        now,
        expectedDispatchLeaseUntil: dispatchLease,
      }),
    ).toBe(false);
  });

  it("reserves the daily ceiling across concurrent dispatchers", async () => {
    await insertInstrument();
    await insertWork({ id: "concurrent-a", date: "2026-01-01" });
    await insertWork({ id: "concurrent-b", date: "2026-01-02" });
    const first = dispatcher({
      dailyCeiling: 1,
      newId: () => "batch-concurrent-a",
    });
    const second = dispatcher({
      dailyCeiling: 1,
      newId: () => "batch-concurrent-b",
    });
    await Promise.all([first.service.dispatch(), second.service.dispatch()]);
    const reservation = await env.DB.prepare(
      `SELECT COALESCE(SUM(work_count), 0) AS count
       FROM dispatch_daily_reservations WHERE reservation_day = '2026-07-10'`,
    ).first<{ count: number }>();
    expect(reservation).toEqual({ count: 1 });
    const rows = await env.DB.prepare(
      `SELECT id, state FROM work_items ORDER BY id`,
    ).all<{ id: string; state: string }>();
    expect(rows.results).toEqual([
      { id: "concurrent-a", state: "queued" },
      { id: "concurrent-b", state: "pending" },
    ]);
  });

  it("coalesces sparse trading dates within the provider calendar span", async () => {
    await insertInstrument();
    await insertWork({ id: "sparse-1", date: "2026-01-02" });
    await insertWork({ id: "sparse-2", date: "2026-01-05" });
    await insertWork({ id: "sparse-3", date: "2026-01-07" });
    const { service } = dispatcher({ maxBatchCalendarDays: 6 });
    await service.dispatch();
    const range = await env.DB.prepare(
      `SELECT requested_start_date, requested_end_date
       FROM dispatch_batches WHERE id = 'batch-1'`,
    ).first();
    expect(range).toEqual({
      requested_start_date: "2026-01-02",
      requested_end_date: "2026-01-07",
    });
  });

  it("terminalizes exhausted queue sends and records durable DLQ delivery", async () => {
    await insertInstrument();
    await insertWork({ id: "send-exhausted", date: "2026-01-01" });
    const first = dispatcher({
      dispatchMaxAttempts: 1,
    });
    first.queue.send = vi.fn(async () => {
      throw new Error("queue_unavailable");
    });
    const dlq = fakeQueue();
    first.service = new WorkDispatcherService({
      db: env.DB,
      queue: first.queue,
      dlq: dlq.queue,
      dispatchMaxAttempts: 1,
      now: () => new Date(now),
      newId: () => "batch-1",
    });
    const result = await first.service.dispatch();
    expect(result.sendFailures).toBe(1);
    expect(dlq.sent).toEqual([{ dispatchBatchId: "batch-1" }]);
    expect(
      await env.DB.prepare(
        `SELECT batch.state, batch.dlq_state, work.state AS work_state
         FROM dispatch_batches batch
         JOIN dispatch_batch_items item ON item.dispatch_batch_id = batch.id
         JOIN work_items work ON work.id = item.work_item_id
         WHERE batch.id = 'batch-1'`,
      ).first(),
    ).toEqual({
      state: "terminal",
      dlq_state: "delivered",
      work_state: "terminal",
    });
  });

  it("retries a failed DLQ send from durable terminal state", async () => {
    await insertInstrument();
    await insertWork({ id: "dlq-retry", date: "2026-01-01" });
    const first = dispatcher({ dispatchMaxAttempts: 1 });
    first.queue.send = vi.fn(async () => {
      throw new Error("queue_unavailable");
    });
    const failedDlq = fakeQueue();
    failedDlq.queue.send = vi.fn(async () => {
      throw new Error("dlq_unavailable");
    });
    first.service = new WorkDispatcherService({
      db: env.DB,
      queue: first.queue,
      dlq: failedDlq.queue,
      dispatchMaxAttempts: 1,
      now: () => new Date(now),
      newId: () => "batch-1",
    });
    await first.service.dispatch();
    expect(
      await env.DB.prepare(
        "SELECT state, dlq_state FROM dispatch_batches WHERE id = 'batch-1'",
      ).first(),
    ).toEqual({ state: "terminal", dlq_state: "pending" });
    const recoveredDlq = fakeQueue();
    const recovered = new WorkDispatcherService({
      db: env.DB,
      queue: fakeQueue().queue,
      dlq: recoveredDlq.queue,
      now: () => new Date("2026-07-10T21:06:00.000Z"),
    });
    await recovered.dispatch();
    expect(recoveredDlq.sent).toEqual([{ dispatchBatchId: "batch-1" }]);
    expect(
      await env.DB.prepare(
        "SELECT dlq_state FROM dispatch_batches WHERE id = 'batch-1'",
      ).first(),
    ).toEqual({ dlq_state: "delivered" });
  });

  it("does not let a stale processing consumer acknowledge after lease loss", async () => {
    await insertInstrument();
    await insertWork({ id: "stale-processing", date: "2026-01-01" });
    const { service, sent } = dispatcher();
    await service.dispatch();
    const staleMessage = message(sent[0] as PipelineDispatchMessage);
    const consumer = new PipelineQueueConsumer({
      db: env.DB,
      now: () => new Date(now),
      processor: {
        process: async ({ work }) => {
          await env.DB.batch([
            env.DB.prepare(
              `UPDATE dispatch_batches
               SET processing_lease_until = '2026-07-10T22:00:00.000Z'
               WHERE id = 'batch-1'`,
            ),
            env.DB.prepare(
              `UPDATE work_items
               SET processing_lease_until = '2026-07-10T22:00:00.000Z'
               WHERE id = ?1`,
            ).bind(work[0]?.id),
          ]);
          return [
            {
              workItemId: work[0]?.id ?? "",
              kind: "complete" as const,
            },
          ];
        },
      },
    });
    await consumer.handle({ messages: [staleMessage] } as never);
    expect(staleMessage.ack).not.toHaveBeenCalled();
    expect(staleMessage.retry).toHaveBeenCalledOnce();
  });

  it("aggregates settled duplicate recovery and keeps per-item link outcomes", async () => {
    await insertInstrument();
    await env.DB.prepare(
      `INSERT INTO pipeline_jobs
       (id, trigger_type, affected_instruments_json, eligibility_intervals_json,
        priority, status, created_at, updated_at)
       VALUES ('job-settled', 'backfill', '[]', '[]', 1, 'running', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await insertWork({ id: "settled-complete", date: "2026-01-01" });
    await insertWork({ id: "settled-terminal", date: "2026-01-02" });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO job_work_items
         (pipeline_job_id, work_item_id, relationship, outcome, created_at)
         VALUES ('job-settled', 'settled-complete', 'required', 'pending', ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO job_work_items
         (pipeline_job_id, work_item_id, relationship, outcome, created_at)
         VALUES ('job-settled', 'settled-terminal', 'required', 'pending', ?1)`,
      ).bind(now),
    ]);
    const { service, sent } = dispatcher();
    await service.dispatch();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE dispatch_batches SET state = 'processing',
         dispatch_lease_until = NULL,
         processing_lease_until = '2026-07-10T20:00:00.000Z'
         WHERE id = 'batch-1'`,
      ),
      env.DB.prepare(
        `UPDATE work_items SET state = 'complete', processing_lease_until = NULL
         WHERE id = 'settled-complete'`,
      ),
      env.DB.prepare(
        `UPDATE work_items SET state = 'terminal', processing_lease_until = NULL,
         terminal_error_code = 'provider_failed', completed_at = ?1
         WHERE id = 'settled-terminal'`,
      ).bind(now),
    ]);
    const recoveredMessage = message(sent[0] as PipelineDispatchMessage);
    const consumer = new PipelineQueueConsumer({
      db: env.DB,
      now: () => new Date("2026-07-10T21:00:00.000Z"),
      dlq: fakeQueue().queue,
    });
    await consumer.handle({ messages: [recoveredMessage] } as never);
    expect(recoveredMessage.ack).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        "SELECT state FROM dispatch_batches WHERE id = 'batch-1'",
      ).first(),
    ).toEqual({ state: "terminal" });
    const links = await env.DB.prepare(
      `SELECT work_item_id, outcome FROM job_work_items
       WHERE pipeline_job_id = 'job-settled' ORDER BY work_item_id`,
    ).all<{ work_item_id: string; outcome: string }>();
    expect(links.results).toEqual([
      { work_item_id: "settled-complete", outcome: "processed" },
      { work_item_id: "settled-terminal", outcome: "failed" },
    ]);
  });

  it("keeps successful siblings processed when another child exhausts retries", async () => {
    await insertInstrument();
    await env.DB.prepare(
      `INSERT INTO pipeline_jobs
       (id, trigger_type, affected_instruments_json, eligibility_intervals_json,
        priority, status, created_at, updated_at)
       VALUES ('job-mixed', 'backfill', '[]', '[]', 1, 'running', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await insertWork({ id: "mixed-complete", date: "2026-01-01" });
    await insertWork({ id: "mixed-terminal", date: "2026-01-02" });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO job_work_items
         (pipeline_job_id, work_item_id, relationship, outcome, created_at)
         VALUES ('job-mixed', 'mixed-complete', 'required', 'pending', ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO job_work_items
         (pipeline_job_id, work_item_id, relationship, outcome, created_at)
         VALUES ('job-mixed', 'mixed-terminal', 'required', 'pending', ?1)`,
      ).bind(now),
    ]);
    const { service, sent } = dispatcher();
    await service.dispatch();
    const first = message(sent[0] as PipelineDispatchMessage);
    const consumer = new PipelineQueueConsumer({
      db: env.DB,
      processor: {
        process: async ({ work }) => [
          {
            workItemId: work[0]?.id ?? "",
            kind: "complete" as const,
          },
          {
            workItemId: work[1]?.id ?? "",
            kind: "terminal" as const,
            errorCode: "provider_failed",
          },
        ],
      },
      now: () => new Date(now),
    });
    await consumer.handle({ messages: [first] } as never);
    expect(first.ack).toHaveBeenCalledOnce();
    const links = await env.DB.prepare(
      `SELECT work_item_id, outcome FROM job_work_items
       WHERE pipeline_job_id = 'job-mixed' ORDER BY work_item_id`,
    ).all<{ work_item_id: string; outcome: string }>();
    expect(links.results).toEqual([
      { work_item_id: "mixed-complete", outcome: "processed" },
      { work_item_id: "mixed-terminal", outcome: "failed" },
    ]);
  });

  it("terminalizes a delayed bar after the six-hour horizon while retaining D1 state", async () => {
    await insertInstrument();
    await insertWork({ id: "delayed-bar", date: "2026-01-01" });
    const { service, sent } = dispatcher();
    await service.dispatch();
    const delayed = message(sent[0] as PipelineDispatchMessage);
    const consumer = new PipelineQueueConsumer({
      db: env.DB,
      now: () => new Date("2026-07-11T03:00:01.000Z"),
      processor: {
        process: async ({ work }) => [
          {
            workItemId: work[0]?.id ?? "",
            kind: "retry" as const,
            errorCode: "market_bar_pending",
          },
        ],
      },
    });
    await env.DB.prepare(
      `UPDATE dispatch_batches
       SET state = 'processing', dispatch_lease_until = NULL,
           processing_lease_until = '2026-07-10T21:10:00.000Z'
       WHERE id = 'batch-1'`,
    ).run();
    await consumer.handle({ messages: [delayed] } as never);
    expect(delayed.ack).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        `SELECT work.state, work.terminal_error_code, batch.state AS batch_state
         FROM work_items work
         JOIN dispatch_batch_items item ON item.work_item_id = work.id
         JOIN dispatch_batches batch ON batch.id = item.dispatch_batch_id
         WHERE work.id = 'delayed-bar'`,
      ).first(),
    ).toEqual({
      state: "terminal",
      terminal_error_code: "delayed_bar_horizon_exhausted",
      batch_state: "terminal",
    });
  });

  it("resets the ordinary batch attempt ceiling while a delayed bar is still within its horizon", async () => {
    await insertInstrument();
    await insertWork({ id: "delayed-retry", date: "2026-01-01" });
    const { service, sent } = dispatcher();
    await service.dispatch();
    const delayed = message(sent[0] as PipelineDispatchMessage);
    const consumer = new PipelineQueueConsumer({
      db: env.DB,
      now: () => new Date("2026-07-10T21:30:00.000Z"),
      processor: {
        process: async ({ work }) => [
          {
            workItemId: work[0]?.id ?? "",
            kind: "retry" as const,
            errorCode: "market_bar_pending",
          },
        ],
      },
    });
    await consumer.handle({ messages: [delayed] } as never);
    expect(delayed.retry).toHaveBeenCalledOnce();
    expect(delayed.ack).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        `SELECT batch.state, batch.attempt_count,
                work.state AS work_state
           FROM dispatch_batches batch
           JOIN dispatch_batch_items item ON item.dispatch_batch_id = batch.id
           JOIN work_items work ON work.id = item.work_item_id
          WHERE batch.id = 'batch-1'`,
      ).first(),
    ).toEqual({
      state: "queued",
      attempt_count: 0,
      work_state: "queued",
    });
  });

  it("reconciles links before acknowledging a duplicate complete batch", async () => {
    await insertInstrument();
    await env.DB.prepare(
      `INSERT INTO pipeline_jobs
       (id, trigger_type, affected_instruments_json, eligibility_intervals_json,
        priority, status, created_at, updated_at)
       VALUES ('job-complete-reconcile', 'backfill', '[]', '[]', 1,
               'running', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await insertWork({ id: "complete-reconcile", date: "2026-01-01" });
    await env.DB.prepare(
      `INSERT INTO job_work_items
       (pipeline_job_id, work_item_id, relationship, outcome, created_at)
       VALUES ('job-complete-reconcile', 'complete-reconcile', 'required',
               'pending', ?1)`,
    )
      .bind(now)
      .run();
    const { service, sent } = dispatcher();
    await service.dispatch();
    const first = message(sent[0] as PipelineDispatchMessage);
    const consumer = new PipelineQueueConsumer({
      db: env.DB,
      now: () => new Date(now),
    });
    await consumer.handle({ messages: [first] } as never);
    await env.DB.prepare(
      `UPDATE job_work_items SET outcome = 'pending', updated_at = ?1
       WHERE pipeline_job_id = 'job-complete-reconcile'`,
    )
      .bind(now)
      .run();
    const duplicate = message(sent[0] as PipelineDispatchMessage);
    await consumer.handle({ messages: [duplicate] } as never);
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        `SELECT outcome FROM job_work_items
         WHERE pipeline_job_id = 'job-complete-reconcile'`,
      ).first(),
    ).toEqual({ outcome: "processed" });
  });

  it("reconciles terminal links even after DLQ delivery already completed", async () => {
    await insertInstrument();
    await env.DB.prepare(
      `INSERT INTO pipeline_jobs
       (id, trigger_type, affected_instruments_json, eligibility_intervals_json,
        priority, status, created_at, updated_at)
       VALUES ('job-terminal-reconcile', 'backfill', '[]', '[]', 1,
               'running', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await insertWork({ id: "terminal-reconcile", date: "2026-01-01" });
    await env.DB.prepare(
      `INSERT INTO job_work_items
       (pipeline_job_id, work_item_id, relationship, outcome, created_at)
       VALUES ('job-terminal-reconcile', 'terminal-reconcile', 'required',
               'pending', ?1)`,
    )
      .bind(now)
      .run();
    const { service, sent } = dispatcher();
    await service.dispatch();
    const dlq = fakeQueue();
    const consumer = new PipelineQueueConsumer({
      db: env.DB,
      dlq: dlq.queue,
      now: () => new Date(now),
      processor: {
        process: async ({ work }) => [
          {
            workItemId: work[0]?.id ?? "",
            kind: "terminal" as const,
            errorCode: "provider_failed",
          },
        ],
      },
    });
    const first = message(sent[0] as PipelineDispatchMessage);
    await consumer.handle({ messages: [first] } as never);
    await env.DB.prepare(
      `UPDATE job_work_items SET outcome = 'pending', updated_at = ?1
       WHERE pipeline_job_id = 'job-terminal-reconcile'`,
    )
      .bind(now)
      .run();
    const duplicate = message(sent[0] as PipelineDispatchMessage);
    await consumer.handle({ messages: [duplicate] } as never);
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        `SELECT outcome FROM job_work_items
         WHERE pipeline_job_id = 'job-terminal-reconcile'`,
      ).first(),
    ).toEqual({ outcome: "failed" });
    expect(dlq.sent).toHaveLength(1);
  });

  it("terminalizes max-attempt orphan dispatch claims", async () => {
    await insertInstrument();
    await insertWork({
      id: "orphan-max-attempt",
      date: "2026-01-01",
      maxAttempts: 1,
    });
    await env.DB.prepare(
      `UPDATE work_items
       SET state = 'dispatching', attempt_count = max_attempts,
           dispatch_lease_until = '2026-07-10T20:00:00.000Z'
       WHERE id = 'orphan-max-attempt'`,
    ).run();
    const { service } = dispatcher();
    await service.dispatch();
    expect(
      await env.DB.prepare(
        `SELECT state, terminal_error_code FROM work_items
         WHERE id = 'orphan-max-attempt'`,
      ).first(),
    ).toEqual({
      state: "terminal",
      terminal_error_code: "dispatch_attempts_exhausted",
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM dispatch_batch_items WHERE work_item_id = 'orphan-max-attempt'",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("fences an expired daily reservation before creating a batch", async () => {
    await insertInstrument();
    await insertWork({ id: "reservation-fenced", date: "2026-01-01" });
    const batches = new DispatchBatchRepository(env.DB);
    await batches.reserveDailyCapacity({
      dispatchBatchId: "batch-fenced",
      reservationDay: "2026-07-10",
      workCount: 1,
      dailyCeiling: 1,
      createdAt: now,
      expiresAt: "2026-07-10T20:00:00.000Z",
    });
    await batches.recoverExpiredDailyReservations(now);
    const work = await new WorkItemRepository(env.DB).findById(
      "reservation-fenced",
    );
    if (!work) throw new Error("work_missing");
    const batch: DispatchBatchRecord = {
      id: "batch-fenced",
      workType: "market_fact",
      instrumentId: "instrument-1",
      requestedStartDate: "2026-01-01",
      requestedEndDate: "2026-01-01",
      state: "dispatching",
      dispatchLeaseUntil: "2026-07-10T21:05:00.000Z",
      processingLeaseUntil: null,
      attemptCount: 0,
      maxAttempts: 3,
      dispatchAttemptCount: 0,
      dispatchMaxAttempts: 3,
      dlqState: "none",
      dlqAttemptCount: 0,
      dlqLeaseUntil: null,
      dlqLastError: null,
      dlqDeliveredAt: null,
      terminalErrorCode: null,
      terminalErrorMessage: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      retentionUntil: null,
    };
    await expect(
      batches.createClaimedForWork({ batch, work: [work] }),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT state FROM work_items WHERE id = 'reservation-fenced'",
      ).first(),
    ).toEqual({ state: "pending" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM dispatch_batches WHERE id = 'batch-fenced'",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("recovers terminal batches whose work was unsettled at the crash point", async () => {
    await insertInstrument();
    await env.DB.prepare(
      `INSERT INTO pipeline_jobs
       (id, trigger_type, affected_instruments_json, eligibility_intervals_json,
        priority, status, created_at, updated_at)
       VALUES ('job-terminal-gap', 'backfill', '[]', '[]', 1,
               'running', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await insertWork({ id: "terminal-gap", date: "2026-01-01" });
    await env.DB.prepare(
      `INSERT INTO job_work_items
       (pipeline_job_id, work_item_id, relationship, outcome, created_at)
       VALUES ('job-terminal-gap', 'terminal-gap', 'required', 'pending', ?1)`,
    )
      .bind(now)
      .run();
    const { service } = dispatcher();
    await service.dispatch();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE dispatch_batches
         SET state = 'terminal', dispatch_lease_until = NULL,
             terminal_error_code = 'dispatch_attempts_exhausted',
             terminal_error_message = 'Queue dispatch attempt ceiling exhausted.',
             completed_at = ?1, updated_at = ?1
         WHERE id = 'batch-1'`,
      ).bind(now),
      env.DB.prepare(
        `UPDATE work_items SET state = 'queued', dispatch_lease_until = NULL,
         processing_lease_until = NULL WHERE id = 'terminal-gap'`,
      ),
    ]);
    await service.dispatch();
    expect(
      await env.DB.prepare(
        `SELECT state, terminal_error_code FROM work_items
         WHERE id = 'terminal-gap'`,
      ).first(),
    ).toEqual({
      state: "terminal",
      terminal_error_code: "dispatch_attempts_exhausted",
    });
    expect(
      await env.DB.prepare(
        `SELECT outcome FROM job_work_items
         WHERE pipeline_job_id = 'job-terminal-gap'`,
      ).first(),
    ).toEqual({ outcome: "failed" });
  });

  it("fences terminal item updates to the batch owner lease", async () => {
    await insertInstrument();
    await insertWork({ id: "terminal-race", date: "2026-01-01" });
    const { service } = dispatcher();
    await service.dispatch();
    const workItems = new WorkItemRepository(env.DB);
    const staleDispatchUpdate = await workItems.terminalizeBatchItems({
      dispatchBatchId: "batch-1",
      now,
      errorCode: "dispatch_attempts_exhausted",
      errorMessage: "stale",
      expectedDispatchLeaseUntil: "2026-07-10T21:05:00.000Z",
    });
    expect(staleDispatchUpdate).toBe(0);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE dispatch_batches SET state = 'processing',
         dispatch_lease_until = NULL,
         processing_lease_until = '2026-07-10T22:00:00.000Z'
         WHERE id = 'batch-1'`,
      ),
      env.DB.prepare(
        `UPDATE work_items SET state = 'processing',
         dispatch_lease_until = NULL,
         processing_lease_until = '2026-07-10T22:00:00.000Z'
         WHERE id = 'terminal-race'`,
      ),
    ]);
    const staleProcessingUpdate = await workItems.terminalizeBatchItems({
      dispatchBatchId: "batch-1",
      now,
      errorCode: "pipeline_attempts_exhausted",
      errorMessage: "stale",
      expectedLeaseUntil: "2026-07-10T21:10:00.000Z",
    });
    expect(staleProcessingUpdate).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT state FROM work_items WHERE id = 'terminal-race'",
      ).first(),
    ).toEqual({ state: "processing" });
  });
});
