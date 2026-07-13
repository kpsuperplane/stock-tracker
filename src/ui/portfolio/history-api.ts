import type {
  AccountScopeSelection,
  PortfolioHistoryReadModelDto,
  PortfolioRangePreset,
  ReadModelLocale,
} from "../../shared/contracts";
import { requestWithMeta } from "../api";

export interface PortfolioHistoryReadOptions {
  locale: ReadModelLocale;
  scope?: AccountScopeSelection;
  range: PortfolioRangePreset;
  startDate?: string;
  endDate?: string;
}

export interface PortfolioHistoryReadResult {
  history: PortfolioHistoryReadModelDto | null;
  notModified: boolean;
  etag: string | null;
  positionBasisRevision: number | null;
}

export interface PortfolioHistoryApiClient {
  read: (
    options: PortfolioHistoryReadOptions,
  ) => Promise<PortfolioHistoryReadResult>;
  clearCache?: () => void;
}

interface CacheEntry {
  history: PortfolioHistoryReadModelDto;
  etag: string | null;
  positionBasisRevision: number | null;
}

const cache = new Map<string, CacheEntry>();

const queryFor = (options: PortfolioHistoryReadOptions): string => {
  const query = new URLSearchParams({
    locale: options.locale,
    range: options.range,
  });
  if (options.range === "custom") {
    if (options.startDate) query.set("startDate", options.startDate);
    if (options.endDate) query.set("endDate", options.endDate);
  }
  if (options.scope?.scopeType) query.set("scopeType", options.scope.scopeType);
  if (options.scope?.scopeId) query.set("scopeId", options.scope.scopeId);
  return `?${query.toString()}`;
};

export const portfolioHistoryApi: PortfolioHistoryApiClient = {
  read: async (options) => {
    const key = JSON.stringify(options);
    const cached = cache.get(key);
    const response = await requestWithMeta<{
      history: PortfolioHistoryReadModelDto;
    }>(
      `/api/portfolio/history${queryFor(options)}`,
      cached?.etag ? { headers: { "If-None-Match": cached.etag } } : undefined,
      { allowNotModified: true },
    );
    const etag = response.headers.get("ETag") ?? cached?.etag ?? null;
    const revisionHeader = response.headers.get("X-Position-Basis-Revision");
    const parsedRevision =
      revisionHeader === null ? null : Number(revisionHeader);
    const positionBasisRevision = Number.isSafeInteger(parsedRevision)
      ? parsedRevision
      : (cached?.positionBasisRevision ?? null);
    if (response.data === undefined) {
      return {
        history: cached?.history ?? null,
        notModified: true,
        etag,
        positionBasisRevision,
      };
    }
    const history = response.data.history;
    cache.set(key, { history, etag, positionBasisRevision });
    return { history, notModified: false, etag, positionBasisRevision };
  },
  clearCache: () => cache.clear(),
};
