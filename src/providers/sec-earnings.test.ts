import { describe, expect, it, vi } from "vitest";
import { SecEarningsHistoryProvider } from "./sec-earnings";

const directory = {
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [51143, "International Business Machines", "IBM", "NYSE"],
    [1109262, "Issuer without a listed exchange", "AGGI", null],
    [1070235, "BlackBerry Limited", "BB", "NYSE"],
    [937966, "ASML Holding N.V.", "ASML", "NASDAQ"],
  ],
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
    const fetcher = vi.fn(function (
      this: unknown,
      input: RequestInfo | URL,
      _init?: RequestInit,
    ) {
      expect(this).toBeUndefined();
      return Promise.resolve(
        Response.json(
          String(input).includes("company_tickers") ? directory : submissions(),
        ),
      );
    });
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

  it("loads archived SEC submission shards that overlap the requested range", async () => {
    const archived = {
      accessionNumber: ["0000051143-25-000036", "0000051143-25-000037"],
      filingDate: ["2025-01-22", "2025-01-23"],
      reportDate: ["2025-01-22", "2024-12-31"],
      form: ["8-K", "10-K"],
      items: ["2.02,9.01", ""],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("company_tickers")) return Response.json(directory);
      if (url.includes("submissions-001")) return Response.json(archived);
      return Response.json(
        submissions({
          files: [
            {
              name: "CIK0000051143-submissions-001.json",
              filingFrom: "2015-01-01",
              filingTo: "2025-12-31",
            },
          ],
        }),
      );
    });
    const result = await new SecEarningsHistoryProvider(
      "Stock Tracker contact@example.com",
      fetcher as typeof fetch,
    ).getEarningsHistory(instrument, "2020-01-01", "2026-07-13");

    expect(result.events.map((event) => event.fiscalDateEnding)).toEqual([
      "2024-12-31",
      "2026-03-31",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("uses a periodic filing when the issuer has no Item 2.02 release", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input).includes("company_tickers")
          ? directory
          : submissions({ items: ["9.01", ""] }),
      ),
    );
    const result = await new SecEarningsHistoryProvider(
      "Stock Tracker contact@example.com",
      fetcher as typeof fetch,
    ).getEarningsHistory(instrument, "2026-01-01", "2026-07-13");
    expect(result.range.complete).toBe(true);
    expect(result.events).toEqual([
      expect.objectContaining({
        reportDate: "2026-04-23",
        fiscalDateEnding: "2026-03-31",
      }),
    ]);
  });

  it("uses an in-range periodic filing when the release predates the range", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input).includes("company_tickers") ? directory : submissions(),
      ),
    );

    const result = await new SecEarningsHistoryProvider(
      "Stock Tracker contact@example.com",
      fetcher as typeof fetch,
    ).getEarningsHistory(instrument, "2026-04-23", "2026-07-13");

    expect(result.events).toEqual([
      expect.objectContaining({
        reportDate: "2026-04-23",
        fiscalDateEnding: "2026-03-31",
      }),
    ]);
  });

  it("combines release dates with periodic-filing fallback dates", async () => {
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

    const result = await new SecEarningsHistoryProvider(
      "Stock Tracker contact@example.com",
      fetcher as typeof fetch,
    ).getEarningsHistory(instrument, "2026-01-01", "2026-07-13");
    expect(result.range.complete).toBe(true);
    expect(result.events).toHaveLength(2);
    expect(result.events.map((event) => event.fiscalDateEnding)).toEqual([
      "2025-12-31",
      "2026-03-31",
    ]);
  });

  it("ignores an unmatched Item 2.02 filing without rejecting matched history", async () => {
    const payload = submissions();
    payload.filings.recent.accessionNumber.push("0000051143-26-000099");
    payload.filings.recent.filingDate.push("2026-06-01");
    payload.filings.recent.reportDate.push("2026-06-01");
    payload.filings.recent.form.push("8-K");
    payload.filings.recent.items.push("2.02,9.01");
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input).includes("company_tickers") ? directory : payload,
      ),
    );

    const result = await new SecEarningsHistoryProvider(
      "Stock Tracker contact@example.com",
      fetcher as typeof fetch,
    ).getEarningsHistory(instrument, "2026-01-01", "2026-07-13");

    expect(result.range.complete).toBe(true);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.fiscalDateEnding).toBe("2026-03-31");
  });

  it("uses foreign annual and qualifying interim reports without treating unrelated 6-K filings as earnings", async () => {
    const foreignSubmissions = {
      cik: "0000937966",
      tickers: ["ASML"],
      filings: {
        recent: {
          accessionNumber: ["annual", "quarter", "revenue", "agm"],
          filingDate: ["2026-02-25", "2026-04-15", "2026-04-10", "2026-04-23"],
          reportDate: ["2025-12-31", "2026-03-29", "2026-03-31", "2026-04-23"],
          form: ["20-F", "6-K", "6-K", "6-K"],
          items: ["", "", "", ""],
          primaryDocument: [
            "asml-20251231.htm",
            "form6-kquarterlyfilings.htm",
            "asml-revenue-20260331.htm",
            "form6-kagmdisclosure.htm",
          ],
          primaryDocDescription: ["20-F", "6-K", "6-K", "6-K"],
        },
        files: [],
      },
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input).includes("company_tickers")
          ? directory
          : foreignSubmissions,
      ),
    );
    const result = await new SecEarningsHistoryProvider(
      "Stock Tracker contact@example.com",
      fetcher as typeof fetch,
    ).getEarningsHistory(
      {
        ...instrument,
        instrumentId: "asml-id",
        symbol: "ASML",
        providerSymbol: "ASML",
      },
      "2026-01-01",
      "2026-07-13",
    );

    expect(result.range.complete).toBe(true);
    expect(result.events.map((event) => event.fiscalDateEnding)).toEqual([
      "2025-12-31",
      "2026-03-29",
    ]);
  });

  it("resolves a Toronto cross-list through its SEC base ticker", async () => {
    const blackberrySubmissions = {
      ...submissions(),
      cik: "0001070235",
      tickers: ["BB"],
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input).includes("company_tickers")
          ? directory
          : blackberrySubmissions,
      ),
    );
    const result = await new SecEarningsHistoryProvider(
      "Stock Tracker contact@example.com",
      fetcher as typeof fetch,
    ).getEarningsHistory(
      {
        ...instrument,
        instrumentId: "bb-to-id",
        symbol: "BB.TO",
        providerSymbol: "BB.TO",
        exchange: "TOR",
        currency: "CAD",
      },
      "2026-01-01",
      "2026-07-13",
    );

    expect(result.range.secCik).toBe("0001070235");
    expect(result.events).toEqual([
      expect.objectContaining({ instrumentId: "bb-to-id", currency: "CAD" }),
    ]);
  });

  it("marks an SEC snapshot with no supported report events incomplete", async () => {
    const empty = submissions({ items: ["", ""] });
    empty.filings.recent.form = ["S-8", "DEF 14A"];
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input).includes("company_tickers") ? directory : empty,
      ),
    );
    const result = await new SecEarningsHistoryProvider(
      "Stock Tracker contact@example.com",
      fetcher as typeof fetch,
    ).getEarningsHistory(instrument, "2026-01-01", "2026-07-13");

    expect(result.range.complete).toBe(false);
    expect(result.events).toEqual([]);
  });

  it("keeps annual-only foreign history partial so the fallback can fill interim reports", async () => {
    const annualOnly = {
      cik: "0000937966",
      tickers: ["ASML"],
      filings: {
        recent: {
          accessionNumber: ["annual"],
          filingDate: ["2026-02-25"],
          reportDate: ["2025-12-31"],
          form: ["20-F"],
          items: [""],
          primaryDocument: ["asml-20251231.htm"],
          primaryDocDescription: ["20-F"],
        },
        files: [],
      },
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      Response.json(
        String(input).includes("company_tickers") ? directory : annualOnly,
      ),
    );
    const result = await new SecEarningsHistoryProvider(
      "Stock Tracker contact@example.com",
      fetcher as typeof fetch,
    ).getEarningsHistory(
      {
        ...instrument,
        instrumentId: "asml-id",
        symbol: "ASML",
        providerSymbol: "ASML",
      },
      "2026-01-01",
      "2026-07-13",
    );

    expect(result.range.complete).toBe(false);
    expect(result.events).toHaveLength(1);
  });
});
