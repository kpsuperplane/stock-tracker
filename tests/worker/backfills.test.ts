import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TickerRepository } from "../../src/db/tickers";

const headers = {
  Authorization: `Basic ${btoa("owner:password")}`,
  "Content-Type": "application/json",
};

describe("backfill routes", () => {
  it("snapshots two tickers across seven weekdays and reports progress", async () => {
    const tickers = new TickerRepository(env.DB);
    const now = "2026-07-09T22:00:00.000Z";
    await tickers.insert({
      id: "aapl",
      symbol: "AAPL",
      companyName: "Apple Inc.",
      exchange: "NMS",
      currency: "USD",
      now,
    });
    await tickers.insert({
      id: "shop",
      symbol: "SHOP.TO",
      companyName: "Shopify Inc.",
      exchange: "TOR",
      currency: "CAD",
      now,
    });
    const response = await exports.default.fetch(
      new Request("http://local/api/backfills", {
        method: "POST",
        headers,
        body: JSON.stringify({
          startDate: "2026-06-30",
          endDate: "2026-07-08",
          reprocessExisting: false,
        }),
      }),
    );
    expect(response.status).toBe(202);
    const { id } = await response.json<{ id: string }>();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM backfill_jobs",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM report_runs WHERE origin = 'backfill'",
      ).first(),
    ).toEqual({ count: 7 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM screenings").first(),
    ).toEqual({ count: 14 });
    await tickers.softDelete("shop", new Date().toISOString());
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM screenings").first(),
    ).toEqual({ count: 14 });
    await env.DB.prepare(
      `UPDATE screenings SET status = 'failed', qualified = 1,
       current_price = 174.45, error_code = 'news_schema',
       error_message = 'News feed unavailable'
       WHERE id = (SELECT id FROM screenings ORDER BY target_date, symbol LIMIT 1)`,
    ).run();
    const status = await exports.default.fetch(
      new Request(`http://local/api/backfills/${id}`, { headers }),
    );
    expect(status.status).toBe(200);
    const job = (
      await status.json<{
        job: {
          runs: unknown[];
          errors: Array<{ errorCode: string; retryable: boolean }>;
        };
      }>()
    ).job;
    expect(job.runs).toHaveLength(7);
    expect(job.errors).toEqual([
      expect.objectContaining({ errorCode: "news_schema", retryable: true }),
    ]);
  });

  it("rejects 31 inclusive calendar days", async () => {
    const response = await exports.default.fetch(
      new Request("http://local/api/backfills", {
        method: "POST",
        headers,
        body: JSON.stringify({
          startDate: "2026-06-01",
          endDate: "2026-07-01",
          reprocessExisting: false,
        }),
      }),
    );
    expect(response.status).toBe(422);
    expect(
      (await response.json<{ error: { code: string } }>()).error.code,
    ).toBe("backfill_range");
  });

  it("plans a normalized backfill when the opt-in pipeline flag is enabled", async () => {
    const flags = env as unknown as { BACKFILL_PIPELINE_ENABLED?: string };
    flags.BACKFILL_PIPELINE_ENABLED = "true";
    try {
      const now = new Date().toISOString();
      const tickers = new TickerRepository(env.DB);
      await tickers.insert({
        id: "pipeline-ticker",
        symbol: "PIPE",
        companyName: "Pipeline Corp",
        exchange: "NMS",
        currency: "USD",
        now,
      });
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO instruments
             (id, symbol, company_name, exchange, currency, instrument_type,
              provider, provider_symbol, created_at, updated_at)
             VALUES ('pipeline-instrument', 'PIPE', 'Pipeline Corp', 'NMS',
                     'USD', 'stock', 'test', 'PIPE', ?1, ?1)`,
        ).bind(now),
        env.DB.prepare(
          `INSERT INTO transactions
             (id, instrument_id, trade_date, side, quantity_decimal,
              price_decimal, revision, created_at, updated_at)
             VALUES ('pipeline-buy', 'pipeline-instrument', '2026-07-01',
                     'buy', '2', '100', 1, ?1, ?1)`,
        ).bind(now),
      ]);
      const response = await exports.default.fetch(
        new Request("http://local/api/backfills", {
          method: "POST",
          headers,
          body: JSON.stringify({
            startDate: "2026-07-01",
            endDate: "2026-07-09",
            reprocessExisting: false,
          }),
        }),
      );
      expect(response.status).toBe(202);
      const { id } = await response.json<{ id: string }>();
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM pipeline_jobs",
        ).first(),
      ).toEqual({ count: 1 });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM work_items WHERE scope = 'global_fact'",
        ).first(),
      ).toEqual({ count: 6 });
      const status = await exports.default.fetch(
        new Request(`http://local/api/backfills/${id}`, { headers }),
      );
      expect(status.status).toBe(200);
      const job = (await status.json<{ job: Record<string, unknown> }>()).job;
      expect(job.pipelineJob).toEqual(
        expect.objectContaining({ id, status: "running" }),
      );
      expect(job.ticker_jobs_total).toBe(6);

      const sharedResponse = await exports.default.fetch(
        new Request("http://local/api/backfills", {
          method: "POST",
          headers,
          body: JSON.stringify({
            startDate: "2026-07-01",
            endDate: "2026-07-09",
            reprocessExisting: false,
          }),
        }),
      );
      expect(sharedResponse.status).toBe(202);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM work_items WHERE scope = 'global_fact'",
        ).first(),
      ).toEqual({ count: 6 });
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM job_work_items
             WHERE work_item_id IN (SELECT id FROM work_items WHERE scope = 'global_fact')`,
        ).first(),
      ).toEqual({ count: 12 });

      const reprocessResponse = await exports.default.fetch(
        new Request("http://local/api/backfills", {
          method: "POST",
          headers,
          body: JSON.stringify({
            startDate: "2026-07-01",
            endDate: "2026-07-09",
            reprocessExisting: true,
          }),
        }),
      );
      expect(reprocessResponse.status).toBe(202);
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM work_items
             WHERE scope = 'global_fact' AND forced_refresh_generation = 1`,
        ).first(),
      ).toEqual({ count: 6 });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM movement_analyses",
        ).first(),
      ).toEqual({ count: 0 });

      const repeatedReprocess = await exports.default.fetch(
        new Request("http://local/api/backfills", {
          method: "POST",
          headers,
          body: JSON.stringify({
            startDate: "2026-07-01",
            endDate: "2026-07-09",
            reprocessExisting: true,
          }),
        }),
      );
      expect(repeatedReprocess.status).toBe(202);
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM work_items
             WHERE scope = 'global_fact' AND forced_refresh_generation = 2`,
        ).first(),
      ).toEqual({ count: 6 });
    } finally {
      delete flags.BACKFILL_PIPELINE_ENABLED;
    }
  });

  it("keeps partial pipeline failures running, exposes legacy errors, and retries one work item", async () => {
    const flags = env as unknown as { BACKFILL_PIPELINE_ENABLED?: string };
    flags.BACKFILL_PIPELINE_ENABLED = "true";
    try {
      const now = new Date().toISOString();
      const tickers = new TickerRepository(env.DB);
      await tickers.insert({
        id: "pipeline-ticker",
        symbol: "PIPE",
        companyName: "Pipeline Corp",
        exchange: "NMS",
        currency: "USD",
        now,
      });
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO instruments
             (id, symbol, company_name, exchange, currency, instrument_type,
              provider, provider_symbol, created_at, updated_at)
             VALUES ('pipeline-instrument', 'PIPE', 'Pipeline Corp', 'NMS',
                     'USD', 'stock', 'test', 'PIPE', ?1, ?1)`,
        ).bind(now),
        env.DB.prepare(
          `INSERT INTO transactions
             (id, instrument_id, trade_date, side, quantity_decimal,
              price_decimal, revision, created_at, updated_at)
             VALUES ('pipeline-buy', 'pipeline-instrument', '2026-06-30',
                     'buy', '2', '100', 1, ?1, ?1)`,
        ).bind(now),
      ]);
      const response = await exports.default.fetch(
        new Request("http://local/api/backfills", {
          method: "POST",
          headers,
          body: JSON.stringify({
            startDate: "2026-07-01",
            endDate: "2026-07-02",
            reprocessExisting: false,
          }),
        }),
      );
      const { id } = await response.json<{ id: string }>();
      const work = await env.DB.prepare(
        `SELECT id, effective_date FROM work_items
           WHERE scope = 'global_fact' ORDER BY effective_date`,
      ).all<{ id: string; effective_date: string }>();
      expect(work.results).toHaveLength(2);
      const [failed, pending] = work.results;
      if (!failed || !pending) throw new Error("pipeline work missing");
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE work_items
           SET state = 'terminal', terminal_error_code = 'provider_timeout',
               terminal_error_message = 'Provider timed out', completed_at = ?1,
               updated_at = ?1 WHERE id = ?2`,
        ).bind(now, failed.id),
        env.DB.prepare(
          `UPDATE job_work_items SET outcome = 'failed', updated_at = ?1
           WHERE pipeline_job_id = ?2 AND work_item_id = ?3`,
        ).bind(now, id, failed.id),
      ]);
      const partial = await exports.default.fetch(
        new Request(`http://local/api/backfills/${id}`, { headers }),
      );
      expect(partial.status).toBe(200);
      const partialJob = (
        await partial.json<{
          job: {
            status: string;
            pipeline: { status: string };
            errors: unknown[];
          };
        }>()
      ).job;
      expect(partialJob.status).toBe("running");
      expect(partialJob.pipeline.status).toBe("running");
      expect(partialJob.errors).toEqual([
        expect.objectContaining({
          screeningId: failed.id,
          symbol: "PIPE",
          tradingDate: failed.effective_date,
          errorCode: "provider_timeout",
          retryable: true,
        }),
      ]);

      const retry = await exports.default.fetch(
        new Request(`http://local/api/backfills/${id}/retry`, {
          method: "POST",
          headers,
          body: JSON.stringify({ workItemId: failed.id }),
        }),
      );
      expect(retry.status).toBe(202);
      expect(
        await env.DB.prepare("SELECT state FROM work_items WHERE id = ?1")
          .bind(failed.id)
          .first(),
      ).toEqual({ state: "pending" });

      await env.DB.batch([
        env.DB.prepare(
          `UPDATE work_items SET state = 'complete', terminal_error_code = NULL,
           terminal_error_message = NULL, completed_at = ?1, updated_at = ?1
           WHERE id = ?2`,
        ).bind(now, failed.id),
        env.DB.prepare(
          `UPDATE work_items SET state = 'terminal', terminal_error_code = 'provider_500',
           terminal_error_message = 'Provider failed', completed_at = ?1, updated_at = ?1
           WHERE id = ?2`,
        ).bind(now, pending.id),
        env.DB.prepare(
          `UPDATE job_work_items SET outcome = CASE WHEN work_item_id = ?2
             THEN 'processed' ELSE 'failed' END, updated_at = ?1
           WHERE pipeline_job_id = ?3 AND work_item_id IN (?2, ?4)`,
        ).bind(now, failed.id, id, pending.id),
      ]);
      const settled = await exports.default.fetch(
        new Request(`http://local/api/backfills/${id}`, { headers }),
      );
      const settledJob = (
        await settled.json<{
          job: { status: string; pipeline: { status: string } };
        }>()
      ).job;
      expect(settledJob.status).toBe("complete_with_errors");
      expect(settledJob.pipeline.status).toBe("complete_with_errors");
    } finally {
      delete flags.BACKFILL_PIPELINE_ENABLED;
    }
  });
});
