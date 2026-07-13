import { InstrumentRepository } from "../db/instruments";
import { TickerRepository } from "../db/tickers";
import type { MarketDataProvider } from "../providers/market-data";
import { WatchlistService } from "./watchlist";

export class TransactionInstrumentService {
  constructor(
    private readonly db: D1Database,
    private readonly market: MarketDataProvider,
    private readonly createId: () => string,
  ) {}

  async resolve(rawSymbol: string, now: string) {
    const instruments = new InstrumentRepository(this.db);
    const existing = await instruments.ensureForSymbol(rawSymbol, now);
    if (existing) return existing;

    const ticker = await new WatchlistService(
      new TickerRepository(this.db),
      this.market,
      this.createId,
    ).add(rawSymbol, now);
    return instruments.ensureForSymbol(ticker.symbol, now);
  }
}
