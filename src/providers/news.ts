export interface NewsSearchRequest {
  symbol: string;
  companyName: string;
  publishedAfter: string;
  publishedBefore: string;
}

export interface NewsItem {
  title: string;
  publisher: string;
  publishedAt: string;
  url: string;
  description?: string;
}

export interface NewsProvider {
  search(request: NewsSearchRequest): Promise<NewsItem[]>;
}
