import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { YahooMarketDataProvider } from "../../src/providers/yahoo";

const headers = {
  Authorization: `Basic ${btoa("owner:password")}`,
  "Content-Type": "application/json",
};

describe("ticker routes", () => {
  it("blocks unauthenticated access", async () => {
    expect((await exports.default.fetch("http://local/api/tickers")).status).toBe(
      401,
    );
  });

  it("validates, inserts, disables, and lists SHOP.TO", async () => {
    vi.spyOn(
      YahooMarketDataProvider.prototype,
      "getInstrument",
    ).mockResolvedValue({
      metadata: {
        symbol: "SHOP.TO",
        companyName: "Shopify Inc.",
        exchange: "TOR",
        currency: "CAD",
        instrumentType: "EQUITY",
      },
      bars: [
        { date: "2026-07-09", close: 174.45, adjustedClose: 174.45 },
      ],
      corporateActionDates: new Set<string>(),
    });
    const created = await exports.default.fetch(
      new Request("http://local/api/tickers", {
        method: "POST",
        headers,
        body: JSON.stringify({ symbol: "shop.to" }),
      }),
    );
    expect(created.status).toBe(201);
    const createdTicker = await created.json<{ ticker: { id: string } }>();
    const disabled = await exports.default.fetch(
      new Request(`http://local/api/tickers/${createdTicker.ticker.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ active: false }),
      }),
    );
    expect(disabled.status).toBe(204);
    const listed = await exports.default.fetch(
      new Request("http://local/api/tickers", { headers }),
    );
    expect(
      (await listed.json<{ tickers: Array<{ symbol: string; active: boolean }> }>())
        .tickers,
    ).toEqual([
      expect.objectContaining({ symbol: "SHOP.TO", active: false }),
    ]);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM tickers").first<{
        count: number;
      }>(),
    ).toEqual({ count: 1 });
  });

  it("rejects non-json mutation bodies", async () => {
    const response = await exports.default.fetch(
      new Request("http://local/api/tickers", {
        method: "POST",
        headers: { Authorization: headers.Authorization },
        body: "symbol=AAPL",
      }),
    );
    expect(response.status).toBe(415);
  });
});
