import { z } from "zod";
import type {
  DividendEventRange,
  DividendProvider,
  NormalizedDividendEvent,
} from "./dividends";
import { isIsoCalendarDate, readBoundedJson } from "./provider-http";

const provider = "alpha-vantage-dividends";
const amountPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

const optionalProviderDate = z
  .string()
  .refine((value) => value === "None" || isIsoCalendarDate(value));

const dividendSchema = z.object({
  ex_dividend_date: z.string().refine(isIsoCalendarDate),
  declaration_date: optionalProviderDate,
  record_date: optionalProviderDate,
  payment_date: optionalProviderDate,
  amount: z.string().regex(amountPattern),
});

const dividendsSchema = z.object({
  symbol: z.string().min(1),
  data: z.array(dividendSchema),
});

const overviewSchema = z.object({
  Symbol: z.string().min(1),
  Currency: z.enum(["USD", "CAD"]),
});

function assertRange(startDate: string, endDate: string): void {
  if (
    !isIsoCalendarDate(startDate) ||
    !isIsoCalendarDate(endDate) ||
    startDate > endDate
  ) {
    throw new Error("provider_invalid_range");
  }
}

function endpointUrl(
  functionName: "DIVIDENDS" | "OVERVIEW",
  symbol: string,
  apiKey: string,
): URL {
  const url = new URL("https://www.alphavantage.co/query");
  url.searchParams.set("function", functionName);
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("apikey", apiKey);
  return url;
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

export class AlphaVantageDividendEventProvider implements DividendProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getDividends(
    symbol: string,
    startDate: string,
    endDate: string,
    currency?: "USD" | "CAD",
  ): Promise<DividendEventRange> {
    assertRange(startDate, endDate);
    const request = async (functionName: "DIVIDENDS" | "OVERVIEW") => {
      const response = await this.fetcher(
        endpointUrl(functionName, symbol, this.apiKey),
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) throw new Error(`provider_http_${response.status}`);
      return readBoundedJson(response);
    };
    const rawDividends = await request("DIVIDENDS");
    const rawOverview = currency ? null : await request("OVERVIEW");
    if (
      isEmptyObject(rawDividends) ||
      (rawOverview !== null && isEmptyObject(rawOverview))
    ) {
      throw new Error("provider_symbol_unavailable");
    }

    let dividends: z.infer<typeof dividendsSchema>;
    let resolvedCurrency = currency;
    let overview: z.infer<typeof overviewSchema> | null = null;
    try {
      dividends = dividendsSchema.parse(rawDividends);
      if (rawOverview !== null) {
        overview = overviewSchema.parse(rawOverview);
        resolvedCurrency = overview.Currency;
      }
    } catch {
      throw new Error("provider_schema");
    }
    const normalizedSymbol = dividends.symbol.toUpperCase();
    if (
      normalizedSymbol !== symbol.toUpperCase() ||
      (overview !== null && overview.Symbol.toUpperCase() !== normalizedSymbol)
    ) {
      throw new Error("provider_symbol_mismatch");
    }
    if (!resolvedCurrency) throw new Error("provider_currency_unavailable");

    const byIdentity = new Map<string, NormalizedDividendEvent>();
    for (const dividend of dividends.data) {
      if (
        dividend.ex_dividend_date < startDate ||
        dividend.ex_dividend_date > endDate
      ) {
        continue;
      }
      const declarationIdentity =
        dividend.declaration_date === "None"
          ? "unknown-declaration"
          : dividend.declaration_date;
      const providerEventId = `${provider}:${normalizedSymbol}:dividend:${dividend.ex_dividend_date}:${declarationIdentity}`;
      const event: NormalizedDividendEvent = {
        type: "dividend",
        symbol: normalizedSymbol,
        exDate: dividend.ex_dividend_date,
        amount: dividend.amount,
        currency: resolvedCurrency,
        provider,
        providerEventId,
        providerRevision: [
          dividend.ex_dividend_date,
          dividend.declaration_date,
          dividend.record_date,
          dividend.payment_date,
          dividend.amount,
          resolvedCurrency,
        ].join("|"),
      };
      const existing = byIdentity.get(providerEventId);
      if (existing && existing.providerRevision !== event.providerRevision) {
        throw new Error("provider_conflicting_revision");
      }
      byIdentity.set(providerEventId, event);
    }

    const events = [...byIdentity.values()].sort((left, right) =>
      left.exDate.localeCompare(right.exDate),
    );

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
