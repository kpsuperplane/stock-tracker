import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { CorporateActionProvider } from "../../src/providers/corporate-actions";
import { ScheduledSplitRefreshService } from "../../src/services/split-refresh";

describe("ScheduledSplitRefreshService", () => {
  it("retries unavailable split enrichment without changing transactions", async () => {
    const now = "2026-07-13T12:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO instruments
         (id, symbol, company_name, exchange, currency, instrument_type,
          provider, provider_symbol, created_at, updated_at)
         VALUES ('split-refresh-case', 'CASE', 'Case Corp', 'NYSE', 'USD',
                 'stock', 'yahoo', 'CASE', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
          revision, created_at, updated_at)
         VALUES ('split-refresh-buy', 'split-refresh-case', '2024-01-02',
                 'buy', '10', '20', 1, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO corporate_action_coverage
         (instrument_id, provider, requested_start_date, requested_end_date,
          status, error_code, error_message, updated_at)
         VALUES ('split-refresh-case', 'yahoo-chart-v8', '2024-01-02',
                 '2026-07-13', 'unavailable', 'provider_http_429',
                 'retry pending', ?1)`,
      ).bind(now),
    ]);
    const getSplits = vi.fn<CorporateActionProvider["getSplits"]>(
      async (symbol, startDate, endDate) => ({
        symbol,
        range: {
          requestedStartDate: startDate,
          requestedEndDate: endDate,
          coverageStartDate: null,
          coverageEndDate: null,
          isComplete: false,
          basis: "unverified",
          provider: "yahoo-chart-v8",
          observedAt: now,
          providerRevision: "snapshot-r1",
        },
        events: [],
      }),
    );

    const summary = await new ScheduledSplitRefreshService({
      db: env.DB,
      provider: { getSplits },
      now: () => new Date(now),
    }).refreshPending();

    expect(summary).toEqual({
      attempted: 1,
      refreshed: 1,
      conflicts: 0,
      failed: 0,
    });
    expect(getSplits).toHaveBeenCalledWith("CASE", "2024-01-02", "2026-07-13");
    expect(
      await env.DB.prepare(
        `SELECT status, error_code, snapshot_provider_revision
           FROM corporate_action_coverage
          WHERE instrument_id = 'split-refresh-case'`,
      ).first(),
    ).toEqual({
      status: "confirmed",
      error_code: null,
      snapshot_provider_revision: "snapshot-r1",
    });
    expect(
      await env.DB.prepare(
        "SELECT quantity_decimal, price_decimal FROM transactions WHERE id = 'split-refresh-buy'",
      ).first(),
    ).toEqual({ quantity_decimal: "10", price_decimal: "20" });
  });
});
