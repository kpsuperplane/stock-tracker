import { describe, expect, it, vi } from "vitest";
import { ApiClientError, eventImportsApi, eventsApi } from "./api";

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
      "/api/events?symbol=+aapl+&type=transaction&limit=25",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("does not override multipart boundaries for CSV preview", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          kind: "preview",
          batchId: "batch-1",
          basePositionBasisRevision: 1,
          rows: [],
          reviews: [],
          projectedHoldings: {},
          expiresAt: "2026-07-12T00:00:00.000Z",
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(
      ["trade_date,symbol,side,quantity,price\n"],
      "events.csv",
      {
        type: "text/csv",
      },
    );

    await eventImportsApi.preview(file);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("X-Stock-Tracker-Request")).toBe("1");
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
    expect(init.body).toBeInstanceOf(FormData);
  });

  it("retains conflict codes and response details for split review UI", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: "split_review_required",
            message: "Review split history.",
          },
          review: { symbol: "AAPL", range: {}, events: [] },
          positionBasisRevision: 4,
        }),
        { status: 409, headers: { ETag: '"position-basis-4"' } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await eventsApi
      .create(
        {
          instrumentId: "instrument-1",
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
      code: "split_review_required",
      details: { positionBasisRevision: 4 },
    });
  });
});
