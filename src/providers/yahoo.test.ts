import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
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
});
