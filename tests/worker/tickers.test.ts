import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TickerRepository } from "../../src/db/tickers";

describe("TickerRepository", () => {
  it("keeps history while soft deleting a ticker", async () => {
    const repository = new TickerRepository(env.DB);
    await repository.insert({
      id: "ticker-shop",
      symbol: "SHOP.TO",
      companyName: "Shopify Inc.",
      exchange: "TOR",
      currency: "CAD",
      now: "2026-07-09T22:00:00.000Z",
    });
    expect(await repository.countActive()).toBe(1);
    await repository.softDelete(
      "ticker-shop",
      "2026-07-10T12:00:00.000Z",
    );
    expect(await repository.countActive()).toBe(0);
    expect((await repository.findBySymbol("SHOP.TO"))?.deletedAt).toBe(
      "2026-07-10T12:00:00.000Z",
    );
  });

  it("can disable and restore an existing ticker without changing its identity", async () => {
    const repository = new TickerRepository(env.DB);
    await repository.insert({
      id: "ticker-aapl",
      symbol: "AAPL",
      companyName: "Apple Inc.",
      exchange: "NMS",
      currency: "USD",
      now: "2026-07-09T22:00:00.000Z",
    });
    expect(await repository.setActive("ticker-aapl", false, "2026-07-10T00:00:00Z")).toBe(true);
    expect(await repository.countActive()).toBe(0);
    await repository.softDelete("ticker-aapl", "2026-07-10T01:00:00Z");
    await repository.restore({
      id: "ticker-aapl",
      symbol: "AAPL",
      companyName: "Apple Incorporated",
      exchange: "NMS",
      currency: "USD",
      now: "2026-07-10T02:00:00Z",
    });
    expect(await repository.findBySymbol("AAPL")).toMatchObject({
      id: "ticker-aapl",
      active: true,
      deletedAt: null,
      companyName: "Apple Incorporated",
    });
  });
});
