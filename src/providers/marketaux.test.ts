import { describe, expect, it, vi } from "vitest";
import { MarketauxNewsProvider } from "./marketaux";

const request = {
  symbol: "SHOP.TO",
  companyName: "Shopify Inc.",
  publishedAfter: "2026-07-08T20:00:00.000Z",
  publishedBefore: "2026-07-09T22:00:00.000Z",
};

describe("MarketauxNewsProvider", () => {
  it("requests the exact window and maps English company news", async () => {
    const fetcher = vi.fn(async (_input: URL | RequestInfo) =>
      Response.json({
        data: [
          {
            title: "Shopify gains after an analyst upgrade",
            description: "The shares rose after the price target increased.",
            source: "Reuters",
            published_at: "2026-07-09T18:00:00.000000Z",
            url: "https://example.com/shopify-upgrade",
          },
          {
            title: "Outside the requested window",
            source: "Example",
            published_at: "2026-07-10T18:00:00.000000Z",
            url: "https://example.com/outside",
          },
        ],
      }),
    );

    const items = await new MarketauxNewsProvider(
      "secret-token",
      fetcher,
    ).search(request);

    const url = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(url.origin + url.pathname).toBe(
      "https://api.marketaux.com/v1/news/all",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual(
      expect.objectContaining({
        api_token: "secret-token",
        symbols: "SHOP",
        language: "en",
        published_after: "2026-07-08T20:00:00",
        published_before: "2026-07-09T22:00:00",
        limit: "3",
      }),
    );
    expect(items).toEqual([
      {
        title: "Shopify gains after an analyst upgrade",
        description: "The shares rose after the price target increased.",
        publisher: "Reuters",
        publishedAt: "2026-07-09T18:00:00.000Z",
        url: "https://example.com/shopify-upgrade",
      },
    ]);
  });

  it("does not rebind the fetcher this value", async () => {
    const fetcher = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError("illegal invocation");
      return Promise.resolve(Response.json({ data: [] }));
    });

    await expect(
      new MarketauxNewsProvider("secret-token", fetcher).search(request),
    ).resolves.toEqual([]);
  });

  it("rejects malformed responses", async () => {
    const provider = new MarketauxNewsProvider(
      "secret-token",
      vi.fn(async () => Response.json({ data: "not-an-array" })),
    );

    await expect(provider.search(request)).rejects.toThrow("news_schema");
  });
});
