import { z } from "zod";
import type {
  DividendEventRange,
  DividendProvider,
  NormalizedDividendEvent,
} from "./dividends";
import { isIsoCalendarDate, readBoundedJson } from "./provider-http";

const provider = "yahoo-dividends";

const dividendSchema = z.object({
  amount: z.number().finite().nonnegative(),
  date: z.number().int(),
});

const chartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({
            symbol: z.string().min(1),
            currency: z.string().regex(/^[A-Z]{3}$/),
          }),
          events: z
            .object({
              dividends: z.record(z.string(), dividendSchema).optional(),
            })
            .optional(),
        }),
      )
      .nullable(),
  }),
});

const epoch = (date: string): number =>
  Math.floor(Date.parse(`${date}T00:00:00.000Z`) / 1_000);

const isoDate = (seconds: number): string =>
  new Date(seconds * 1_000).toISOString().slice(0, 10);

const sourceUrl = (symbol: string): string =>
  `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/history/?filter=div`;

const assertRange = (startDate: string, endDate: string): void => {
  if (
    !isIsoCalendarDate(startDate) ||
    !isIsoCalendarDate(endDate) ||
    startDate > endDate
  ) {
    throw new Error("provider_invalid_range");
  }
};

export class YahooDividendEventProvider implements DividendProvider {
  constructor(
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getDividends(
    symbol: string,
    startDate: string,
    endDate: string,
  ): Promise<DividendEventRange> {
    assertRange(startDate, endDate);
    const url = new URL(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
    );
    url.searchParams.set("period1", String(epoch(startDate)));
    url.searchParams.set("period2", String(epoch(endDate) + 86_400));
    url.searchParams.set("interval", "1d");
    url.searchParams.set("events", "div");

    const response = await this.fetcher(url, {
      headers: { "User-Agent": "stock-movement-explainer/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`provider_http_${response.status}`);

    let payload: z.infer<typeof chartSchema>;
    try {
      payload = chartSchema.parse(await readBoundedJson(response));
    } catch {
      throw new Error("provider_schema");
    }
    const result = payload.chart.result?.[0];
    if (!result) throw new Error("provider_symbol_unavailable");
    const normalizedSymbol = result.meta.symbol.toUpperCase();
    if (normalizedSymbol !== symbol.toUpperCase()) {
      throw new Error("provider_symbol_mismatch");
    }

    const events: NormalizedDividendEvent[] = Object.values(
      result.events?.dividends ?? {},
    )
      .map((dividend) => {
        const exDate = isoDate(dividend.date);
        const amount = String(dividend.amount);
        return {
          type: "dividend" as const,
          symbol: normalizedSymbol,
          exDate,
          amount,
          currency: result.meta.currency,
          provider,
          providerEventId: `${provider}:${normalizedSymbol}:dividend:${exDate}`,
          providerRevision: `${exDate}|${amount}|${result.meta.currency}`,
          sourceUrl: sourceUrl(normalizedSymbol),
        };
      })
      .filter((event) => event.exDate >= startDate && event.exDate <= endDate)
      .sort((left, right) => left.exDate.localeCompare(right.exDate));

    return {
      symbol: normalizedSymbol,
      range: {
        requestedStartDate: startDate,
        requestedEndDate: endDate,
        coverageStartDate: null,
        coverageEndDate: null,
        isComplete: false,
        basis: "source-reported",
        provider,
        observedAt: this.now().toISOString(),
        providerRevision: [
          provider,
          normalizedSymbol,
          startDate,
          endDate,
          ...events.map((event) => event.providerRevision),
        ].join("|"),
      },
      events,
    };
  }
}
