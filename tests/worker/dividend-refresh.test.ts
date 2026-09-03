import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { DividendProvider } from "../../src/providers/dividends";
import { PrimaryFallbackDividendProvider } from "../../src/providers/fallback-dividends";
import {
  DividendRefreshConsumer,
  DividendRefreshDispatcher,
} from "../../src/services/dividend-queue";
import { ScheduledDividendRefreshService } from "../../src/services/dividend-refresh";
import { reconcileDividendCoverage } from "../../src/services/event-coverage";
import type { DividendRefreshMessage } from "../../src/shared/contracts";

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

describe("queued dividend refresh", () => {
  it("does not rewrite coverage timestamps when the requested range is unchanged", async () => {
    const first = "2026-07-15T12:00:00.000Z";
    const second = "2026-07-15T12:15:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO instruments
         (id, symbol, company_name, exchange, currency, instrument_type,
          security_type, provider, provider_symbol, created_at, updated_at)
         VALUES ('coverage-stable', 'CST', 'Coverage Stable', 'NMS', 'USD',
                 'stock', 'stock', 'yahoo', 'CST', ?1, ?1)`,
      ).bind(first),
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal,
          price_decimal, revision, created_at, updated_at)
         VALUES ('coverage-stable-buy', 'coverage-stable', '2026-01-01',
                 'buy', '1', '10', 1, ?1, ?1)`,
      ).bind(first),
    ]);
    await reconcileDividendCoverage(env.DB, first);
    await reconcileDividendCoverage(env.DB, second);
    expect(
      await env.DB.prepare(
        `SELECT updated_at FROM dividend_refresh_state
          WHERE instrument_id = 'coverage-stable'`,
      ).first(),
    ).toEqual({ updated_at: first });
  });

  it("queues 72 due instruments without consuming provider attempts and completes them through Yahoo", async () => {
    const now = "2026-07-15T12:00:00.000Z";
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 72; index += 1) {
      const instrumentId = `queued-dividend-${index}`;
      const symbol = `QD${index}`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO instruments
           (id, symbol, company_name, exchange, currency, instrument_type,
            security_type, provider, provider_symbol, created_at, updated_at)
           VALUES (?1, ?2, ?2, 'NMS', 'USD', 'stock', 'stock',
                   'yahoo', ?2, ?3, ?3)`,
        ).bind(instrumentId, symbol, now),
        env.DB.prepare(
          `INSERT INTO transactions
           (id, instrument_id, trade_date, side, quantity_decimal,
            price_decimal, revision, created_at, updated_at)
           VALUES (?1, ?2, '2026-01-01', 'buy', '1', '10', 1, ?3, ?3)`,
        ).bind(`queued-buy-${index}`, instrumentId, now),
      );
    }
    await env.DB.batch(statements);
    await reconcileDividendCoverage(env.DB, now);
    await env.DB.prepare(
      `UPDATE dividend_refresh_state
          SET status = 'current', next_attempt_at = '2026-07-14T12:00:00.000Z',
              completed_at = '2026-07-10T12:00:00.000Z'`,
    ).run();
    const messages: DividendRefreshMessage[] = [];
    let token = 0;
    const dispatcher = new DividendRefreshDispatcher({
      db: env.DB,
      queue: {
        sendBatch: vi.fn(async (batch) => {
          for (const message of batch) messages.push(message.body);
        }),
      } as unknown as Queue<DividendRefreshMessage>,
      now: () => new Date(now),
      newId: () => `dividend-token-${++token}`,
    });
    expect(await dispatcher.dispatch()).toMatchObject({
      due: 72,
      queued: 72,
      sendFailures: 0,
    });
    expect(
      await env.DB.prepare(
        `SELECT SUM(status = 'queued') AS queued,
                SUM(attempt_count) AS attempts
           FROM dividend_refresh_state`,
      ).first(),
    ).toEqual({ queued: 72, attempts: 0 });

    const yahoo = vi.fn<DividendProvider["getDividends"]>(
      async (symbol, startDate, endDate) => ({
        symbol,
        range: {
          requestedStartDate: startDate,
          requestedEndDate: endDate,
          coverageStartDate: null,
          coverageEndDate: null,
          isComplete: false,
          basis: "source-reported",
          provider: "yahoo-dividends",
          observedAt: now,
          providerRevision: `${symbol}:empty`,
        },
        events: [],
      }),
    );
    const alpha = vi.fn<DividendProvider["getDividends"]>();
    await Promise.all(
      messages.map((message) =>
        new DividendRefreshConsumer({
          db: env.DB,
          provider: new PrimaryFallbackDividendProvider(
            { getDividends: yahoo },
            { getDividends: alpha },
          ),
          now: () => new Date(now),
        }).process(message),
      ),
    );
    expect(yahoo).toHaveBeenCalledTimes(72);
    expect(alpha).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        `SELECT SUM(status = 'current') AS current,
                SUM(attempt_count) AS attempts
           FROM dividend_refresh_state`,
      ).first(),
    ).toEqual({ current: 72, attempts: 0 });
  });

  it("returns claimed work to retry when the queue batch send fails", async () => {
    const now = "2026-07-15T12:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO instruments
         (id, symbol, company_name, exchange, currency, instrument_type,
          security_type, provider, provider_symbol, created_at, updated_at)
         VALUES ('dividend-send-failure', 'DSF', 'Dividend Send Failure',
                 'NMS', 'USD', 'stock', 'stock', 'yahoo', 'DSF', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal,
          price_decimal, revision, created_at, updated_at)
         VALUES ('dividend-send-failure-buy', 'dividend-send-failure',
                 '2026-01-01', 'buy', '1', '10', 1, ?1, ?1)`,
      ).bind(now),
    ]);
    const summary = await new DividendRefreshDispatcher({
      db: env.DB,
      queue: {
        sendBatch: vi.fn(async () => {
          throw new Error("queue_unavailable");
        }),
      } as unknown as Queue<DividendRefreshMessage>,
      now: () => new Date(now),
      newId: () => "failed-dividend-token",
    }).dispatch();

    expect(summary).toMatchObject({ due: 1, queued: 0, sendFailures: 1 });
    expect(
      await env.DB.prepare(
        `SELECT status, attempt_count, dispatch_token, last_error_code
           FROM dividend_refresh_state
          WHERE instrument_id = 'dividend-send-failure'`,
      ).first(),
    ).toEqual({
      status: "retry",
      attempt_count: 0,
      dispatch_token: null,
      last_error_code: "queue_send_failed",
    });
  });

  it("falls back only for eligible Yahoo failures and blocks permanent symbol failures", async () => {
    const fallback = vi.fn<DividendProvider["getDividends"]>(
      async (symbol, startDate, endDate) => ({
        symbol,
        range: {
          requestedStartDate: startDate,
          requestedEndDate: endDate,
          coverageStartDate: null,
          coverageEndDate: null,
          isComplete: false,
          basis: "source-reported",
          provider: "alpha-vantage-dividends",
          observedAt: "2026-07-15T12:00:00.000Z",
          providerRevision: "fallback-empty",
        },
        events: [],
      }),
    );
    const eligible = new PrimaryFallbackDividendProvider(
      {
        getDividends: vi.fn(async () => {
          throw new Error("provider_http_503");
        }),
      },
      { getDividends: fallback },
    );
    await expect(
      eligible.getDividends("AAPL", "2026-01-01", "2026-12-31", "USD"),
    ).resolves.toMatchObject({
      range: { provider: "alpha-vantage-dividends" },
    });
    const permanentFallback = vi.fn<DividendProvider["getDividends"]>();
    const permanent = new PrimaryFallbackDividendProvider(
      {
        getDividends: vi.fn(async () => {
          throw new Error("provider_symbol_mismatch");
        }),
      },
      { getDividends: permanentFallback },
    );
    await expect(
      permanent.getDividends("BAD", "2026-01-01", "2026-12-31", "USD"),
    ).rejects.toThrow("provider_symbol_mismatch");
    expect(permanentFallback).not.toHaveBeenCalled();
  });
});
