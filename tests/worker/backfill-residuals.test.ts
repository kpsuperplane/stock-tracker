import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { DispatchBatchRepository } from "../../src/db/dispatch-batches";
import { TickerRepository } from "../../src/db/tickers";
import { BackfillPipelineAdapter } from "../../src/services/backfill-pipeline";
import { WorkDispatcherService } from "../../src/services/work-dispatcher";
import type { PipelineDispatchMessage } from "../../src/shared/contracts";

const headers = {
  Authorization: `Basic ${btoa("owner:password")}`,
  "Content-Type": "application/json",
  Host: "local",
  Origin: "http://local",
  "X-Stock-Tracker-Request": "1",
};

const insertHolding = async (suffix: string, now: string): Promise<void> => {
  const tickers = new TickerRepository(env.DB);
  await tickers.insert({
    id: `${suffix}-ticker`,
    symbol: suffix,
    companyName: `${suffix} Corp`,
    exchange: "NMS",
    currency: "USD",
    now,
  });
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO instruments
           (id, symbol, company_name, exchange, currency, instrument_type,
            provider, provider_symbol, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'NMS', 'USD', 'stock', 'test', ?2, ?4, ?4)`,
    ).bind(`${suffix}-instrument`, suffix, `${suffix} Corp`, now),
    env.DB.prepare(
      `INSERT INTO transactions
           (id, instrument_id, trade_date, side, quantity_decimal,
            price_decimal, revision, created_at, updated_at)
           VALUES (?1, ?2, '2026-06-30', 'buy', '1', '100', 1, ?3, ?3)`,
    ).bind(`${suffix}-buy`, `${suffix}-instrument`, now),
  ]);
};

describe("backfill pipeline residual guards", () => {
  it("allocates distinct generations for concurrent no-work reprocesses", async () => {
    const adapter = new BackfillPipelineAdapter({
      db: env.DB,
      listActiveSymbols: async () => [],
    });
    const input = {
      startDate: "2026-07-01",
      endDate: "2026-07-01",
      reprocessExisting: true,
      now: "2026-07-10T21:00:00.000Z",
    };
    const ids = await Promise.all([adapter.start(input), adapter.start(input)]);
    const rows = await env.DB.prepare(
      `SELECT backfill_forced_refresh_generation AS generation
           FROM pipeline_jobs WHERE id IN (?1, ?2) ORDER BY generation`,
    )
      .bind(ids[0], ids[1])
      .all<{ generation: number }>();
    expect(rows.results.map((row) => row.generation)).toEqual([1, 2]);
    const status = await adapter.getStatus(ids[0]);
    expect(status).toEqual(
      expect.objectContaining({ forcedRefreshGeneration: 1 }),
    );
    expect(
      (status as { pipeline: { forcedRefreshGeneration: number } }).pipeline
        .forcedRefreshGeneration,
    ).toBe(1);

    await env.DB.prepare(
      "UPDATE pipeline_jobs SET status = 'planning' WHERE id = ?1",
    )
      .bind(ids[0])
      .run();
    await adapter.continuePlanning(ids[0], input.now);
    expect(
      await env.DB.prepare("SELECT status FROM pipeline_jobs WHERE id = ?1")
        .bind(ids[0])
        .first(),
    ).toEqual({ status: "complete" });
  });

  it("keeps GET status read-only and exposes pipeline status after flag removal", async () => {
    const flags = env as unknown as { BACKFILL_PIPELINE_ENABLED?: string };
    flags.BACKFILL_PIPELINE_ENABLED = "true";
    try {
      const now = new Date().toISOString();
      await insertHolding("READONLY", now);
      const created = await exports.default.fetch(
        new Request("http://local/api/backfills", {
          method: "POST",
          headers,
          body: JSON.stringify({
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            reprocessExisting: false,
          }),
        }),
      );
      const { id } = await created.json<{ id: string }>();
      const before = await env.DB.prepare(
        `SELECT updated_at, planner_cursor, planner_dividend_cursor
             FROM pipeline_jobs WHERE id = ?1`,
      )
        .bind(id)
        .first();
      const status = await exports.default.fetch(
        new Request(`http://local/api/backfills/${id}`, { headers }),
      );
      expect(status.status).toBe(200);
      const after = await env.DB.prepare(
        `SELECT updated_at, planner_cursor, planner_dividend_cursor
             FROM pipeline_jobs WHERE id = ?1`,
      )
        .bind(id)
        .first();
      expect(after).toEqual(before);

      delete flags.BACKFILL_PIPELINE_ENABLED;
      const afterToggle = await exports.default.fetch(
        new Request(`http://local/api/backfills/${id}`, { headers }),
      );
      expect(afterToggle.status).toBe(200);
    } finally {
      delete flags.BACKFILL_PIPELINE_ENABLED;
    }
  });

  it("detaches terminal dispatch links before allowing a targeted retry", async () => {
    const flags = env as unknown as { BACKFILL_PIPELINE_ENABLED?: string };
    flags.BACKFILL_PIPELINE_ENABLED = "true";
    try {
      const now = new Date().toISOString();
      await insertHolding("RETRY", now);
      const created = await exports.default.fetch(
        new Request("http://local/api/backfills", {
          method: "POST",
          headers,
          body: JSON.stringify({
            startDate: "2026-07-01",
            endDate: "2026-07-01",
            reprocessExisting: false,
          }),
        }),
      );
      const { id } = await created.json<{ id: string }>();
      const work = await env.DB.prepare(
        `SELECT id, instrument_id, effective_date, updated_at
             FROM work_items WHERE scope = 'global_fact' LIMIT 1`,
      ).first<{
        id: string;
        instrument_id: string;
        effective_date: string;
        updated_at: string;
      }>();
      if (!work) throw new Error("retry_work_missing");

      const sent: PipelineDispatchMessage[] = [];
      const queue = {
        send: vi.fn(async (message: PipelineDispatchMessage) => {
          sent.push(message);
        }),
      } as unknown as Queue<PipelineDispatchMessage>;
      await new WorkDispatcherService({
        db: env.DB,
        queue,
        now: () => new Date(),
        newId: () => "retry-batch",
      }).dispatch({ maxWorkItems: 1 });
      expect(sent).toHaveLength(1);
      const batch = await env.DB.prepare(
        "SELECT id FROM dispatch_batches LIMIT 1",
      ).first<{ id: string }>();
      if (!batch) throw new Error("retry_batch_missing");
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE dispatch_batches
                SET state = 'terminal', dispatch_lease_until = NULL,
                    processing_lease_until = NULL,
                    terminal_error_code = 'dispatch_attempts_exhausted',
                    terminal_error_message = 'dispatch failed',
                    completed_at = ?1, updated_at = ?1
              WHERE id = ?2`,
        ).bind(now, batch.id),
        env.DB.prepare(
          `UPDATE work_items
                SET state = 'terminal', terminal_error_code = 'provider_timeout',
                    terminal_error_message = 'provider timed out',
                    completed_at = ?1, updated_at = ?1
              WHERE id = ?2`,
        ).bind(now, work.id),
        env.DB.prepare(
          `UPDATE job_work_items SET outcome = 'failed', updated_at = ?1
              WHERE pipeline_job_id = ?2 AND work_item_id = ?3`,
        ).bind(now, id, work.id),
      ]);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM dispatch_batch_items WHERE work_item_id = ?1",
        )
          .bind(work.id)
          .first(),
      ).toEqual({ count: 1 });

      const retry = await exports.default.fetch(
        new Request(`http://local/api/backfills/${id}/retry`, {
          method: "POST",
          headers,
          body: JSON.stringify({ workItemId: work.id }),
        }),
      );
      expect(retry.status).toBe(202);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM dispatch_batch_items WHERE work_item_id = ?1",
        )
          .bind(work.id)
          .first(),
      ).toEqual({ count: 0 });

      const remaining = await new DispatchBatchRepository(env.DB).findById(
        batch.id,
      );
      expect(remaining?.state).toBe("terminal");
      expect(
        await env.DB.prepare("SELECT state FROM work_items WHERE id = ?1")
          .bind(work.id)
          .first(),
      ).toEqual({ state: "pending" });

      // A concurrent link mutation must prevent a second reset from being
      // reported as queued and must leave the terminal work untouched.
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE work_items
                SET state = 'terminal', terminal_error_code = 'provider_timeout',
                    terminal_error_message = 'provider timed out',
                    completed_at = ?1, updated_at = ?1
              WHERE id = ?2`,
        ).bind(`${now}-retry`, work.id),
        env.DB.prepare(
          `UPDATE job_work_items SET outcome = 'processed', updated_at = ?1
              WHERE pipeline_job_id = ?2 AND work_item_id = ?3`,
        ).bind(`${now}-retry`, id, work.id),
      ]);
      const revisionsBefore = await env.DB.prepare(
        "SELECT bucket_key, revision FROM fact_revision_buckets ORDER BY bucket_key",
      ).all();
      const blocked = await exports.default.fetch(
        new Request(`http://local/api/backfills/${id}/retry`, {
          method: "POST",
          headers,
          body: JSON.stringify({ workItemId: work.id }),
        }),
      );
      expect(blocked.status).toBe(409);
      expect(
        await env.DB.prepare("SELECT state FROM work_items WHERE id = ?1")
          .bind(work.id)
          .first(),
      ).toEqual({ state: "terminal" });
      expect(
        await env.DB.prepare(
          "SELECT bucket_key, revision FROM fact_revision_buckets ORDER BY bucket_key",
        ).all(),
      ).toEqual(revisionsBefore);

      // A failed per-job link remains an error even if another job later
      // completes the shared global work item.
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE work_items
                SET state = 'complete', terminal_error_code = NULL,
                    terminal_error_message = NULL, completed_at = ?1,
                    updated_at = ?1
              WHERE id = ?2`,
        ).bind(`${now}-shared`, work.id),
        env.DB.prepare(
          `UPDATE job_work_items SET outcome = 'failed', updated_at = ?1
              WHERE pipeline_job_id = ?2 AND work_item_id = ?3`,
        ).bind(`${now}-shared`, id, work.id),
      ]);
      const sharedStatus = await exports.default.fetch(
        new Request(`http://local/api/backfills/${id}`, { headers }),
      );
      const sharedJob = (
        await sharedStatus.json<{
          job: {
            status: string;
            runs: Array<{ status: string }>;
            errors: Array<{ errorCode: string }>;
          };
        }>()
      ).job;
      expect(sharedJob.status).toBe("complete_with_errors");
      expect(sharedJob.runs[0]?.status).toBe("complete_with_errors");
      expect(sharedJob.errors).toEqual([
        expect.objectContaining({ errorCode: "shared_work_failed" }),
      ]);
    } finally {
      delete flags.BACKFILL_PIPELINE_ENABLED;
    }
  });
});
