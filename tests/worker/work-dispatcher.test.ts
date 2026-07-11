import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { DispatchBatchRepository } from "../../src/db/dispatch-batches";
import { WorkItemRepository } from "../../src/db/work-items";
import {
  type WorkDispatcherDependencies,
  WorkDispatcherService,
} from "../../src/services/work-dispatcher";
import type { PipelineDispatchMessage } from "../../src/shared/contracts";
import { PipelineQueueConsumer } from "../../src/worker/pipeline-queue";

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
});
