import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { SplitEventRange } from "./corporate-actions";

const completeSplitCoverage: SplitEventRange["range"] = {
  requestedStartDate: "2024-01-01",
  requestedEndDate: "2024-12-31",
  coverageStartDate: null,
  coverageEndDate: null,
  // @ts-expect-error selected split snapshots can never claim completeness
  isComplete: true,
  basis: "unverified",
  provider: "yahoo-chart-v8",
  observedAt: "2026-07-10T18:00:00.000Z",
  providerRevision: "unsafe",
};
void completeSplitCoverage;

const providerConfirmedSplitCoverage: SplitEventRange["range"] = {
  requestedStartDate: "2024-01-01",
  requestedEndDate: "2024-12-31",
  coverageStartDate: null,
  coverageEndDate: null,
  isComplete: false,
  // @ts-expect-error selected split snapshots can only be unverified
  basis: "provider-confirmed",
  provider: "yahoo-chart-v8",
  observedAt: "2026-07-10T18:00:00.000Z",
  providerRevision: "unsafe",
};
void providerConfirmedSplitCoverage;

type JsonRecord = Record<string, unknown>;

async function fixture(path: string): Promise<JsonRecord> {
  return JSON.parse(await readFile(path, "utf8")) as JsonRecord;
}

describe("normalized portfolio event provider contracts", () => {
  it("preserves split fields and reports unverified coverage that the legacy date Set collapses", async () => {
    const { YahooCorporateActionProvider } = await import(
      "./yahoo-corporate-actions"
    );
    const cases = await fixture(
      "tests/fixtures/providers/yahoo-split-cases.json",
    );
    const fetcher = vi.fn(async (_input: string | URL | Request) =>
      Response.json(cases.ordinaryAndReverse),
    );

    const result = await new YahooCorporateActionProvider(
      fetcher,
      () => new Date("2026-07-10T18:00:00.000Z"),
    ).getSplits("case", "2024-01-01", "2024-12-31");

    expect(result).toEqual({
      symbol: "CASE",
      range: {
        requestedStartDate: "2024-01-01",
        requestedEndDate: "2024-12-31",
        coverageStartDate: null,
        coverageEndDate: null,
        isComplete: false,
        basis: "unverified",
        provider: "yahoo-chart-v8",
        observedAt: "2026-07-10T18:00:00.000Z",
        providerRevision:
          "yahoo-chart-v8|CASE|2024-01-01|2024-12-31|2024-06-01|4:1,2024-10-01|1:10",
      },
      events: [
        {
          type: "split",
          symbol: "CASE",
          effectiveDate: "2024-06-01",
          numerator: "4",
          denominator: "1",
          provider: "yahoo-chart-v8",
          providerEventId: "yahoo-chart-v8:CASE:split:2024-06-01",
          providerRevision: "2024-06-01|4:1",
        },
        {
          type: "split",
          symbol: "CASE",
          effectiveDate: "2024-10-01",
          numerator: "1",
          denominator: "10",
          provider: "yahoo-chart-v8",
          providerEventId: "yahoo-chart-v8:CASE:split:2024-10-01",
          providerRevision: "2024-10-01|1:10",
        },
      ],
    });
    const request = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(request.pathname).toBe("/v8/finance/chart/case");
    expect(request.searchParams.get("events")).toBe("splits");
    expect(request.searchParams.get("period1")).toBe("1704067200");
    expect(request.searchParams.get("period2")).toBe("1735689600");
  });

  it("preserves Yahoo provider identity when a split snapshot has no events", async () => {
    const { YahooCorporateActionProvider } = await import(
      "./yahoo-corporate-actions"
    );
    const cases = await fixture(
      "tests/fixtures/providers/yahoo-split-cases.json",
    );
    const payload = structuredClone(cases.ordinaryAndReverse) as {
      chart: { result: Array<{ events: { splits?: JsonRecord } }> };
    };
    const resultRow = payload.chart.result[0];
    if (!resultRow) throw new Error("fixture result missing");
    resultRow.events.splits = {};

    const result = await new YahooCorporateActionProvider(async () =>
      Response.json(payload),
    ).getSplits("CASE", "2024-01-01", "2024-12-31");

    expect(result.events).toEqual([]);
    expect(result.range).toMatchObject({
      provider: "yahoo-chart-v8",
      basis: "unverified",
      isComplete: false,
    });
  });

  it("keeps correction identity stable while changing its split revision", async () => {
    const { YahooCorporateActionProvider } = await import(
      "./yahoo-corporate-actions"
    );
    const cases = await fixture(
      "tests/fixtures/providers/yahoo-split-cases.json",
    );
    const results = [];
    for (const payload of [cases.correctionBefore, cases.correctionAfter]) {
      results.push(
        await new YahooCorporateActionProvider(async () =>
          Response.json(payload),
        ).getSplits("CASE", "2024-01-01", "2024-12-31"),
      );
    }

    expect(results[0]?.events[0]?.providerEventId).toBe(
      results[1]?.events[0]?.providerEventId,
    );
    expect(results[0]?.events[0]?.providerRevision).not.toBe(
      results[1]?.events[0]?.providerRevision,
    );
    expect(results[0]?.range.providerRevision).not.toBe(
      results[1]?.range.providerRevision,
    );
  });

  it("uses UTC at a timezone boundary and removes exact split duplicates", async () => {
    const { YahooCorporateActionProvider } = await import(
      "./yahoo-corporate-actions"
    );
    const cases = await fixture(
      "tests/fixtures/providers/yahoo-split-cases.json",
    );
    const result = await new YahooCorporateActionProvider(async () =>
      Response.json(cases.timezoneBoundaryAndDuplicate),
    ).getSplits("CASE", "2024-01-01", "2024-12-31");

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.effectiveDate).toBe("2024-06-01");
  });

  it("reduces decimal provider ratios to exact integer numerator and denominator strings", async () => {
    const { YahooCorporateActionProvider } = await import(
      "./yahoo-corporate-actions"
    );
    const cases = await fixture(
      "tests/fixtures/providers/yahoo-split-cases.json",
    );
    const payload = structuredClone(cases.correctionBefore) as {
      chart: {
        result: Array<{
          events: {
            splits: Record<
              string,
              { numerator: number; denominator: number; splitRatio: string }
            >;
          };
        }>;
      };
    };
    const split = payload.chart.result[0]?.events.splits["1717200000"];
    if (!split) throw new Error("fixture split missing");
    split.numerator = 1.5;
    split.denominator = 1;
    split.splitRatio = "1.5:1";

    const result = await new YahooCorporateActionProvider(async () =>
      Response.json(payload),
    ).getSplits("CASE", "2024-01-01", "2024-12-31");

    expect(result.events[0]).toMatchObject({
      numerator: "3",
      denominator: "2",
      providerRevision: "2024-06-01|3:2",
    });
  });

  it("rejects incomplete splits instead of inventing exact ratios", async () => {
    const { YahooCorporateActionProvider } = await import(
      "./yahoo-corporate-actions"
    );
    const cases = await fixture(
      "tests/fixtures/providers/yahoo-split-cases.json",
    );
    const provider = new YahooCorporateActionProvider(async () =>
      Response.json(cases.missingFields),
    );

    await expect(
      provider.getSplits("CASE", "2024-01-01", "2024-12-31"),
    ).rejects.toThrow("provider_schema");
  });

  it("reports a delisted or unknown Yahoo symbol as unavailable", async () => {
    const { YahooCorporateActionProvider } = await import(
      "./yahoo-corporate-actions"
    );
    const cases = await fixture(
      "tests/fixtures/providers/yahoo-split-cases.json",
    );
    const provider = new YahooCorporateActionProvider(async () =>
      Response.json(cases.delisted),
    );

    await expect(
      provider.getSplits("OLD", "2024-01-01", "2024-12-31"),
    ).rejects.toThrow("provider_symbol_unavailable");
  });

  it("bounds a headerless Yahoo response while streaming the body", async () => {
    const { YahooCorporateActionProvider } = await import(
      "./yahoo-corporate-actions"
    );
    const provider = new YahooCorporateActionProvider(
      async () => new Response("x".repeat(2_000_001)),
    );

    await expect(
      provider.getSplits("CASE", "2024-01-01", "2024-12-31"),
    ).rejects.toThrow("provider_response_too_large");
  });

  it("normalizes provider-shaped historical and future dividends with exact amount, ex-date, currency, identity, and revision", async () => {
    const { AlphaVantageDividendEventProvider } = await import(
      "./alpha-vantage-dividends"
    );
    const cases = await fixture(
      "tests/fixtures/providers/alpha-vantage-dividend-cases.json",
    );
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return Response.json(
        url.searchParams.get("function") === "OVERVIEW"
          ? cases.overview
          : cases.historicalAndFuture,
      );
    });

    const result = await new AlphaVantageDividendEventProvider(
      "secret-key",
      fetcher,
    ).getDividends("case", "2024-01-01", "2026-12-31");

    expect(result.events).toEqual([
      {
        type: "dividend",
        symbol: "CASE",
        exDate: "2024-05-09",
        amount: "1.6700",
        currency: "USD",
        provider: "alpha-vantage-dividends",
        providerEventId:
          "alpha-vantage-dividends:CASE:dividend:2024-05-09:2024-04-30",
        providerRevision:
          "2024-05-09|2024-04-30|2024-05-10|2024-06-10|1.6700|USD",
      },
      {
        type: "dividend",
        symbol: "CASE",
        exDate: "2026-08-10",
        amount: "1.6900",
        currency: "USD",
        provider: "alpha-vantage-dividends",
        providerEventId:
          "alpha-vantage-dividends:CASE:dividend:2026-08-10:2026-07-09",
        providerRevision:
          "2026-08-10|2026-07-09|2026-08-10|2026-09-10|1.6900|USD",
      },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.range).toMatchObject({
      coverageStartDate: null,
      coverageEndDate: null,
      isComplete: false,
      basis: "source-reported",
      provider: "alpha-vantage-dividends",
      observedAt: expect.any(String),
      providerRevision: expect.stringContaining("alpha-vantage-dividends"),
    });
    for (const call of fetcher.mock.calls) {
      const request = new URL(String(call[0]));
      expect(request.origin).toBe("https://www.alphavantage.co");
      expect(request.searchParams.get("symbol")).toBe("case");
      expect(request.searchParams.get("apikey")).toBe("secret-key");
    }
  });

  it("keeps correction identity stable while changing its dividend revision", async () => {
    const { AlphaVantageDividendEventProvider } = await import(
      "./alpha-vantage-dividends"
    );
    const cases = await fixture(
      "tests/fixtures/providers/alpha-vantage-dividend-cases.json",
    );
    const results = [];
    for (const dividendPayload of [
      cases.correctionBefore,
      cases.correctionAfter,
    ]) {
      const provider = new AlphaVantageDividendEventProvider(
        "key",
        async (input) =>
          Response.json(
            new URL(String(input)).searchParams.get("function") === "OVERVIEW"
              ? cases.overview
              : dividendPayload,
          ),
      );
      results.push(
        await provider.getDividends("CASE", "2026-01-01", "2026-12-31"),
      );
    }

    expect(results[0]?.events[0]?.providerEventId).toBe(
      results[1]?.events[0]?.providerEventId,
    );
    expect(results[0]?.events[0]?.providerRevision).not.toBe(
      results[1]?.events[0]?.providerRevision,
    );
  });

  it("treats a missing future dividend row as no event known from this source", async () => {
    const { AlphaVantageDividendEventProvider } = await import(
      "./alpha-vantage-dividends"
    );
    const cases = await fixture(
      "tests/fixtures/providers/alpha-vantage-dividend-cases.json",
    );
    const payload = structuredClone(cases.historicalAndFuture) as {
      symbol: string;
      data: Array<{ ex_dividend_date: string }>;
    };
    payload.data = payload.data.filter(
      (event) => event.ex_dividend_date < "2026-01-01",
    );
    const provider = new AlphaVantageDividendEventProvider(
      "key",
      async (input) =>
        Response.json(
          new URL(String(input)).searchParams.get("function") === "OVERVIEW"
            ? cases.overview
            : payload,
        ),
      () => new Date("2026-07-10T18:00:00.000Z"),
    );

    const result = await provider.getDividends(
      "CASE",
      "2026-01-01",
      "2026-12-31",
    );

    expect(result.events).toEqual([]);
    expect(result.range).toMatchObject({
      provider: "alpha-vantage-dividends",
      basis: "source-reported",
      isComplete: false,
      observedAt: "2026-07-10T18:00:00.000Z",
    });
  });

  it("rejects dividends with missing required fields", async () => {
    const { AlphaVantageDividendEventProvider } = await import(
      "./alpha-vantage-dividends"
    );
    const cases = await fixture(
      "tests/fixtures/providers/alpha-vantage-dividend-cases.json",
    );
    const provider = new AlphaVantageDividendEventProvider(
      "key",
      async (input) =>
        Response.json(
          new URL(String(input)).searchParams.get("function") === "OVERVIEW"
            ? cases.overview
            : cases.missingFields,
        ),
    );

    await expect(
      provider.getDividends("CASE", "2026-01-01", "2026-12-31"),
    ).rejects.toThrow("provider_schema");
  });

  it("rejects impossible provider dividend dates", async () => {
    const { AlphaVantageDividendEventProvider } = await import(
      "./alpha-vantage-dividends"
    );
    const cases = await fixture(
      "tests/fixtures/providers/alpha-vantage-dividend-cases.json",
    );
    const payload = structuredClone(cases.correctionAfter) as {
      data: Array<{ ex_dividend_date: string }>;
    };
    const dividend = payload.data[0];
    if (!dividend) throw new Error("fixture dividend missing");
    dividend.ex_dividend_date = "2026-02-30";
    const provider = new AlphaVantageDividendEventProvider(
      "key",
      async (input) =>
        Response.json(
          new URL(String(input)).searchParams.get("function") === "OVERVIEW"
            ? cases.overview
            : payload,
        ),
    );

    await expect(
      provider.getDividends("CASE", "2026-01-01", "2026-12-31"),
    ).rejects.toThrow("provider_schema");
  });

  it("rejects impossible requested dividend range dates", async () => {
    const { AlphaVantageDividendEventProvider } = await import(
      "./alpha-vantage-dividends"
    );
    const cases = await fixture(
      "tests/fixtures/providers/alpha-vantage-dividend-cases.json",
    );
    const provider = new AlphaVantageDividendEventProvider(
      "key",
      async (input) =>
        Response.json(
          new URL(String(input)).searchParams.get("function") === "OVERVIEW"
            ? cases.overview
            : cases.correctionAfter,
        ),
    );

    await expect(
      provider.getDividends("CASE", "2026-02-30", "2026-12-31"),
    ).rejects.toThrow("provider_invalid_range");
  });

  it("bounds a headerless Alpha Vantage response while streaming the body", async () => {
    const { AlphaVantageDividendEventProvider } = await import(
      "./alpha-vantage-dividends"
    );
    const cases = await fixture(
      "tests/fixtures/providers/alpha-vantage-dividend-cases.json",
    );
    const provider = new AlphaVantageDividendEventProvider(
      "key",
      async (input) =>
        new URL(String(input)).searchParams.get("function") === "OVERVIEW"
          ? Response.json(cases.overview)
          : new Response("x".repeat(2_000_001)),
    );

    await expect(
      provider.getDividends("CASE", "2026-01-01", "2026-12-31"),
    ).rejects.toThrow("provider_response_too_large");
  });

  it("reports a delisted or unknown Alpha Vantage symbol as unavailable", async () => {
    const { AlphaVantageDividendEventProvider } = await import(
      "./alpha-vantage-dividends"
    );
    const cases = await fixture(
      "tests/fixtures/providers/alpha-vantage-dividend-cases.json",
    );
    const provider = new AlphaVantageDividendEventProvider("key", async () =>
      Response.json(cases.delisted),
    );

    await expect(
      provider.getDividends("OLD", "2026-01-01", "2026-12-31"),
    ).rejects.toThrow("provider_symbol_unavailable");
  });
});
