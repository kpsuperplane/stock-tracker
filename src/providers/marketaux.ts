import type { NewsItem, NewsProvider, NewsSearchRequest } from "./news";

interface MarketauxArticle {
  title?: unknown;
  description?: unknown;
  source?: unknown;
  published_at?: unknown;
  url?: unknown;
}

interface MarketauxResponse {
  data?: unknown;
}

const cleanText = (value: string, limit: number) =>
  value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);

const requestTimestamp = (value: string) =>
  new Date(value).toISOString().slice(0, 19);

const baseSymbol = (symbol: string) => symbol.split(".")[0] ?? symbol;

const publisherFrom = (article: MarketauxArticle) => {
  if (typeof article.source === "string" && article.source.trim()) {
    return cleanText(article.source, 200);
  }
  try {
    return new URL(String(article.url)).hostname.replace(/^www\./, "");
  } catch {
    return "Unknown publisher";
  }
};

export class MarketauxNewsProvider implements NewsProvider {
  constructor(
    private readonly apiToken: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async search(request: NewsSearchRequest): Promise<NewsItem[]> {
    const url = new URL("https://api.marketaux.com/v1/news/all");
    url.searchParams.set("api_token", this.apiToken);
    url.searchParams.set("symbols", baseSymbol(request.symbol));
    url.searchParams.set("language", "en");
    url.searchParams.set(
      "published_after",
      requestTimestamp(request.publishedAfter),
    );
    url.searchParams.set(
      "published_before",
      requestTimestamp(request.publishedBefore),
    );
    url.searchParams.set("sort", "published_at");
    url.searchParams.set("limit", "3");

    const fetcher = this.fetcher;
    const response = await fetcher(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`news_http_${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 2_000_000) throw new Error("news_response_too_large");

    const payload = (await response.json()) as MarketauxResponse;
    if (!Array.isArray(payload.data)) throw new Error("news_schema");

    const start = Date.parse(request.publishedAfter);
    const end = Date.parse(request.publishedBefore);
    const seen = new Set<string>();
    const results: NewsItem[] = [];
    for (const value of payload.data) {
      const article = value as MarketauxArticle;
      if (
        typeof article.title !== "string" ||
        typeof article.published_at !== "string" ||
        typeof article.url !== "string"
      ) {
        continue;
      }
      const timestamp = Date.parse(article.published_at);
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) {
        continue;
      }
      const title = cleanText(article.title, 500);
      const key = `${title.toLowerCase()}|${article.url}`;
      if (!title || seen.has(key)) continue;
      seen.add(key);
      const description =
        typeof article.description === "string"
          ? cleanText(article.description, 1_000)
          : "";
      results.push({
        title,
        publisher: publisherFrom(article),
        publishedAt: new Date(timestamp).toISOString(),
        url: article.url,
        ...(description ? { description } : {}),
      });
    }
    return results.slice(0, 3);
  }
}
