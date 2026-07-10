import type { NewsItem, NewsProvider, NewsSearchRequest } from "./news";

interface ExaResult {
  title?: unknown;
  url?: unknown;
  publishedDate?: unknown;
  highlights?: unknown;
}

interface ExaResponse {
  results?: unknown;
}

const cleanText = (value: string, limit: number) =>
  value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);

const publisherFrom = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").slice(0, 200);
  } catch {
    return "Unknown publisher";
  }
};

export class ExaNewsProvider implements NewsProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async search(request: NewsSearchRequest): Promise<NewsItem[]> {
    const fetcher = this.fetcher;
    const response = await fetcher("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({
        query: `"${request.companyName}" ${request.symbol} stock price company news`,
        type: "auto",
        category: "news",
        numResults: 5,
        startPublishedDate: request.publishedAfter,
        endPublishedDate: request.publishedBefore,
        contents: { highlights: true },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`news_http_${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 4_000_000) throw new Error("news_response_too_large");

    const payload = (await response.json()) as ExaResponse;
    if (!Array.isArray(payload.results)) throw new Error("news_schema");

    const start = Date.parse(request.publishedAfter);
    const end = Date.parse(request.publishedBefore);
    const seen = new Set<string>();
    const items: NewsItem[] = [];
    for (const value of payload.results) {
      const result = value as ExaResult;
      if (
        typeof result.title !== "string" ||
        typeof result.url !== "string" ||
        typeof result.publishedDate !== "string"
      ) {
        continue;
      }
      const timestamp = Date.parse(result.publishedDate);
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) {
        continue;
      }
      const title = cleanText(result.title, 500);
      const key = `${title.toLowerCase()}|${result.url}`;
      if (!title || seen.has(key)) continue;
      seen.add(key);
      const description = Array.isArray(result.highlights)
        ? cleanText(
            result.highlights
              .filter(
                (highlight): highlight is string =>
                  typeof highlight === "string",
              )
              .join(" "),
            2_000,
          )
        : "";
      items.push({
        title,
        publisher: publisherFrom(result.url),
        publishedAt: new Date(timestamp).toISOString(),
        url: result.url,
        ...(description ? { description } : {}),
      });
    }
    return items.slice(0, 5);
  }
}
