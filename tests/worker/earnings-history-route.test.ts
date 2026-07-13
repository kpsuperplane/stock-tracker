import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const headers = {
  Authorization: `Basic ${btoa("owner:password")}`,
  Host: "local",
  Origin: "http://local",
  "X-Stock-Tracker-Request": "1",
};

describe("earnings history maintenance route", () => {
  it("runs one bounded batch and persists retry state", async () => {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO instruments
         (id, symbol, company_name, exchange, currency, instrument_type,
          provider, provider_symbol, created_at, updated_at)
         VALUES ('manual-history', 'HIST', 'History Corp', 'NYSE', 'USD',
                 'stock', 'yahoo', 'HIST', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
          revision, created_at, updated_at)
         VALUES ('manual-history-buy', 'manual-history', '2026-01-02', 'buy',
                 '2', '100', 1, ?1, ?1)`,
      ).bind(now),
    ]);

    const response = await exports.default.fetch(
      new Request("http://local/api/earnings/history-backfill", {
        method: "POST",
        headers,
      }),
    );

    expect(response.status).toBe(200);
    expect(
      await response.json<{
        summary: { instruments: number; attempted: number; retried: number };
      }>(),
    ).toEqual({
      summary: expect.objectContaining({
        instruments: 1,
        attempted: 1,
        retried: 1,
      }),
    });
    expect(
      await env.DB.prepare(
        `SELECT status, attempt_count, last_error_code
           FROM earnings_history_coverage
          WHERE instrument_id = 'manual-history'`,
      ).first(),
    ).toEqual({
      status: "retry",
      attempt_count: 1,
      last_error_code: "provider_sec_unavailable",
    });
  });
});
