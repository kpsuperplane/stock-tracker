import { z } from "zod";
import type { DailySeries, MarketDataProvider } from "./market-data";

const resultSchema = z.object({
  meta: z.object({
    symbol: z.string(),
    longName: z.string().optional(),
    shortName: z.string().optional(),
    exchangeName: z.string(),
    currency: z.string(),
    instrumentType: z.enum(["EQUITY", "ETF", "WARRANT"]),
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

type RawDecimalToken = string | null;

const rawDecimalTokenPattern =
  /^(?:null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

/**
 * A minimal JSON tree that retains numeric token text. JSON.parse is still
 * used for schema validation, but it rounds long numbers before callers can
 * preserve them.
 */
type RawJsonNode =
  | null
  | boolean
  | string
  | { kind: "number"; token: string }
  | { kind: "array"; values: RawJsonNode[] }
  | { kind: "object"; values: Record<string, RawJsonNode> };

const rawNumberPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;

const parseRawJson = (body: string): RawJsonNode => {
  let index = 0;

  const skipWhitespace = () => {
    while (
      body[index] === " " ||
      body[index] === "\n" ||
      body[index] === "\r" ||
      body[index] === "\t"
    ) {
      index += 1;
    }
  };

  function parseString(): string {
    const start = index;
    index += 1;
    let escaped = false;
    while (index < body.length) {
      const character = body[index];
      index += 1;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        return JSON.parse(body.slice(start, index)) as string;
      }
    }
    throw new Error("market_schema");
  }

  function parseObject(): RawJsonNode {
    index += 1;
    const values: Record<string, RawJsonNode> = Object.create(null);
    skipWhitespace();
    if (body[index] === "}") {
      index += 1;
      return { kind: "object", values };
    }
    while (index < body.length) {
      skipWhitespace();
      if (body[index] !== '"') throw new Error("market_schema");
      const key = parseString();
      skipWhitespace();
      if (body[index] !== ":") throw new Error("market_schema");
      index += 1;
      values[key] = parseValue();
      skipWhitespace();
      if (body[index] === "}") {
        index += 1;
        return { kind: "object", values };
      }
      if (body[index] !== ",") throw new Error("market_schema");
      index += 1;
    }
    throw new Error("market_schema");
  }

  function parseArray(): RawJsonNode {
    index += 1;
    const values: RawJsonNode[] = [];
    skipWhitespace();
    if (body[index] === "]") {
      index += 1;
      return { kind: "array", values };
    }
    while (index < body.length) {
      values.push(parseValue());
      skipWhitespace();
      if (body[index] === "]") {
        index += 1;
        return { kind: "array", values };
      }
      if (body[index] !== ",") throw new Error("market_schema");
      index += 1;
      skipWhitespace();
    }
    throw new Error("market_schema");
  }

  function parseValue(): RawJsonNode {
    skipWhitespace();
    const character = body[index];
    if (character === '"') return parseString();
    if (character === "{") return parseObject();
    if (character === "[") return parseArray();
    if (body.startsWith("true", index)) {
      index += 4;
      return true;
    }
    if (body.startsWith("false", index)) {
      index += 5;
      return false;
    }
    if (body.startsWith("null", index)) {
      index += 4;
      return null;
    }
    const number = body.slice(index).match(rawNumberPattern)?.[0];
    if (!number) throw new Error("market_schema");
    index += number.length;
    return { kind: "number", token: number };
  }

  const root = parseValue();
  skipWhitespace();
  if (index !== body.length) throw new Error("market_schema");
  return root;
};

/**
 * Extract a flat number/null array from the validated Yahoo path. Keeping
 * path identity avoids collisions where unrelated raw tokens round to the
 * same JavaScript Number.
 */
const rawDecimalArrayAtPath = (
  root: RawJsonNode,
  path: readonly (string | number)[],
): RawDecimalToken[] | undefined => {
  let current: RawJsonNode | undefined = root;
  for (const part of path) {
    if (typeof part === "string") {
      if (
        !current ||
        typeof current !== "object" ||
        current.kind !== "object"
      ) {
        return undefined;
      }
      current = current.values[part];
    } else {
      if (!current || typeof current !== "object" || current.kind !== "array") {
        return undefined;
      }
      current = current.values[part];
    }
  }
  if (!current || typeof current !== "object" || current.kind !== "array") {
    return undefined;
  }
  const tokens: RawDecimalToken[] = [];
  for (const value of current.values) {
    if (value === null) {
      tokens.push(null);
      continue;
    }
    if (
      typeof value !== "object" ||
      value.kind !== "number" ||
      !rawDecimalTokenPattern.test(value.token)
    ) {
      return undefined;
    }
    tokens.push(value.token);
  }
  return tokens;
};

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
    const body = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error("market_schema");
    }
    let rawPayload: RawJsonNode;
    try {
      rawPayload = parseRawJson(body);
    } catch {
      throw new Error("market_schema");
    }
    const result = chartSchema.parse(payload).chart.result[0];
    if (!result) throw new Error("market_schema");
    const adjusted = result.indicators.adjclose?.[0]?.adjclose ?? [];
    const closes = result.indicators.quote[0]?.close ?? [];
    const rawCloses = rawDecimalArrayAtPath(rawPayload, [
      "chart",
      "result",
      0,
      "indicators",
      "quote",
      0,
      "close",
    ]);
    if (!rawCloses || rawCloses.length !== closes.length) {
      throw new Error("market_schema");
    }
    const rawAdjusted = rawDecimalArrayAtPath(rawPayload, [
      "chart",
      "result",
      0,
      "indicators",
      "adjclose",
      0,
      "adjclose",
    ]);
    if (
      adjusted.length > 0 &&
      (!rawAdjusted || rawAdjusted.length !== adjusted.length)
    ) {
      throw new Error("market_schema");
    }
    const bars = result.timestamp.map((timestamp, index) => ({
      date: isoDate(timestamp),
      close: closes[index] ?? null,
      adjustedClose: adjusted[index] ?? null,
      closeDecimal: rawCloses[index] ?? null,
      adjustedCloseDecimal: rawAdjusted?.[index] ?? null,
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
