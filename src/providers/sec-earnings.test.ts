import { describe, expect, it, vi } from "vitest";
import { SecEarningsHistoryProvider } from "./sec-earnings";

const directory = {
  fields: ["cik", "name", "ticker", "exchange"],
  data: [[51143, "International Business Machines", "IBM", "NYSE"]],
};

const submissions = (overrides?: {
  items?: string[];
  files?: Array<{ name: string; filingFrom: string; filingTo: string }>;
}) => ({
  cik: "0000051143",
  tickers: ["IBM"],
  filings: {
    recent: {
      accessionNumber: ["0000051143-26-000036", "0000051143-26-000037"],
      filingDate: ["2026-04-22", "2026-04-23"],
      reportDate: ["2026-04-22", "2026-03-31"],
      form: ["8-K", "10-Q"],
      items: overrides?.items ?? ["2.02,9.01", ""],
    },
    files: overrides?.files ?? [],
  },
});

const instrument = {
  instrumentId: "ibm-id",
  symbol: "IBM",
  providerSymbol: "IBM",
  exchange: "NYSE",
  currency: "USD" as const,
};

describe("SecEarningsHistoryProvider", () => {
  it("maps Item 2.02 reports to the corresponding fiscal period", async () => {
    const fetcher = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json(
          String(input).includes("company_tickers") ? directory : submissions(),
        ),
    );
    const result = await new SecEarningsHistoryProvider(
      "Stock Tracker contact@example.com",
      fetcher as typeof fetch,
      () => new Date("2026-07-13T12:00:00.000Z"),
    ).getEarningsHistory(instrument, "2026-01-01", "2026-07-13");

    expect(result.range).toMatchObject({
      provider: "sec-edgar-earnings",
      secCik: "0000051143",
      requestedStartDate: "2026-01-01",
      requestedEndDate: "2026-07-13",
    });
    expect(result.events).toEqual([
      expect.objectContaining({
        reportDate: "2026-04-22",
        fiscalDateEnding: "2026-03-31",
        epsEstimate: null,
        currency: "USD",
        providerEventId: "sec-edgar-earnings:0000051143:earnings:2026-03-31",
      }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": "Stock Tracker contact@example.com",
        }),
      }),
    );
  });

  it("falls back instead of crawling archived SEC submission shards", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input).includes("company_tickers")
          ? directory
          : submissions({
              files: [
                {
                  name: "CIK0000051143-submissions-001.json",
                  filingFrom: "2015-01-01",
                  filingTo: "2025-12-31",
                },
              ],
            }),
      ),
    );
    await expect(
      new SecEarningsHistoryProvider(
        "Stock Tracker contact@example.com",
        fetcher as typeof fetch,
      ).getEarningsHistory(instrument, "2020-01-01", "2026-07-13"),
    ).rejects.toThrow("provider_history_archived");
  });

  it("rejects partial SEC matches so Alpha can supply a complete snapshot", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input).includes("company_tickers")
          ? directory
          : submissions({ items: ["9.01", ""] }),
      ),
    );
    await expect(
      new SecEarningsHistoryProvider(
        "Stock Tracker contact@example.com",
        fetcher as typeof fetch,
      ).getEarningsHistory(instrument, "2026-01-01", "2026-07-13"),
    ).rejects.toThrow("provider_history_unavailable");
  });

  it("rejects a snapshot when one of several fiscal periods has no Item 2.02", async () => {
    const partial = submissions();
    partial.filings.recent.accessionNumber.push("0000051143-26-000004");
    partial.filings.recent.filingDate.push("2026-02-24");
    partial.filings.recent.reportDate.push("2025-12-31");
    partial.filings.recent.form.push("10-K");
    partial.filings.recent.items.push("");
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input).includes("company_tickers") ? directory : partial,
      ),
    );

    await expect(
      new SecEarningsHistoryProvider(
        "Stock Tracker contact@example.com",
        fetcher as typeof fetch,
      ).getEarningsHistory(instrument, "2026-01-01", "2026-07-13"),
    ).rejects.toThrow("provider_history_unavailable");
  });
});
