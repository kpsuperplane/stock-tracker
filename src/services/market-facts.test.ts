import { describe, expect, it, vi } from "vitest";
import type { DailySeries } from "../providers/market-data";
import { MarketFactsService } from "./market-facts";

const now = new Date("2026-07-10T22:00:00.000Z");

const series = (bars: DailySeries["bars"], symbol = "CASE") => ({
  metadata: {
    symbol,
    companyName: "Case Corp",
    exchange: "NMS",
    currency: "USD",
    instrumentType: "EQUITY" as const,
  },
  bars,
  corporateActionDates: new Set<string>(),
});

const input = (overrides: Record<string, unknown> = {}) => ({
  instrumentId: "instrument-1",
  symbol: "CASE",
  startDate: "2026-07-09",
  endDate: "2026-07-10",
  provider: "yahoo-chart-v8",
  providerRevision: "range-r1",
  activeSplits: [],
  ...overrides,
});

describe("MarketFactsService", () => {
  it("materializes every completed fact from one range response with canonical split-adjusted movement", async () => {
    const getInstrument = vi.fn(async () =>
      series([
        { date: "2026-07-08", close: 100, adjustedClose: 100 },
        { date: "2026-07-09", close: 105, adjustedClose: 105 },
        { date: "2026-07-10", close: 103.5, adjustedClose: 103.5 },
      ]),
    );
    const facts = await new MarketFactsService(
      { getInstrument },
      () => now,
    ).normalize(input());

    expect(getInstrument).toHaveBeenCalledOnce();
    expect(facts).toHaveLength(2);
    expect(facts.map((fact) => fact.tradingDate)).toEqual([
      "2026-07-09",
      "2026-07-10",
    ]);
    expect(facts[0]).toMatchObject({
      previousTradingDate: "2026-07-08",
      previousRawCloseDecimal: "100",
      currentRawCloseDecimal: "105",
      splitAdjustedPreviousCloseDecimal: "100",
      movementAmountDecimal: "5",
      movementPercentDecimal: "5",
      movementBasis: "split_adjusted_price_return",
      freshness: "fresh",
      status: "valid",
    });
    expect(facts[1]).toMatchObject({
      previousTradingDate: "2026-07-09",
      movementAmountDecimal: "-1.5",
      movementPercentDecimal:
        "-1.4285714285714285714285714285714285714285714285714285714285714285714285714285714",
    });
  });

  it("looks back before the requested range and emits no weekend or holiday fact", async () => {
    let requestedStart = "";
    const getInstrument = vi.fn(async (_symbol, startDate: string) => {
      requestedStart = startDate;
      return series([
        { date: "2026-07-08", close: 100, adjustedClose: 100 },
        { date: "2026-07-10", close: 110, adjustedClose: 110 },
      ]);
    });
    const facts = await new MarketFactsService(
      { getInstrument },
      () => now,
    ).normalize(input({ startDate: "2026-07-10", endDate: "2026-07-12" }));

    expect(requestedStart < "2026-07-10").toBe(true);
    expect(facts).toHaveLength(1);
    expect(facts[0]?.tradingDate).toBe("2026-07-10");
    expect(facts[0]?.previousTradingDate).toBe("2026-07-08");
  });

  it("marks the first available bar as missing its previous comparison", async () => {
    const result = await new MarketFactsService(
      {
        getInstrument: async () =>
          series([{ date: "2026-07-09", close: 100, adjustedClose: 100 }]),
      },
      () => now,
    ).normalizeResult(
      input({ startDate: "2026-07-09", endDate: "2026-07-09" }),
    );

    expect(result.facts).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({
        tradingDate: "2026-07-09",
        status: "error",
        errorCode: "no_previous_bar",
        currentRawCloseDecimal: "100",
        previousTradingDate: null,
      }),
    ]);
  });

  it.each([
    {
      name: "forward split",
      previousClose: 100,
      currentClose: 55,
      numerator: "2",
      denominator: "1",
      adjustedPrevious: "50",
      amount: "5",
      percent: "10",
    },
    {
      name: "reverse split",
      previousClose: 10,
      currentClose: 110,
      numerator: "1",
      denominator: "10",
      adjustedPrevious: "100",
      amount: "10",
      percent: "10",
    },
  ])("uses one split-adjusted basis for amount and percentage ($name)", async (scenario) => {
    const facts = await new MarketFactsService(
      {
        getInstrument: async () =>
          series([
            {
              date: "2026-07-08",
              close: scenario.previousClose,
              adjustedClose: scenario.previousClose,
            },
            {
              date: "2026-07-09",
              close: scenario.currentClose,
              adjustedClose: scenario.currentClose,
            },
          ]),
      },
      () => now,
    ).normalize(
      input({
        startDate: "2026-07-09",
        endDate: "2026-07-09",
        activeSplits: [
          {
            id: `split-${scenario.name}`,
            effectiveDate: "2026-07-09",
            numerator: scenario.numerator,
            denominator: scenario.denominator,
          },
        ],
      }),
    );

    expect(facts[0]).toMatchObject({
      crossingSplitNumerator: scenario.numerator,
      crossingSplitDenominator: scenario.denominator,
      splitAdjustedPreviousCloseDecimal: scenario.adjustedPrevious,
      movementAmountDecimal: scenario.amount,
      movementPercentDecimal: scenario.percent,
    });
  });

  it("keeps a non-terminating 3:1 split rational until output", async () => {
    const facts = await new MarketFactsService(
      {
        getInstrument: async () =>
          series([
            { date: "2026-07-08", close: 100, adjustedClose: 100 },
            { date: "2026-07-09", close: 34, adjustedClose: 34 },
          ]),
      },
      () => now,
    ).normalize(
      input({
        startDate: "2026-07-09",
        endDate: "2026-07-09",
        activeSplits: [
          {
            id: "split-3-for-1",
            effectiveDate: "2026-07-09",
            numerator: "3",
            denominator: "1",
          },
        ],
      }),
    );

    expect(facts[0]?.splitAdjustedPreviousCloseDecimal).toBe(
      "33.333333333333333333333333333333333333333333333333333333333333333333333333333333",
    );
    expect(facts[0]?.movementAmountDecimal).toBe(
      "0.66666666666666666666666666666666666666666666666666666666666666666666666666666667",
    );
    expect(facts[0]?.movementPercentDecimal).toBe("2");
  });

  it("keeps a 7:3 split exact at the five-percent movement boundary", async () => {
    const facts = await new MarketFactsService(
      {
        getInstrument: async () =>
          series([
            { date: "2026-07-08", close: 100, adjustedClose: 100 },
            { date: "2026-07-09", close: 45, adjustedClose: 45 },
          ]),
      },
      () => now,
    ).normalize(
      input({
        startDate: "2026-07-09",
        endDate: "2026-07-09",
        activeSplits: [
          {
            id: "split-7-for-3",
            effectiveDate: "2026-07-09",
            numerator: "7",
            denominator: "3",
          },
        ],
      }),
    );

    expect(facts[0]).toMatchObject({
      crossingSplitNumerator: "7",
      crossingSplitDenominator: "3",
      movementPercentDecimal: "5",
    });
  });

  it("uses exact provider decimal text without binary number artifacts", async () => {
    const facts = await new MarketFactsService(
      {
        getInstrument: async () =>
          series([
            {
              date: "2026-07-08",
              close: 0.1,
              closeDecimal: "0.1",
              adjustedClose: 0.1,
              adjustedCloseDecimal: "0.1",
            },
            {
              date: "2026-07-09",
              close: 0.2,
              closeDecimal: "0.2",
              adjustedClose: 0.2,
              adjustedCloseDecimal: "0.2",
            },
          ]),
      },
      () => now,
    ).normalize(input({ startDate: "2026-07-09", endDate: "2026-07-09" }));

    expect(facts[0]).toMatchObject({
      previousRawCloseDecimal: "0.1",
      currentRawCloseDecimal: "0.2",
      movementAmountDecimal: "0.1",
      movementPercentDecimal: "100",
    });
  });

  it("expands small finite exponent fallback prices", async () => {
    const facts = await new MarketFactsService(
      {
        getInstrument: async () =>
          series([
            { date: "2026-07-08", close: 1e-7, adjustedClose: 1e-7 },
            { date: "2026-07-09", close: 2e-7, adjustedClose: 2e-7 },
          ]),
      },
      () => now,
    ).normalize(input({ startDate: "2026-07-09", endDate: "2026-07-09" }));

    expect(facts[0]).toMatchObject({
      previousRawCloseDecimal: "0.0000001",
      currentRawCloseDecimal: "0.0000002",
      movementAmountDecimal: "0.0000001",
      movementPercentDecimal: "100",
    });
  });

  it("expands large finite exponent fallback prices", async () => {
    const facts = await new MarketFactsService(
      {
        getInstrument: async () =>
          series([
            { date: "2026-07-08", close: 1e21, adjustedClose: 1e21 },
            { date: "2026-07-09", close: 2e21, adjustedClose: 2e21 },
          ]),
      },
      () => now,
    ).normalize(input({ startDate: "2026-07-09", endDate: "2026-07-09" }));

    expect(facts[0]).toMatchObject({
      previousRawCloseDecimal: "1000000000000000000000",
      currentRawCloseDecimal: "2000000000000000000000",
      movementAmountDecimal: "1000000000000000000000",
      movementPercentDecimal: "100",
    });
  });

  it("does not materialize invalid bars or overwrite a last valid repository fact on provider failure", async () => {
    const invalid = await new MarketFactsService(
      {
        getInstrument: async () =>
          series([
            { date: "2026-07-08", close: 100, adjustedClose: 100 },
            { date: "2026-07-09", close: null, adjustedClose: null },
          ]),
      },
      () => now,
    ).normalizeResult(
      input({ startDate: "2026-07-09", endDate: "2026-07-09" }),
    );
    expect(invalid.facts).toEqual([]);
    expect(invalid.errors[0]).toMatchObject({
      status: "error",
      persistable: false,
      errorCode: "invalid_price",
    });

    const failed = await new MarketFactsService(
      {
        getInstrument: async () => {
          throw new Error("provider_http_503");
        },
      },
      () => now,
    ).normalizeResult(input());
    expect(failed.facts).toEqual([]);
    expect(failed.errors[0]).toMatchObject({
      status: "error",
      persistable: false,
      errorCode: "provider_http_503",
    });
  });

  it("leaves an ex-dividend raw-close drop unadjusted", async () => {
    const facts = await new MarketFactsService(
      {
        getInstrument: async () =>
          series([
            { date: "2026-07-08", close: 100, adjustedClose: 100 },
            { date: "2026-07-09", close: 95, adjustedClose: 95 },
          ]),
      },
      () => now,
    ).normalize(input({ startDate: "2026-07-09", endDate: "2026-07-09" }));

    expect(facts[0]).toMatchObject({
      movementAmountDecimal: "-5",
      movementPercentDecimal: "-5",
      crossingSplitNumerator: "1",
      crossingSplitDenominator: "1",
    });
  });

  it("keeps provider corrections distinguishable by revision", async () => {
    const provider = {
      getInstrument: vi
        .fn()
        .mockResolvedValueOnce(
          series([
            { date: "2026-07-08", close: 100, adjustedClose: 100 },
            { date: "2026-07-09", close: 105, adjustedClose: 105 },
          ]),
        )
        .mockResolvedValueOnce(
          series([
            { date: "2026-07-08", close: 100, adjustedClose: 100 },
            { date: "2026-07-09", close: 106, adjustedClose: 106 },
          ]),
        ),
    };
    const service = new MarketFactsService(provider, () => now);
    const first = await service.normalize(input({ providerRevision: "r1" }));
    const corrected = await service.normalize(
      input({ providerRevision: "r2" }),
    );

    expect(first[0]?.movementPercentDecimal).toBe("5");
    expect(corrected[0]?.movementPercentDecimal).toBe("6");
    expect(first[0]?.providerRevision).toBe("r1");
    expect(corrected[0]?.providerRevision).toBe("r2");
    expect(first[0]?.id).toBe(corrected[0]?.id);
  });
});
