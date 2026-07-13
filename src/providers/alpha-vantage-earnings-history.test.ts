import { describe, expect, it, vi } from "vitest";
import { AlphaVantageEarningsHistoryProvider } from "./alpha-vantage-earnings-history";

const instrument = {
  instrumentId: "ibm-id",
  symbol: "IBM",
  providerSymbol: "IBM",
  exchange: "NYSE",
  currency: "USD" as const,
};

describe("AlphaVantageEarningsHistoryProvider", () => {
  it("preserves exact estimates and accepts unavailable estimates", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL) =>
      Response.json({
        symbol: "IBM",
        quarterlyEarnings: [
          {
            fiscalDateEnding: "2026-03-31",
            reportedDate: "2026-04-22",
            estimatedEPS: "1.8100",
            reportTime: "post-market",
          },
          {
            fiscalDateEnding: "2025-12-31",
            reportedDate: "2026-01-28",
            estimatedEPS: "None",
            reportTime: "",
          },
        ],
      }),
    );
    const result = await new AlphaVantageEarningsHistoryProvider(
      "key",
      fetcher as typeof fetch,
      () => new Date("2026-07-13T12:00:00.000Z"),
    ).getEarningsHistory(instrument, "2026-01-01", "2026-07-13");

    expect(result.events).toEqual([
      expect.objectContaining({
        reportDate: "2026-01-28",
        epsEstimate: null,
        timeOfDay: null,
      }),
      expect.objectContaining({
        reportDate: "2026-04-22",
        epsEstimate: "1.81",
        timeOfDay: "post-market",
      }),
    ]);
    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.searchParams.get("function")).toBe("EARNINGS");
  });

  it("classifies daily quota responses returned with HTTP 200", async () => {
    const provider = new AlphaVantageEarningsHistoryProvider(
      "key",
      vi.fn(async () =>
        Response.json({ Information: "25 requests per day" }),
      ) as typeof fetch,
    );
    await expect(
      provider.getEarningsHistory(instrument, "2026-01-01", "2026-07-13"),
    ).rejects.toMatchObject({
      message: "provider_daily_limit",
      providerMessage: "25 requests per day",
    });
  });
});
