import { describe, expect, it, vi } from "vitest";
import { YahooDividendEventProvider } from "./yahoo-dividends";

describe("YahooDividendEventProvider", () => {
  it("normalizes bounded dividend events with currency and a source link", async () => {
    const eventDate = Math.floor(
      Date.parse("2026-02-09T14:30:00.000Z") / 1_000,
    );
    const fetcher = vi.fn(function (this: unknown, _input: RequestInfo | URL) {
      expect(this).toBeUndefined();
      return Promise.resolve(
        Response.json({
          chart: {
            result: [
              {
                meta: { symbol: "AAPL", currency: "USD" },
                events: {
                  dividends: {
                    [eventDate]: { amount: 0.26, date: eventDate },
                  },
                },
              },
            ],
            error: null,
          },
        }),
      );
    });
    const provider = new YahooDividendEventProvider(
      fetcher as typeof fetch,
      () => new Date("2026-07-12T12:00:00.000Z"),
    );

    const result = await provider.getDividends(
      "aapl",
      "2026-01-01",
      "2026-12-31",
    );

    expect(result.events).toEqual([
      expect.objectContaining({
        symbol: "AAPL",
        exDate: "2026-02-09",
        amount: "0.26",
        currency: "USD",
        provider: "yahoo-dividends",
        providerEventId: "yahoo-dividends:AAPL:dividend:2026-02-09",
        sourceUrl: "https://finance.yahoo.com/quote/AAPL/history/?filter=div",
      }),
    ]);
    expect(result.range).toEqual(
      expect.objectContaining({
        basis: "source-reported",
        isComplete: false,
        observedAt: "2026-07-12T12:00:00.000Z",
      }),
    );
    const requested = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requested.searchParams.get("events")).toBe("div");
  });

  it("rejects unavailable and mismatched symbols", async () => {
    const unavailable = new YahooDividendEventProvider(
      vi.fn(async () =>
        Response.json({ chart: { result: null } }),
      ) as typeof fetch,
    );
    await expect(
      unavailable.getDividends("AAPL", "2026-01-01", "2026-12-31"),
    ).rejects.toThrow("provider_symbol_unavailable");

    const mismatched = new YahooDividendEventProvider(
      vi.fn(async () =>
        Response.json({
          chart: {
            result: [{ meta: { symbol: "MSFT", currency: "USD" }, events: {} }],
          },
        }),
      ) as typeof fetch,
    );
    await expect(
      mismatched.getDividends("AAPL", "2026-01-01", "2026-12-31"),
    ).rejects.toThrow("provider_symbol_mismatch");
  });
});
