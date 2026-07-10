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
});
