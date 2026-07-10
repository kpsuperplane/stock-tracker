import { describe, expect, it, vi } from "vitest";
import { WatchlistService } from "./watchlist";

const shopSeries = {
  metadata: {
    symbol: "SHOP.TO",
    companyName: "Shopify Inc.",
    exchange: "TOR",
    currency: "CAD",
    instrumentType: "EQUITY" as const,
  },
  bars: [{ date: "2026-07-08", close: 174.45, adjustedClose: 174.45 }],
  corporateActionDates: new Set<string>(),
};

describe("WatchlistService", () => {
  it("normalizes a Canadian symbol and stores provider metadata", async () => {
    const repository = {
      countActive: vi.fn(async () => 2),
      findBySymbol: vi.fn(async () => null),
      insert: vi.fn(async () => undefined),
      restore: vi.fn(async () => undefined),
    };
    const market = { getInstrument: vi.fn(async () => shopSeries) };
    const service = new WatchlistService(repository, market, () => "ticker-id");
    await service.add(" shop.to ", "2026-07-09T22:00:00.000Z");
    expect(repository.insert).toHaveBeenCalledWith({
      id: "ticker-id",
      symbol: "SHOP.TO",
      companyName: "Shopify Inc.",
      exchange: "TOR",
      currency: "CAD",
      now: "2026-07-09T22:00:00.000Z",
    });
  });

  it("rejects the 101st active ticker before calling Yahoo", async () => {
    const repository = {
      countActive: vi.fn(async () => 100),
      findBySymbol: vi.fn(async () => null),
      insert: vi.fn(),
      restore: vi.fn(),
    };
    const market = { getInstrument: vi.fn() };
    const service = new WatchlistService(repository, market, crypto.randomUUID);
    await expect(
      service.add("AAPL", "2026-07-09T22:00:00.000Z"),
    ).rejects.toMatchObject({ code: "watchlist_limit" });
    expect(market.getInstrument).not.toHaveBeenCalled();
  });

  it("requires a recent daily bar during provider validation", async () => {
    const repository = {
      countActive: vi.fn(async () => 0),
      findBySymbol: vi.fn(async () => null),
      insert: vi.fn(),
      restore: vi.fn(),
    };
    const market = {
      getInstrument: vi.fn(async () => ({ ...shopSeries, bars: [] })),
    };
    const service = new WatchlistService(repository, market, crypto.randomUUID);
    await expect(
      service.add("SHOP.TO", "2026-07-09T22:00:00.000Z"),
    ).rejects.toMatchObject({ code: "symbol_not_found" });
  });

  it("rejects a stale daily bar returned outside the requested validation window", async () => {
    const repository = {
      countActive: vi.fn(async () => 0),
      findBySymbol: vi.fn(async () => null),
      insert: vi.fn(),
      restore: vi.fn(),
    };
    const market = {
      getInstrument: vi.fn(async () => ({
        ...shopSeries,
        bars: [{ date: "2026-01-02", close: 100, adjustedClose: 100 }],
      })),
    };
    await expect(
      new WatchlistService(repository, market, () => crypto.randomUUID()).add(
        "SHOP.TO",
        "2026-07-09T22:00:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "symbol_not_found" });
  });

  it("rejects unsupported currency and instruments", async () => {
    const repository = {
      countActive: vi.fn(async () => 0),
      findBySymbol: vi.fn(async () => null),
      insert: vi.fn(),
      restore: vi.fn(),
    };
    const market = {
      getInstrument: vi.fn(async () => ({
        ...shopSeries,
        metadata: { ...shopSeries.metadata, currency: "EUR" },
      })),
    };
    await expect(
      new WatchlistService(repository, market, crypto.randomUUID).add(
        "SAP",
        "2026-07-09T22:00:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "unsupported_instrument" });
  });
});
