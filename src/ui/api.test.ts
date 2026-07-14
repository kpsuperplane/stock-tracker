import { describe, expect, it, vi } from "vitest";
import {
  ApiClientError,
  api,
  calendarApi,
  eventImportsApi,
  eventsApi,
  portfolioApi,
} from "./api";

describe("product event API clients", () => {
  it("keeps the position revision from timeline headers and serializes filters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          events: [],
          nextCursor: null,
          positionBasisRevision: 2,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-Position-Basis-Revision": "7",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const timeline = await eventsApi.list({
      symbol: " aapl ",
      type: "transaction",
      limit: 25,
    });

    expect(timeline.positionBasisRevision).toBe(7);
    expect(fetchMock).toHaveBeenCalledWith(
      "/data/ledger?symbol=+aapl+&type=transaction&limit=25",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
    expect(init.cache).toBe("no-store");
  });

  it("does not override multipart boundaries for asynchronous CSV import", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          importId: "batch-1",
          status: "pending",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(
      ["trade_date,symbol,side,quantity,price,category,account\n"],
      "events.csv",
      {
        type: "text/csv",
      },
    );

    await eventImportsApi.start(file);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("X-Stock-Tracker-Request")).toBe("1");
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.body as FormData).get("accountId")).toBeNull();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/event-imports");
  });

  it("retains API conflict codes and response details", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "ledger_conflict",
            message: "Reload and try again.",
          },
          positionBasisRevision: 4,
        }),
        { status: 409, headers: { ETag: '"position-basis-4"' } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await eventsApi
      .create(
        {
          symbol: "SHOP.TO",
          tradeDate: "2026-07-10",
          side: "buy",
          quantityDecimal: "1",
          priceDecimal: "100",
        },
        4,
      )
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      status: 409,
      code: "ledger_conflict",
      details: { positionBasisRevision: 4 },
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/transactions");
  });

  it("deletes transactions without a split-confirmation payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          transaction: null,
          deleted: true,
          positionBasisRevision: 5,
          pipelineJobId: "job-5",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await eventsApi.remove("tx-1", 4, 1);

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/transactions/tx-1");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it("uses the cached portfolio body for conditional 304 responses", async () => {
    portfolioApi.clearCache?.();
    const portfolio = {
      asOfDate: "2026-07-10",
      latestTradingDate: "2026-07-10",
      actualTradingDates: ["2026-07-10"],
      locale: "en" as const,
      positions: [],
      totals: { USD: "0", CAD: "0" },
      conflicts: [],
      freshness: "fresh" as const,
      nextCursor: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ portfolio }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: '"portfolio-1"',
            "X-Position-Basis-Revision": "3",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 304,
          headers: {
            ETag: '"portfolio-1"',
            "X-Position-Basis-Revision": "3",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const first = await portfolioApi.read({
      locale: "en",
      today: "2026-07-10",
    });
    const second = await portfolioApi.read({
      locale: "en",
      today: "2026-07-10",
    });

    expect(first.notModified).toBe(false);
    expect(second.notModified).toBe(true);
    expect(second.portfolio).toEqual(portfolio);
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(secondInit.headers).get("If-None-Match")).toBe(
      '"portfolio-1"',
    );
  });

  it("uses the cached calendar body for conditional 304 responses", async () => {
    calendarApi.clearCache?.();
    const calendar = {
      startDate: "2026-07-05",
      endDate: "2026-07-11",
      asOfDate: "2026-07-11",
      locale: "en" as const,
      actualTradingDates: ["2026-07-10"],
      movers: [],
      dividends: [],
      earnings: [],
      events: [],
      pending: [],
      pendingFacts: [],
      splitReview: [],
      futureDividendStatus: "not_currently_known" as const,
      earningsCoverageStatus: "unavailable" as const,
      conflicts: [],
      nextCursor: null,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ calendar }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ETag: '"calendar-1"',
            "X-Position-Basis-Revision": "4",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 304,
          headers: {
            ETag: '"calendar-1"',
            "X-Position-Basis-Revision": "4",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const options = {
      locale: "en" as const,
      view: "week" as const,
      startDate: "2026-07-05",
      endDate: "2026-07-11",
      asOfDate: "2026-07-11",
    };
    const first = await calendarApi.read(options);
    const second = await calendarApi.read(options);

    expect(first.notModified).toBe(false);
    expect(second.notModified).toBe(true);
    expect(second.calendar).toEqual(calendar);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/calendar?locale=en&view=week&startDate=2026-07-05&endDate=2026-07-11&asOfDate=2026-07-11",
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      expect.stringContaining("/api/calendar?"),
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(secondInit.headers).get("If-None-Match")).toBe(
      '"calendar-1"',
    );
  });

  it("reads normalized pipeline job progress with cursor parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          job: {
            id: "pipeline-1",
            triggerType: "ledger_reconciliation",
            requestedStartDate: null,
            requestedEndDate: null,
            priority: 100,
            status: "running",
            createdAt: "2026-07-11T00:00:00.000Z",
            updatedAt: "2026-07-11T00:00:00.000Z",
            progress: {
              workTotal: 1,
              workReused: 1,
              workSkipped: 0,
              workFetched: 0,
              workAnalyzed: 0,
              workProcessed: 1,
              workFailed: 0,
            },
            work: [],
            errors: [],
            nextCursor: null,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.job("pipeline-1", "cursor-2", 25);

    expect(result.job.triggerType).toBe("ledger_reconciliation");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/jobs/pipeline-1?cursor=cursor-2&limit=25",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("lists pipeline jobs with an opaque cursor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ jobs: [], nextCursor: "next-page" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.jobs(25, "cursor-2");

    expect(result).toEqual({ jobs: [], nextCursor: "next-page" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/jobs?limit=25&cursor=cursor-2",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("reads sync status and recent jobs together", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: {
            earningsCoverage: null,
            jobs: [],
            nextCursor: "next-page",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.status(25, "cursor-2");

    expect(result.status.nextCursor).toBe("next-page");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/status?limit=25&cursor=cursor-2",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });
});
