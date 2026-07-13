import { z } from "zod";
import { parseCsv } from "../shared/csv";
import type {
  EarningsEventRange,
  EarningsInstrumentReference,
  EarningsProvider,
  NormalizedEarningsEvent,
} from "./earnings";
import { isIsoCalendarDate, readBoundedText } from "./provider-http";

export const alphaVantageEarningsProvider = "alpha-vantage-earnings";

const header = [
  "symbol",
  "name",
  "reportDate",
  "fiscalDateEnding",
  "estimate",
  "currency",
  "timeOfTheDay",
] as const;

const estimatePattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const rowSchema = z.tuple([
  z.string().min(1),
  z.string(),
  z.string().refine(isIsoCalendarDate),
  z.string().refine(isIsoCalendarDate),
  z.string().refine((value) => value === "" || estimatePattern.test(value)),
  z.enum(["USD", "CAD"]),
  z.string().max(40),
]);

export const alphaVantageSymbol = (symbol: string): string => {
  const normalized = symbol.trim().toUpperCase();
  if (normalized.endsWith(".TO")) return `${normalized.slice(0, -3)}.TRT`;
  if (normalized.endsWith(".V")) return `${normalized.slice(0, -2)}.TRV`;
  return normalized;
};

const assertRange = (startDate: string, endDate: string): void => {
  if (
    !isIsoCalendarDate(startDate) ||
    !isIsoCalendarDate(endDate) ||
    startDate > endDate
  ) {
    throw new Error("provider_invalid_range");
  }
};

const sameHeader = (row: readonly string[]): boolean =>
  row.length === header.length &&
  header.every((column, index) => row[index] === column);

export class AlphaVantageEarningsProvider implements EarningsProvider {
  constructor(
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async getEarningsCalendar(
    instruments: readonly EarningsInstrumentReference[],
    startDate: string,
    endDate: string,
  ): Promise<EarningsEventRange> {
    assertRange(startDate, endDate);
    const byProviderSymbol = new Map(
      instruments.map((instrument) => [
        alphaVantageSymbol(instrument.providerSymbol),
        instrument,
      ]),
    );
    const url = new URL("https://www.alphavantage.co/query");
    url.searchParams.set("function", "EARNINGS_CALENDAR");
    url.searchParams.set("horizon", "3month");
    url.searchParams.set("apikey", this.apiKey);
    const response = await this.fetcher(url, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`provider_http_${response.status}`);

    let rows: string[][] | null;
    try {
      rows = parseCsv((await readBoundedText(response)).replace(/^\uFEFF/, ""));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "provider_response_too_large"
      ) {
        throw error;
      }
      throw new Error("provider_schema");
    }
    const first = rows?.[0];
    if (!rows || !first || !sameHeader(first)) {
      throw new Error("provider_schema");
    }

    const byIdentity = new Map<string, NormalizedEarningsEvent>();
    for (const rawRow of rows.slice(1)) {
      const rawSymbol = rawRow[0]?.trim().toUpperCase();
      const instrument = rawSymbol
        ? byProviderSymbol.get(rawSymbol)
        : undefined;
      if (!instrument) continue;
      let row: z.infer<typeof rowSchema>;
      try {
        row = rowSchema.parse(rawRow.map((field) => field.trim()));
      } catch {
        throw new Error("provider_schema");
      }
      const [
        providerSymbol,
        ,
        reportDate,
        fiscalDateEnding,
        estimate,
        currency,
        time,
      ] = row;
      if (reportDate < startDate || reportDate > endDate) continue;
      const providerEventId = `${alphaVantageEarningsProvider}:${providerSymbol}:earnings:${fiscalDateEnding}`;
      const event: NormalizedEarningsEvent = {
        type: "earnings",
        instrumentId: instrument.instrumentId,
        symbol: instrument.symbol.toUpperCase(),
        reportDate,
        fiscalDateEnding,
        epsEstimate: estimate || null,
        currency,
        timeOfDay: time || null,
        provider: alphaVantageEarningsProvider,
        providerEventId,
        providerRevision: [
          reportDate,
          fiscalDateEnding,
          estimate,
          currency,
          time,
        ].join("|"),
      };
      const existing = byIdentity.get(providerEventId);
      if (existing && existing.providerRevision !== event.providerRevision) {
        throw new Error("provider_conflicting_revision");
      }
      byIdentity.set(providerEventId, event);
    }
    const events = [...byIdentity.values()].sort(
      (left, right) =>
        left.reportDate.localeCompare(right.reportDate) ||
        left.symbol.localeCompare(right.symbol) ||
        left.providerEventId.localeCompare(right.providerEventId),
    );
    const observedAt = this.now().toISOString();
    return {
      range: {
        requestedStartDate: startDate,
        requestedEndDate: endDate,
        provider: alphaVantageEarningsProvider,
        observedAt,
        providerRevision: [
          alphaVantageEarningsProvider,
          startDate,
          endDate,
          ...events.map((event) => event.providerRevision),
        ].join("|"),
      },
      events,
    };
  }
}
