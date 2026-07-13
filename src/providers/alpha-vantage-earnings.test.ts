import { describe, expect, it, vi } from "vitest";
import {
  AlphaVantageEarningsProvider,
  alphaVantageSymbol,
} from "./alpha-vantage-earnings";

const instruments = [
  {
    instrumentId: "ibm",
    symbol: "IBM",
    providerSymbol: "IBM",
    exchange: "NYSE",
  },
  {
    instrumentId: "shop",
    symbol: "SHOP.TO",
    providerSymbol: "SHOP.TO",
    exchange: "TSX",
  },
];

describe("AlphaVantageEarningsProvider", () => {
  it("parses the bounded bulk CSV and maps Canadian provider symbols", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(
          "\uFEFFsymbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\r\n" +
            'IBM,"International Business Machines, Corp",2026-07-22,2026-06-30,3.0200,USD,post-market\r\n' +
            "SHOP.TRT,Shopify,2026-08-05,2026-06-30,,CAD,pre-market\r\n" +
            "OTHER,Other Corp,2026-08-06,2026-06-30,1.2,USD,post-market\r\n",
        ),
    );
    const result = await new AlphaVantageEarningsProvider(
      "test-key",
      fetcher,
      () => new Date("2026-07-13T12:00:00.000Z"),
    ).getEarningsCalendar(instruments, "2026-07-13", "2026-10-13");

    expect(result.events).toEqual([
      expect.objectContaining({
        instrumentId: "ibm",
        symbol: "IBM",
        reportDate: "2026-07-22",
        epsEstimate: "3.0200",
        timeOfDay: "post-market",
      }),
      expect.objectContaining({
        instrumentId: "shop",
        symbol: "SHOP.TO",
        epsEstimate: null,
        currency: "CAD",
      }),
    ]);
    expect(result.range).toMatchObject({
      requestedStartDate: "2026-07-13",
      requestedEndDate: "2026-10-13",
      provider: "alpha-vantage-earnings",
    });
    const request = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(request.searchParams.get("function")).toBe("EARNINGS_CALENDAR");
    expect(request.searchParams.get("horizon")).toBe("3month");
    expect(request.searchParams.get("symbol")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(alphaVantageSymbol("SHOP.TO")).toBe("SHOP.TRT");
    expect(alphaVantageSymbol("ABC.V")).toBe("ABC.TRV");
    expect(alphaVantageSymbol("ibm")).toBe("IBM");
  });

  it("rejects malformed headers, matched rows, and conflicting revisions", async () => {
    const provider = (body: string) =>
      new AlphaVantageEarningsProvider(
        "test-key",
        async () => new Response(body),
      );
    await expect(
      provider("symbol,wrong\nIBM,value\n").getEarningsCalendar(
        instruments,
        "2026-07-13",
        "2026-10-13",
      ),
    ).rejects.toThrow("provider_schema");
    await expect(
      provider(
        "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n" +
          "IBM,IBM,2026-02-30,2026-06-30,3,USD,post-market\n",
      ).getEarningsCalendar(instruments, "2026-01-01", "2026-10-13"),
    ).rejects.toThrow("provider_schema");
    await expect(
      provider(
        "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay\n" +
          "IBM,IBM,2026-07-22,2026-06-30,3,USD,post-market\n" +
          "IBM,IBM,2026-07-23,2026-06-30,4,USD,post-market\n",
      ).getEarningsCalendar(instruments, "2026-07-13", "2026-10-13"),
    ).rejects.toThrow("provider_conflicting_revision");
  });

  it("preserves response bounds and provider HTTP failures", async () => {
    const oversized = new AlphaVantageEarningsProvider(
      "test-key",
      async () =>
        new Response("small", {
          headers: { "Content-Length": "2000001" },
        }),
    );
    await expect(
      oversized.getEarningsCalendar(instruments, "2026-07-13", "2026-10-13"),
    ).rejects.toThrow("provider_response_too_large");

    const unavailable = new AlphaVantageEarningsProvider(
      "test-key",
      async () => new Response("limited", { status: 429 }),
    );
    await expect(
      unavailable.getEarningsCalendar(instruments, "2026-07-13", "2026-10-13"),
    ).rejects.toThrow("provider_http_429");
  });

  it("classifies JSON notices returned by the CSV endpoint", async () => {
    const provider = new AlphaVantageEarningsProvider("test-key", async () =>
      Response.json({
        Information: "This premium endpoint requires a subscription.",
      }),
    );
    await expect(
      provider.getEarningsCalendar(instruments, "2026-07-13", "2026-10-13"),
    ).rejects.toMatchObject({
      message: "provider_entitlement",
      providerMessage: "This premium endpoint requires a subscription.",
    });
  });
});
