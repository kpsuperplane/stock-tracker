import { z } from "zod";
import type {
  CorporateActionProvider,
  NormalizedSplitEvent,
  SplitEventRange,
} from "./corporate-actions";

const provider = "yahoo-chart-v8";
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const exactNumberPattern = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

const splitSchema = z.object({
  date: z.number().int(),
  splitRatio: z.string().regex(/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/),
});

const resultSchema = z.object({
  meta: z.object({
    symbol: z.string().min(1),
    firstTradeDate: z.number().int().optional(),
  }),
  events: z
    .object({
      splits: z.record(z.string(), splitSchema).optional(),
    })
    .nullish(),
});

const chartEnvelopeSchema = z.object({
  chart: z.object({
    result: z.array(resultSchema).min(1).nullable(),
    error: z
      .object({ code: z.string(), description: z.string() })
      .nullable()
      .optional(),
  }),
});

const epoch = (date: string): number =>
  Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);

const isoDate = (seconds: number): string =>
  new Date(seconds * 1000).toISOString().slice(0, 10);

function assertRange(startDate: string, endDate: string): void {
  if (
    !datePattern.test(startDate) ||
    !datePattern.test(endDate) ||
    !Number.isFinite(Date.parse(`${startDate}T00:00:00Z`)) ||
    !Number.isFinite(Date.parse(`${endDate}T00:00:00Z`)) ||
    startDate > endDate
  ) {
    throw new Error("provider_invalid_range");
  }
}

function parseRatio(value: string): [string, string] {
  const [numerator, denominator] = value.split(":");
  if (
    !numerator ||
    !denominator ||
    !exactNumberPattern.test(numerator) ||
    !exactNumberPattern.test(denominator) ||
    /^0(?:\.0+)?$/.test(numerator) ||
    /^0(?:\.0+)?$/.test(denominator)
  ) {
    throw new Error("provider_schema");
  }

  const asIntegerAndScale = (decimal: string): [bigint, bigint] => {
    const [whole = "0", fraction = ""] = decimal.split(".");
    return [BigInt(`${whole}${fraction}`), 10n ** BigInt(fraction.length)];
  };
  const greatestCommonDivisor = (left: bigint, right: bigint): bigint => {
    let a = left;
    let b = right;
    while (b !== 0n) {
      const remainder = a % b;
      a = b;
      b = remainder;
    }
    return a;
  };
  const [numeratorInteger, numeratorScale] = asIntegerAndScale(numerator);
  const [denominatorInteger, denominatorScale] = asIntegerAndScale(denominator);
  const exactNumerator = numeratorInteger * denominatorScale;
  const exactDenominator = denominatorInteger * numeratorScale;
  const divisor = greatestCommonDivisor(exactNumerator, exactDenominator);
  return [String(exactNumerator / divisor), String(exactDenominator / divisor)];
}

export class YahooCorporateActionProvider implements CorporateActionProvider {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async getSplits(
    symbol: string,
    startDate: string,
    endDate: string,
  ): Promise<SplitEventRange> {
    assertRange(startDate, endDate);
    const url = new URL(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
    );
    url.searchParams.set("period1", String(epoch(startDate)));
    url.searchParams.set("period2", String(epoch(endDate) + 86_400));
    url.searchParams.set("interval", "1d");
    url.searchParams.set("events", "splits");

    const fetcher = this.fetcher;
    const response = await fetcher(url, {
      headers: { "User-Agent": "stock-movement-explainer/1.0" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`provider_http_${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > 2_000_000)
      throw new Error("provider_response_too_large");

    let envelope: z.infer<typeof chartEnvelopeSchema>;
    try {
      envelope = chartEnvelopeSchema.parse(await response.json());
    } catch {
      throw new Error("provider_schema");
    }
    if (!envelope.chart.result) {
      throw new Error("provider_symbol_unavailable");
    }
    const result = envelope.chart.result[0];
    if (!result) throw new Error("provider_schema");
    const normalizedSymbol = result.meta.symbol.toUpperCase();
    if (normalizedSymbol !== symbol.toUpperCase()) {
      throw new Error("provider_symbol_mismatch");
    }

    const byIdentity = new Map<string, NormalizedSplitEvent>();
    for (const split of Object.values(result.events?.splits ?? {})) {
      const effectiveDate = isoDate(split.date);
      if (effectiveDate < startDate || effectiveDate > endDate) continue;
      const [numerator, denominator] = parseRatio(split.splitRatio);
      const providerEventId = `${provider}:${normalizedSymbol}:split:${effectiveDate}`;
      const event: NormalizedSplitEvent = {
        type: "split",
        symbol: normalizedSymbol,
        effectiveDate,
        numerator,
        denominator,
        provider,
        providerEventId,
        providerRevision: `${effectiveDate}|${numerator}:${denominator}`,
      };
      const existing = byIdentity.get(providerEventId);
      if (existing && existing.providerRevision !== event.providerRevision) {
        throw new Error("provider_conflicting_revision");
      }
      byIdentity.set(providerEventId, event);
    }

    const firstTradeDate = result.meta.firstTradeDate
      ? isoDate(result.meta.firstTradeDate)
      : startDate;
    const coverageStartDate =
      firstTradeDate > startDate ? firstTradeDate : startDate;
    return {
      symbol: normalizedSymbol,
      range: {
        requestedStartDate: startDate,
        requestedEndDate: endDate,
        coverageStartDate,
        coverageEndDate: endDate,
        isComplete: coverageStartDate === startDate,
      },
      events: [...byIdentity.values()].sort((left, right) =>
        left.effectiveDate.localeCompare(right.effectiveDate),
      ),
    };
  }
}
