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
      attempted: 1,
      refreshed: 1,
      events: 1,
      failed: 0,
    });
    expect(getDividends).toHaveBeenCalledWith(
      "AAPL",
      "2026-01-15",
      "2027-07-17",
      "USD",
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

  it("prioritizes yesterday's failure while continuing the bounded rotation", async () => {
    const now = "2026-07-13T12:00:00.000Z";
    const statements: D1PreparedStatement[] = [];
    for (const symbol of ["AAA", "BBB", "CCC"]) {
      const id = `rotation-${symbol}`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO instruments
           (id, symbol, company_name, exchange, currency, instrument_type,
            provider, provider_symbol, created_at, updated_at)
           VALUES (?1, ?2, 'Rotation Corp', 'NYSE', 'USD', 'stock',
                   'yahoo', ?2, ?3, ?3)`,
        ).bind(id, symbol, now),
        env.DB.prepare(
          `INSERT INTO transactions
           (id, instrument_id, trade_date, side, quantity_decimal,
            price_decimal, revision, created_at, updated_at)
           VALUES (?1, ?2, '2026-01-01', 'buy', '1', '10', 1, ?3, ?3)`,
        ).bind(`rotation-buy-${symbol}`, id, now),
      );
    }
    await env.DB.batch(statements);
    let failA = true;
    const calls: string[] = [];
    const provider: DividendProvider = {
      getDividends: async (symbol, startDate, endDate) => {
        calls.push(symbol);
        if (symbol === "AAA" && failA) {
          throw new Error("provider_http_503");
        }
        return {
          symbol,
          range: {
            requestedStartDate: startDate,
            requestedEndDate: endDate,
            coverageStartDate: null,
            coverageEndDate: null,
            isComplete: false,
            basis: "source-reported",
            provider: "rotation-provider",
            observedAt: now,
            providerRevision: `${symbol}-r1`,
          },
          events: [],
        };
      },
    };
    const first = await new ScheduledDividendRefreshService({
      db: env.DB,
      provider,
      now: () => new Date(now),
      batchSize: 2,
    }).refreshHeldInstruments();
    expect(first).toMatchObject({ attempted: 2, refreshed: 1, failed: 1 });
    expect(calls).toEqual(["AAA", "BBB"]);

    failA = false;
    calls.length = 0;
    const nextDay = "2026-07-14T12:00:01.000Z";
    const second = await new ScheduledDividendRefreshService({
      db: env.DB,
      provider,
      now: () => new Date(nextDay),
      batchSize: 2,
    }).refreshHeldInstruments();
    expect(second).toMatchObject({ attempted: 2, refreshed: 2, failed: 0 });
    expect(calls).toEqual(["AAA", "CCC"]);
  });
});
