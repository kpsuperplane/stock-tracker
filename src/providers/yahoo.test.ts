import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { MarketFactsService } from "../services/market-facts";
import { YahooMarketDataProvider } from "./yahoo";

describe("YahooMarketDataProvider", () => {
  it.each([
    ["AAPL", "tests/fixtures/yahoo/aapl.json", "USD"],
    ["SHOP.TO", "tests/fixtures/yahoo/shop-to.json", "CAD"],
    ["WELL.V", "tests/fixtures/yahoo/well-v.json", "CAD"],
  ])("normalizes %s", async (symbol, fixture, currency) => {
    const body = await readFile(fixture, "utf8");
    const fetcher = vi.fn(async () => new Response(body, { status: 200 }));
    const result = await new YahooMarketDataProvider(fetcher).getInstrument(
      symbol,
      "2026-07-08",
      "2026-07-10",
    );
    expect(result.metadata).toMatchObject({ symbol, currency });
    expect(result.bars).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects malformed provider data", async () => {
    const provider = new YahooMarketDataProvider(async () =>
      Response.json({ chart: { result: [] } }),
    );
    await expect(
      provider.getInstrument("AAPL", "2026-07-08", "2026-07-10"),
    ).rejects.toThrow();
  });

  it("preserves raw high-precision price tokens through normalization", async () => {
    const body = `{
      "unrelated": { "close": [999, 998] },
      "chart": {
        "result": [{
          "meta": {
            "symbol": "AAPL",
            "longName": "Apple Inc.",
            "exchangeName": "NMS",
            "currency": "USD",
            "instrumentType": "EQUITY"
          },
          "timestamp": [1783517400, 1783603800],
          "indicators": {
            "quote": [{ "close": [123.4567890123456789, 124.4567890123456789] }],
            "adjclose": [{ "adjclose": [123.4567890123456789, 124.4567890123456789] }]
          },
          "events": {}
        }]
      }
    }`;
    const provider = new YahooMarketDataProvider(
      async () => new Response(body, { status: 200 }),
    );

    const series = await provider.getInstrument(
      "AAPL",
      "2026-07-08",
      "2026-07-09",
    );
    expect(series.bars[0]).toMatchObject({
      closeDecimal: "123.4567890123456789",
      adjustedCloseDecimal: "123.4567890123456789",
    });

    const facts = await new MarketFactsService(
      provider,
      () => new Date(0),
    ).normalize({
      instrumentId: "instrument-1",
      symbol: "AAPL",
      startDate: "2026-07-09",
      endDate: "2026-07-09",
      provider: "yahoo-chart-v8",
      providerRevision: "raw-token-test",
      activeSplits: [],
    });
    expect(facts[0]).toMatchObject({
      previousRawCloseDecimal: "123.4567890123456789",
      currentRawCloseDecimal: "124.4567890123456789",
      movementAmountDecimal: "1",
    });
  });

  it("accepts a null events field when Yahoo reports no corporate actions", async () => {
    const body = await readFile("tests/fixtures/yahoo/aapl.json", "utf8");
    const payload = JSON.parse(body) as {
      chart: { result: Array<{ events: unknown }> };
    };
    const result = payload.chart.result[0];
    if (!result) throw new Error("fixture is missing a chart result");
    result.events = null;
    const provider = new YahooMarketDataProvider(async () =>
      Response.json(payload),
    );

    const series = await provider.getInstrument(
      "AAPL",
      "2026-07-08",
      "2026-07-10",
    );

    expect(series.metadata.symbol).toBe("AAPL");
    expect(series.corporateActionDates.size).toBe(0);
  });

  it("does not rebind the fetcher this value", async () => {
    const body = await readFile("tests/fixtures/yahoo/aapl.json", "utf8");
    const fetcher = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError("illegal invocation");
      return Promise.resolve(new Response(body, { status: 200 }));
    });

    const series = await new YahooMarketDataProvider(fetcher).getInstrument(
      "AAPL",
      "2026-07-08",
      "2026-07-10",
    );

    expect(series.metadata.symbol).toBe("AAPL");
  });
});
