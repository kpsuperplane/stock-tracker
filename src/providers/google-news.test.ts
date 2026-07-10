import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { GoogleNewsProvider } from "./google-news";

describe("GoogleNewsProvider", () => {
  it("filters the exact window, irrelevant items, and duplicate headlines", async () => {
    const xml = await readFile("tests/fixtures/google-news/shop.xml", "utf8");
    const fetcher = vi.fn(async () => new Response(xml, { status: 200 }));
    const items = await new GoogleNewsProvider(fetcher).search({
      symbol: "SHOP.TO",
      companyName: "Shopify Inc.",
      publishedAfter: "2026-07-08T20:00:00.000Z",
      publishedBefore: "2026-07-09T22:00:00.000Z",
    });
    expect(items.map((item) => item.publisher)).toEqual([
      "BNN Bloomberg",
      "Reuters",
    ]);
    expect(items).toHaveLength(2);
    expect(items[1]?.description).toContain("enterprise growth");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("fails visibly when the feed is malformed", async () => {
    const provider = new GoogleNewsProvider(async () =>
      new Response("<rss><broken>", { status: 200 }),
    );
    await expect(
      provider.search({
        symbol: "SHOP.TO",
        companyName: "Shopify Inc.",
        publishedAfter: "2026-07-08T20:00:00.000Z",
        publishedBefore: "2026-07-09T22:00:00.000Z",
      }),
    ).rejects.toThrow("news_schema");
  });
});
