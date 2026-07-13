import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type {
  EarningsEventRange,
  EarningsProvider,
} from "../../src/providers/earnings";
import { ScheduledEarningsRefreshService } from "../../src/services/earnings-refresh";

const now = "2026-07-13T12:00:00.000Z";

const seedInstrument = async (): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO instruments
       (id, symbol, company_name, exchange, currency, instrument_type,
        provider, provider_symbol, created_at, updated_at)
       VALUES ('earnings-ibm', 'IBM', 'IBM Corp', 'NYSE', 'USD', 'stock',
               'yahoo', 'IBM', ?1, ?1)`,
    ).bind(now),
    env.DB.prepare(
      `INSERT INTO transactions
       (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
        revision, created_at, updated_at)
       VALUES ('earnings-buy', 'earnings-ibm', '2026-01-02', 'buy', '2', '100',
               1, ?1, ?1)`,
    ).bind(now),
  ]);
};

const snapshot = (
  reportDate: string,
  estimate = "3.02",
): EarningsEventRange => ({
  range: {
    requestedStartDate: "2026-07-13",
    requestedEndDate: "2026-10-13",
    provider: "alpha-vantage-earnings",
    observedAt: now,
    providerRevision: `${reportDate}|${estimate}`,
  },
  events: [
    {
      type: "earnings",
      instrumentId: "earnings-ibm",
      symbol: "IBM",
      reportDate,
      fiscalDateEnding: "2026-06-30",
      epsEstimate: estimate,
      currency: "USD",
      timeOfDay: "post-market",
      provider: "alpha-vantage-earnings",
      providerEventId: "alpha-vantage-earnings:IBM:earnings:2026-06-30",
      providerRevision: `${reportDate}|2026-06-30|${estimate}|USD|post-market`,
    },
  ],
});

describe("ScheduledEarningsRefreshService", () => {
  it("persists corrections, stales missing future events, and retains history", async () => {
    await seedInstrument();
    let current = snapshot("2026-07-22");
    const provider: EarningsProvider = {
      getEarningsCalendar: async () => current,
    };
    let nextId = 0;
    const service = new ScheduledEarningsRefreshService({
      db: env.DB,
      provider,
      now: () => new Date(now),
      newId: () => `earnings-event-${++nextId}`,
    });
    expect(await service.refreshHeldInstruments()).toMatchObject({
      events: 1,
      insertedOrCorrected: 1,
      coverageStatus: "current",
    });

    current = snapshot("2026-07-23", "3.15");
    expect(await service.refreshHeldInstruments()).toMatchObject({
      insertedOrCorrected: 1,
    });
    expect(
      await env.DB.prepare(
        `SELECT report_date, eps_estimate_decimal, status
           FROM earnings_events ORDER BY report_date`,
      ).all(),
    ).toEqual(
      expect.objectContaining({
        results: [
          expect.objectContaining({ status: "superseded" }),
          {
            report_date: "2026-07-23",
            eps_estimate_decimal: "3.15",
            status: "active",
          },
        ],
      }),
    );

    current = {
      ...current,
      events: [],
      range: { ...current.range, providerRevision: "empty" },
    };
    expect(await service.refreshHeldInstruments()).toMatchObject({
      markedStale: 1,
    });
    expect(
      await env.DB.prepare(
        "SELECT status FROM earnings_events WHERE report_date = '2026-07-23'",
      ).first(),
    ).toEqual({ status: "stale" });

    await env.DB.prepare(
      "UPDATE earnings_events SET report_date = '2026-07-01', status = 'active' WHERE report_date = '2026-07-23'",
    ).run();
    await service.refreshHeldInstruments();
    expect(
      await env.DB.prepare(
        "SELECT status FROM earnings_events WHERE report_date = '2026-07-01'",
      ).first(),
    ).toEqual({ status: "active" });
  });

  it("preserves events and degrades coverage when the provider or key is unavailable", async () => {
    await seedInstrument();
    const successful = new ScheduledEarningsRefreshService({
      db: env.DB,
      provider: { getEarningsCalendar: async () => snapshot("2026-07-22") },
      now: () => new Date(now),
      newId: () => "earnings-preserved",
    });
    await successful.refreshHeldInstruments();

    const failed = new ScheduledEarningsRefreshService({
      db: env.DB,
      provider: {
        getEarningsCalendar: async () => {
          throw new Error("provider_http_503");
        },
      },
      now: () => new Date(now),
    });
    expect(await failed.refreshHeldInstruments()).toMatchObject({
      coverageStatus: "stale",
    });
    expect(
      await env.DB.prepare("SELECT status FROM earnings_events").first(),
    ).toEqual({ status: "active" });

    await env.DB.prepare("DELETE FROM earnings_calendar_coverage").run();
    const missingKey = new ScheduledEarningsRefreshService({
      db: env.DB,
      now: () => new Date(now),
    });
    expect(await missingKey.refreshHeldInstruments()).toMatchObject({
      coverageStatus: "unavailable",
    });
  });
});
