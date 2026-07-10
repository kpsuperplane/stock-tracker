import { z } from "zod";
import type { DailySeries, MarketDataProvider } from "./market-data";

const resultSchema = z.object({
  meta: z.object({
    symbol: z.string(),
    longName: z.string().optional(),
    shortName: z.string().optional(),
    exchangeName: z.string(),
    currency: z.string(),
    instrumentType: z.enum(["EQUITY", "ETF"]),
  }),
  timestamp: z.array(z.number()),
  indicators: z.object({
    quote: z.array(z.object({ close: z.array(z.number().nullable()) })).min(1),
    adjclose: z
      .array(z.object({ adjclose: z.array(z.number().nullable()) }))
      .optional(),
  }),
  events: z
    .record(z.string(), z.record(z.string(), z.object({ date: z.number() })))
    .nullish(),
});

const chartSchema = z.object({
  chart: z.object({ result: z.array(resultSchema).min(1) }),
});

const epoch = (date: string) =>
  Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
const isoDate = (seconds: number) =>
  new Date(seconds * 1000).toISOString().slice(0, 10);

export class YahooMarketDataProvider implements MarketDataProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async getInstrument(
    symbol: string,
    startDate: string,
    endDate: string,
  ): Promise<DailySeries> {
    const url = new URL(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
    );
    url.searchParams.set("period1", String(epoch(startDate)));
    url.searchParams.set("period2", String(epoch(endDate) + 86_400));
    url.searchParams.set("interval", "1d");
    url.searchParams.set("events", "div,splits");
    const fetcher = this.fetcher;
    const response = await fetcher(url, {
      headers: { "User-Agent": "stock-movement-explainer/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`market_http_${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 2_000_000) throw new Error("market_response_too_large");
    const result = chartSchema.parse(await response.json()).chart.result[0];
    if (!result) throw new Error("market_schema");
    const adjusted = result.indicators.adjclose?.[0]?.adjclose ?? [];
    const closes = result.indicators.quote[0]?.close ?? [];
    const bars = result.timestamp.map((timestamp, index) => ({
      date: isoDate(timestamp),
      close: closes[index] ?? null,
      adjustedClose: adjusted[index] ?? null,
    }));
    const corporateActionDates = new Set(
      Object.values(result.events ?? {}).flatMap((group) =>
        Object.values(group).map((event) => isoDate(event.date)),
      ),
    );
    return {
      metadata: {
        symbol: result.meta.symbol.toUpperCase(),
        companyName:
          result.meta.longName ?? result.meta.shortName ?? result.meta.symbol,
        exchange: result.meta.exchangeName,
        currency: result.meta.currency,
        instrumentType: result.meta.instrumentType,
      },
      bars,
      corporateActionDates,
    };
  }
}
