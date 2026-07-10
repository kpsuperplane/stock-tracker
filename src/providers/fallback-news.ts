import type { NewsItem, NewsProvider, NewsSearchRequest } from "./news";

export class FallbackNewsProvider implements NewsProvider {
  constructor(
    private readonly primary: NewsProvider,
    private readonly fallback: NewsProvider,
  ) {}

  async search(request: NewsSearchRequest): Promise<NewsItem[]> {
    try {
      const results = await this.primary.search(request);
      if (results.length > 0) return results;
    } catch {
      // The fallback provider is responsible for surfacing its own failure.
    }
    return this.fallback.search(request);
  }
}
