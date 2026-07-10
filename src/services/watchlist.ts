import type { TickerRepository } from "../db/tickers";
import type { MarketDataProvider } from "../providers/market-data";
import { ApiError } from "../worker/errors";

type Repository = Pick<
  TickerRepository,
  "countActive" | "findBySymbol" | "insert" | "restore"
>;

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

export class WatchlistService {
  constructor(
    private readonly repository: Repository,
    private readonly market: MarketDataProvider,
    private readonly createId: () => string,
  ) {}

  async add(rawSymbol: string, now: string) {
    const symbol = rawSymbol.trim().toUpperCase();
    if (!/^[A-Z0-9.-]{1,20}$/.test(symbol)) {
      throw new ApiError(422, "invalid_symbol", "Enter a valid Yahoo symbol.");
    }
    if ((await this.repository.countActive()) >= 100) {
      throw new ApiError(
        422,
        "watchlist_limit",
        "The watchlist is limited to 100 active symbols.",
      );
    }
    const existing = await this.repository.findBySymbol(symbol);
    if (existing && existing.deletedAt === null) {
      throw new ApiError(
        409,
        "duplicate_symbol",
        `${symbol} is already stored.`,
      );
    }

    let series;
    try {
      const today = now.slice(0, 10);
      series = await this.market.getInstrument(
        symbol,
        addDays(today, -10),
        today,
      );
    } catch {
      throw new ApiError(
        422,
        "symbol_not_found",
        `Yahoo Finance could not validate ${symbol}.`,
      );
    }
    const hasRecentBar = series.bars.some(
      (bar) =>
        bar.date <= now.slice(0, 10) &&
        ((bar.adjustedClose !== null && bar.adjustedClose > 0) ||
          (bar.close !== null && bar.close > 0)),
    );
    if (!hasRecentBar) {
      throw new ApiError(
        422,
        "symbol_not_found",
        `Yahoo Finance could not validate ${symbol}.`,
      );
    }
    if (
      !["EQUITY", "ETF"].includes(series.metadata.instrumentType) ||
      !["USD", "CAD"].includes(series.metadata.currency)
    ) {
      throw new ApiError(
        422,
        "unsupported_instrument",
        "Only US and Canadian stocks and ETFs are supported.",
      );
    }

    const canonicalExisting =
      series.metadata.symbol === symbol
        ? existing
        : await this.repository.findBySymbol(series.metadata.symbol);
    if (canonicalExisting && canonicalExisting.deletedAt === null) {
      throw new ApiError(
        409,
        "duplicate_symbol",
        `${series.metadata.symbol} is already stored.`,
      );
    }
    const ticker = {
      id: canonicalExisting?.id ?? this.createId(),
      symbol: series.metadata.symbol,
      companyName: series.metadata.companyName,
      exchange: series.metadata.exchange,
      currency: series.metadata.currency,
      now,
    };
    if (canonicalExisting) await this.repository.restore(ticker);
    else await this.repository.insert(ticker);
    return ticker;
  }
}
