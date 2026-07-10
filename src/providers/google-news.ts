import { XMLParser } from "fast-xml-parser";
import type { NewsItem, NewsProvider, NewsSearchRequest } from "./news";

interface RssItem {
  title?: string;
  link?: string;
  pubDate?: string;
  description?: string;
  source?: string | { "#text"?: string };
}

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const publisher = (source: RssItem["source"]) =>
  typeof source === "string"
    ? source
    : (source?.["#text"] ?? "Unknown publisher");

const headlineKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/\s+-\s+[^-]+$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const normalizeUrl = (raw: string) => {
  try {
    const url = new URL(raw);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || ["gclid", "fbclid"].includes(key)) {
        url.searchParams.delete(key);
      }
    }
    return url.toString();
  } catch {
    return raw;
  }
};

const textOnly = (value: string) =>
  value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1_000);

const relevant = (item: RssItem, request: NewsSearchRequest) => {
  const haystack = `${item.title ?? ""} ${item.description ?? ""}`.toLowerCase();
  const symbol = request.symbol.split(".")[0]?.toLowerCase() ?? "";
  const companyWords = request.companyName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 4 && !["inc", "corp", "ltd"].includes(word));
  return Boolean(
    (symbol && haystack.includes(symbol)) ||
      companyWords.some((word) => haystack.includes(word)),
  );
};

export class GoogleNewsProvider implements NewsProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async search(request: NewsSearchRequest): Promise<NewsItem[]> {
    const after = request.publishedAfter.slice(0, 10);
    const beforeDate = new Date(Date.parse(request.publishedBefore) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const query = `"${request.companyName}" OR ${request.symbol} after:${after} before:${beforeDate}`;
    const url = new URL("https://news.google.com/rss/search");
    url.searchParams.set("q", query);
    url.searchParams.set("hl", "en-CA");
    url.searchParams.set("gl", "CA");
    url.searchParams.set("ceid", "CA:en");
    const response = await this.fetcher(url, {
      headers: { "User-Agent": "stock-movement-explainer/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`news_http_${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 2_000_000) throw new Error("news_response_too_large");
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(
      await response.text(),
    ) as { rss?: { channel?: { item?: RssItem | RssItem[] } } };
    if (!parsed.rss?.channel) throw new Error("news_schema");

    const start = Date.parse(request.publishedAfter);
    const end = Date.parse(request.publishedBefore);
    const seenHeadlines = new Set<string>();
    const seenUrls = new Set<string>();
    const results: NewsItem[] = [];
    for (const item of asArray(parsed.rss.channel.item)) {
      if (!item.title || !item.link || !item.pubDate || !relevant(item, request)) {
        continue;
      }
      const timestamp = Date.parse(item.pubDate);
      if (!Number.isFinite(timestamp) || timestamp < start || timestamp > end) {
        continue;
      }
      const publishedAt = new Date(timestamp).toISOString();
      const title = textOnly(item.title).slice(0, 500);
      const headline = headlineKey(title);
      const normalizedUrl = normalizeUrl(item.link);
      if (seenHeadlines.has(headline) || seenUrls.has(normalizedUrl)) continue;
      seenHeadlines.add(headline);
      seenUrls.add(normalizedUrl);
      const description = item.description
        ? textOnly(item.description)
        : undefined;
      results.push({
        title,
        publisher: publisher(item.source).slice(0, 200),
        publishedAt,
        url: normalizedUrl,
        ...(description ? { description } : {}),
      });
    }

    const recent = results.sort(
      (left, right) =>
        right.publishedAt.localeCompare(left.publishedAt) ||
        left.publisher.localeCompare(right.publisher),
    );
    const firstByPublisher: NewsItem[] = [];
    const remaining: NewsItem[] = [];
    const publisherCounts = new Map<string, number>();
    for (const item of recent) {
      const count = publisherCounts.get(item.publisher) ?? 0;
      publisherCounts.set(item.publisher, count + 1);
      if (count === 0) firstByPublisher.push(item);
      else if (count === 1) remaining.push(item);
    }
    return [...firstByPublisher, ...remaining].slice(0, 10);
  }
}
