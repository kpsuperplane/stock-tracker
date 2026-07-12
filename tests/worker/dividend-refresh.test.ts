import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { DividendProvider } from "../../src/providers/dividends";
import { ScheduledDividendRefreshService } from "../../src/services/dividend-refresh";

describe("ScheduledDividendRefreshService", () => {
  it("refreshes every instrument represented in the ledger", async () => {
    const now = "2026-07-12T12:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO instruments
         (id, symbol, company_name, exchange, currency, instrument_type,
          provider, provider_symbol, created_at, updated_at)
         VALUES ('div-refresh-aapl', 'DIVREFRESH', 'Dividend Refresh Inc.',
                 'NMS', 'USD', 'stock', 'yahoo', 'AAPL', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
          revision, created_at, updated_at)
         VALUES ('div-refresh-buy', 'div-refresh-aapl', '2026-01-15', 'buy',
                 '10', '200', 1, ?1, ?1)`,
      ).bind(now),
    ]);
    const getDividends = vi.fn<DividendProvider["getDividends"]>(
      async (symbol, startDate, endDate) => ({
        symbol,
        range: {
          requestedStartDate: startDate,
          requestedEndDate: endDate,
          coverageStartDate: null,
          coverageEndDate: null,
          isComplete: false,
          basis: "source-reported",
          provider: "test-dividends",
          observedAt: now,
          providerRevision: "test-r1",
        },
        events: [
          {
            type: "dividend",
            symbol,
            exDate: "2026-05-11",
            amount: "0.26",
            currency: "USD",
            provider: "test-dividends",
            providerEventId: "test-dividends:AAPL:2026-05-11",
            providerRevision: "test-r1",
            sourceUrl: "https://example.com/aapl-dividend",
          },
        ],
      }),
    );

    const summary = await new ScheduledDividendRefreshService({
      db: env.DB,
      provider: { getDividends },
      now: () => new Date(now),
      newId: () => "div-refresh-event",
    }).refreshHeldInstruments();

    expect(summary).toEqual({
      instruments: 1,
      refreshed: 1,
      events: 1,
      failed: 0,
    });
    expect(getDividends).toHaveBeenCalledWith(
      "AAPL",
      "2026-01-15",
      "2027-07-17",
    );
    expect(
      await env.DB.prepare(
        `SELECT ex_date, amount_per_share_decimal, source_url, status
           FROM dividend_events WHERE instrument_id = 'div-refresh-aapl'`,
      ).first(),
    ).toEqual({
      ex_date: "2026-05-11",
      amount_per_share_decimal: "0.26",
      source_url: "https://example.com/aapl-dividend",
      status: "active",
    });
  });
});
