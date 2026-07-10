import { describe, expect, it, vi } from "vitest";
import { ExaNewsProvider } from "./exa";

const request = {
  symbol: "SHOP.TO",
  companyName: "Shopify Inc.",
  publishedAfter: "2026-07-08T20:00:00.000Z",
  publishedBefore: "2026-07-09T22:00:00.000Z",
};

describe("ExaNewsProvider", () => {
  it("searches news with the exact publication window and maps highlights", async () => {
    const fetcher = vi.fn(
      async (_input: URL | RequestInfo, _init?: RequestInit) =>
        Response.json({
          results: [
            {
              title: "Shopify gains after an analyst upgrade",
              url: "https://www.reuters.com/markets/shopify-upgrade",
              publishedDate: "2026-07-09T18:00:00.000Z",
              highlights: [
                "Shopify shares rose after an analyst increased its target.",
                "The report cited improving enterprise demand.",
              ],
            },
            {
              title: "Outside the requested window",
              url: "https://example.com/outside",
              publishedDate: "2026-07-10T18:00:00.000Z",
              highlights: ["Too late"],
            },
          ],
        }),
    );

    const items = await new ExaNewsProvider("secret-key", fetcher).search(
      request,
    );

    const [input, init] = fetcher.mock.calls[0] ?? [];
    expect(String(input)).toBe("https://api.exa.ai/search");
    expect(new Headers(init?.headers).get("x-api-key")).toBe("secret-key");
    expect(JSON.parse(String(init?.body))).toEqual({
      query: '"Shopify Inc." SHOP.TO stock price company news',
      type: "auto",
      category: "news",
      numResults: 5,
      startPublishedDate: request.publishedAfter,
      endPublishedDate: request.publishedBefore,
      contents: { highlights: true },
    });
    expect(items).toEqual([
      {
        title: "Shopify gains after an analyst upgrade",
        publisher: "reuters.com",
        publishedAt: "2026-07-09T18:00:00.000Z",
        url: "https://www.reuters.com/markets/shopify-upgrade",
        description:
          "Shopify shares rose after an analyst increased its target. The report cited improving enterprise demand.",
      },
    ]);
  });

  it("does not rebind the fetcher this value", async () => {
    const fetcher = vi.fn(function (this: unknown) {
      if (this !== undefined) throw new TypeError("illegal invocation");
      return Promise.resolve(Response.json({ results: [] }));
    });

    await expect(
      new ExaNewsProvider("secret-key", fetcher).search(request),
    ).resolves.toEqual([]);
  });

  it("rejects malformed responses", async () => {
    const provider = new ExaNewsProvider(
      "secret-key",
      vi.fn(async () => Response.json({ results: "not-an-array" })),
    );

    await expect(provider.search(request)).rejects.toThrow("news_schema");
  });
});
