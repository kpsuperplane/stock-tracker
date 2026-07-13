import { describe, expect, it, vi } from "vitest";
import type { PortfolioHistoryReadModelDto } from "../../shared/contracts";
import { portfolioHistoryApi } from "./history-api";

describe("portfolio history API", () => {
  it("serializes scope and range, then reuses the cached body on 304", async () => {
    portfolioHistoryApi.clearCache?.();
    const history: PortfolioHistoryReadModelDto = {
      range: "30d",
      startDate: "2026-06-11",
      endDate: "2026-07-10",
      dataThrough: "2026-07-10",
      locale: "en",
      currencies: [],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ history }), {
          status: 200,
          headers: { "Content-Type": "application/json", ETag: '"history-1"' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, { status: 304, headers: { ETag: '"history-1"' } }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const options = {
      locale: "en" as const,
      range: "30d" as const,
      scope: { scopeType: "account" as const, scopeId: "brokerage" },
    };

    const first = await portfolioHistoryApi.read(options);
    const second = await portfolioHistoryApi.read(options);

    expect(first.notModified).toBe(false);
    expect(second.notModified).toBe(true);
    expect(second.history).toEqual(history);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/portfolio/history?locale=en&range=30d&scopeType=account&scopeId=brokerage",
    );
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(secondInit.headers).get("If-None-Match")).toBe(
      '"history-1"',
    );
  });
});
