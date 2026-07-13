import { z } from "zod";
import { canonicalizeDecimal } from "../domain/decimal";
import type {
  EarningsHistoryProvider,
  EarningsHistoryRange,
  EarningsInstrumentReference,
  NormalizedEarningsEvent,
} from "./earnings";
import { alphaVantageEarningsProvider } from "./alpha-vantage-earnings";
import { alphaVantageSymbol } from "./alpha-vantage-earnings";
import { isIsoCalendarDate, readBoundedJson } from "./provider-http";

const decimal = z.string().refine((value) => {
  if (value === "" || value === "None") return true;
  try {
    canonicalizeDecimal(value);
    return true;
  } catch {
    return false;
  }
});

const historySchema = z.object({
  symbol: z.string().min(1),
  quarterlyEarnings: z.array(
    z.object({
      fiscalDateEnding: z.string().refine(isIsoCalendarDate),
      reportedDate: z.string().refine(isIsoCalendarDate),
      estimatedEPS: decimal,
      reportTime: z.string().max(40).optional().default(""),
    }),
  ),
});

export class AlphaVantageEarningsHistoryProvider
  implements EarningsHistoryProvider
{
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getEarningsHistory(
    instrument: EarningsInstrumentReference & { currency: "USD" | "CAD" },
    startDate: string,
    endDate: string,
  ): Promise<EarningsHistoryRange> {
    if (
      !isIsoCalendarDate(startDate) ||
      !isIsoCalendarDate(endDate) ||
      startDate > endDate
    ) {
      throw new Error("provider_invalid_range");
    }
    const symbol = alphaVantageSymbol(instrument.providerSymbol);
    const url = new URL("https://www.alphavantage.co/query");
    url.searchParams.set("function", "EARNINGS");
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("apikey", this.apiKey);
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`provider_http_${response.status}`);
    const raw = await readBoundedJson(response);
    if (
      typeof raw === "object" &&
      raw !== null &&
      ("Information" in raw || "Note" in raw)
    ) {
      throw new Error("provider_rate_limited");
    }
    let payload: z.infer<typeof historySchema>;
    try {
      payload = historySchema.parse(raw);
    } catch {
      throw new Error("provider_schema");
    }
    if (payload.symbol.toUpperCase() !== symbol) {
      throw new Error("provider_symbol_mismatch");
    }
    const events = payload.quarterlyEarnings
      .filter(
        (row) =>
          row.reportedDate >= startDate && row.reportedDate <= endDate,
      )
      .map((row): NormalizedEarningsEvent => {
        const estimate =
          row.estimatedEPS === "" || row.estimatedEPS === "None"
            ? null
            : canonicalizeDecimal(row.estimatedEPS);
        return {
          type: "earnings",
          instrumentId: instrument.instrumentId,
          symbol: instrument.symbol.toUpperCase(),
          reportDate: row.reportedDate,
          fiscalDateEnding: row.fiscalDateEnding,
          epsEstimate: estimate,
          currency: instrument.currency,
          timeOfDay: row.reportTime || null,
          provider: alphaVantageEarningsProvider,
          providerEventId: `${alphaVantageEarningsProvider}:${symbol}:earnings:${row.fiscalDateEnding}`,
          providerRevision: [
            row.reportedDate,
            row.fiscalDateEnding,
            estimate ?? "",
            instrument.currency,
            row.reportTime,
          ].join("|"),
        };
      })
      .sort((left, right) => left.reportDate.localeCompare(right.reportDate));
    const observedAt = this.now().toISOString();
    return {
      range: {
        requestedStartDate: startDate,
        requestedEndDate: endDate,
        provider: alphaVantageEarningsProvider,
        observedAt,
        providerRevision: [
          alphaVantageEarningsProvider,
          symbol,
          startDate,
          endDate,
          ...events.map((event) => event.providerRevision),
        ].join("|"),
        secCik: null,
      },
      events,
    };
  }
}
