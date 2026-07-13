import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type {
  EarningsHistoryProvider,
  EarningsHistoryRange,
} from "../../src/providers/earnings";
import { EarningsHistoryBackfillService } from "../../src/services/earnings-history-backfill";

const firstRun = "2026-07-13T12:00:00.000Z";

const seed = async (suffix = "ibm"): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO instruments
       (id, symbol, company_name, exchange, currency, instrument_type,
        provider, provider_symbol, created_at, updated_at)
       VALUES (?1, ?2, 'History Corp', 'NYSE', 'USD', 'stock',
               'yahoo', ?2, ?3, ?3)`,
    ).bind(`history-${suffix}`, suffix.toUpperCase(), firstRun),
    env.DB.prepare(
      `INSERT INTO transactions
       (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
        revision, created_at, updated_at)
       VALUES (?1, ?2, '2026-01-02', 'buy', '2', '100', 1, ?3, ?3)`,
    ).bind(`history-buy-${suffix}`, `history-${suffix}`, firstRun),
  ]);
};

const range = (
  provider: string,
  instrumentId = "history-ibm",
): EarningsHistoryRange => ({
  range: {
    requestedStartDate: "2026-01-02",
    requestedEndDate: "2026-07-13",
    provider,
    observedAt: firstRun,
    providerRevision: `${provider}-r1`,
    secCik: provider === "sec-edgar-earnings" ? "0000051143" : null,
  },
  events: [
    {
      type: "earnings",
      instrumentId,
      symbol: instrumentId.replace("history-", "").toUpperCase(),
      reportDate: "2026-04-22",
      fiscalDateEnding: "2026-03-31",
      epsEstimate: provider === "sec-edgar-earnings" ? null : "1.81",
      currency: "USD",
      timeOfDay: null,
      provider,
      providerEventId: `${provider}:IBM:earnings:2026-03-31`,
      providerRevision: `${provider}|2026-04-22|2026-03-31`,
    },
  ],
});

describe("EarningsHistoryBackfillService", () => {
  it("persists SEC history, supersedes Alpha's same fiscal period, and records coverage", async () => {
    await seed();
    await env.DB.prepare(
      `INSERT INTO earnings_events
       (id, instrument_id, report_date, fiscal_date_ending,
        eps_estimate_decimal, currency, time_of_day, provider,
        provider_event_id, provider_revision, retrieved_at, status,
        created_at, updated_at)
       VALUES ('future-alpha', 'history-ibm', '2026-04-22', '2026-03-31',
               '1.8', 'USD', NULL, 'alpha-vantage-earnings',
               'alpha:IBM:earnings:2026-03-31', 'future-r1', ?1, 'active', ?1, ?1)`,
    )
      .bind(firstRun)
      .run();
    const secProvider: EarningsHistoryProvider = {
      getEarningsHistory: vi.fn(async () => range("sec-edgar-earnings")),
    };
    const summary = await new EarningsHistoryBackfillService({
      db: env.DB,
      secProvider,
      now: () => new Date(firstRun),
      newId: () => "sec-history-event",
    }).refreshDue();

    expect(summary).toMatchObject({
      attempted: 1,
      secCompleted: 1,
      alphaCompleted: 0,
      retried: 0,
    });
    expect(
      await env.DB.prepare(
        `SELECT provider, status FROM earnings_events
          ORDER BY provider`,
      ).all(),
    ).toEqual(
      expect.objectContaining({
        results: [
          { provider: "alpha-vantage-earnings", status: "superseded" },
          { provider: "sec-edgar-earnings", status: "active" },
        ],
      }),
    );
    expect(
      await env.DB.prepare(
        `SELECT requested_start_date, coverage_start_date, coverage_end_date,
                provider, sec_cik, status, attempt_count, last_error_code
           FROM earnings_history_coverage WHERE instrument_id = 'history-ibm'`,
      ).first(),
    ).toEqual({
      requested_start_date: "2026-01-02",
      coverage_start_date: "2026-01-02",
      coverage_end_date: "2026-07-13",
      provider: "sec-edgar-earnings",
      sec_cik: "0000051143",
      status: "current",
      attempt_count: 0,
      last_error_code: null,
    });
  });

  it("retries transient SEC failures, then recovers through Alpha the next day", async () => {
    await seed();
    const secProvider: EarningsHistoryProvider = {
      getEarningsHistory: vi.fn(async () => {
        throw new Error("provider_http_503");
      }),
    };
    const alphaProvider: EarningsHistoryProvider = {
      getEarningsHistory: vi.fn(async (_instrument, startDate, endDate) => {
        const result = range("alpha-vantage-earnings");
        return {
          ...result,
          range: {
            ...result.range,
            requestedStartDate: startDate,
            requestedEndDate: endDate,
          },
        };
      }),
    };
    const first = new EarningsHistoryBackfillService({
      db: env.DB,
      secProvider,
      alphaProvider,
      now: () => new Date(firstRun),
      newId: () => "alpha-history-event",
    });
    expect(await first.refreshDue()).toMatchObject({ retried: 1 });
    expect(alphaProvider.getEarningsHistory).not.toHaveBeenCalled();

    const nextRun = "2026-07-14T12:00:01.000Z";
    const second = new EarningsHistoryBackfillService({
      db: env.DB,
      secProvider,
      alphaProvider,
      now: () => new Date(nextRun),
      newId: () => "alpha-history-event",
    });
    expect(await second.refreshDue()).toMatchObject({
      alphaCompleted: 1,
      retried: 0,
    });
    expect(alphaProvider.getEarningsHistory).toHaveBeenCalledOnce();
  });

  it("recovers an expired lease without user intervention", async () => {
    await seed();
    await env.DB.prepare(
      `INSERT INTO earnings_history_coverage
       (instrument_id, requested_start_date, status, attempt_count,
        next_attempt_at, lease_until, created_at, updated_at)
       VALUES ('history-ibm', '2026-01-02', 'in_progress', 1,
               '2026-07-12T12:00:00.000Z', '2026-07-12T12:15:00.000Z', ?1, ?1)`,
    )
      .bind(firstRun)
      .run();
    const summary = await new EarningsHistoryBackfillService({
      db: env.DB,
      secProvider: {
        getEarningsHistory: async () => range("sec-edgar-earnings"),
      },
      now: () => new Date(firstRun),
      newId: () => "lease-recovery-event",
    }).refreshDue();
    expect(summary.secCompleted).toBe(1);
  });
});
