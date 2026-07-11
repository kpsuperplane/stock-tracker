import { canonicalizeDecimal, DecimalValue } from "../domain/decimal";
import type { ActiveSplit } from "../domain/holdings";
import type {
  DailyBar,
  DailySeries,
  MarketDataProvider,
} from "../providers/market-data";
import { isIsoCalendarDate } from "../providers/provider-http";

const LOOKBACK_CALENDAR_DAYS = 7;
const movementBasis = "split_adjusted_price_return" as const;

export type MarketFactStatus = "valid";
export type MarketFactFreshness = "fresh";

export interface MarketFactsInput {
  instrumentId: string;
  symbol: string;
  startDate: string;
  endDate: string;
  provider: string;
  providerRevision: string;
  activeSplits: readonly ActiveSplit[];
  retrievedAt?: string;
}

export interface NormalizedMarketFact {
  id: string;
  instrumentId: string;
  tradingDate: string;
  previousTradingDate: string | null;
  previousRawCloseDecimal: string | null;
  currentRawCloseDecimal: string;
  crossingSplitNumerator: string;
  crossingSplitDenominator: string;
  splitAdjustedPreviousCloseDecimal: string | null;
  movementAmountDecimal: string | null;
  movementPercentDecimal: string | null;
  rawCloseDifferenceDecimal: string | null;
  movementBasis: typeof movementBasis;
  provider: string;
  providerRevision: string;
  retrievedAt: string;
  freshness: MarketFactFreshness;
  status: MarketFactStatus;
  errorCode: null;
  errorMessage: null;
}

/**
 * Errors are intentionally not DailyMarketFactRecord values: the D1 schema
 * requires a current close for every materialized fact. Callers may persist
 * valid facts and retain this non-persistable error for retry/observability.
 */
export interface MarketFactError {
  id: string;
  instrumentId: string;
  tradingDate: string | null;
  previousTradingDate: string | null;
  previousRawCloseDecimal: string | null;
  currentRawCloseDecimal: string | null;
  provider: string;
  providerRevision: string;
  retrievedAt: string;
  freshness: MarketFactFreshness;
  status: "error";
  persistable: false;
  errorCode: string;
  errorMessage: string;
}

export interface MarketFactsResult {
  facts: NormalizedMarketFact[];
  errors: MarketFactError[];
}

interface RationalParts {
  numerator: bigint;
  denominator: bigint;
}

const greatestCommonDivisor = (left: bigint, right: bigint): bigint => {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
};

const normalizeRational = (
  numerator: bigint,
  denominator: bigint,
): RationalParts => {
  if (denominator === 0n) throw new Error("market_invalid_split");
  const signedNumerator = denominator < 0n ? -numerator : numerator;
  const positiveDenominator = denominator < 0n ? -denominator : denominator;
  const divisor = greatestCommonDivisor(signedNumerator, positiveDenominator);
  return {
    numerator: signedNumerator / divisor,
    denominator: positiveDenominator / divisor,
  };
};

const multiplyRational = (
  left: RationalParts,
  right: RationalParts,
): RationalParts =>
  normalizeRational(
    left.numerator * right.numerator,
    left.denominator * right.denominator,
  );

const subtractRational = (
  left: RationalParts,
  right: RationalParts,
): RationalParts =>
  normalizeRational(
    left.numerator * right.denominator - right.numerator * left.denominator,
    left.denominator * right.denominator,
  );

const divideRational = (
  left: RationalParts,
  right: RationalParts,
): RationalParts =>
  normalizeRational(
    left.numerator * right.denominator,
    left.denominator * right.numerator,
  );

const decimalToRational = (value: string): RationalParts => {
  const canonical = canonicalizeDecimal(value);
  const negative = canonical.startsWith("-");
  const unsigned = negative ? canonical.slice(1) : canonical;
  const [integerPart, fractionPart = ""] = unsigned.split(".");
  const numerator = BigInt(
    `${negative ? "-" : ""}${integerPart}${fractionPart}`,
  );
  return normalizeRational(numerator, 10n ** BigInt(fractionPart.length));
};

/** Converts a rational to the Decimal boundary only after all arithmetic. */
const rationalToDecimal = (value: RationalParts): string =>
  DecimalValue.parse(String(value.numerator))
    .divide(String(value.denominator))
    .toString();

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

const assertRange = (input: MarketFactsInput): void => {
  if (
    !input.instrumentId ||
    !input.symbol ||
    !input.provider ||
    !input.providerRevision ||
    !isIsoCalendarDate(input.startDate) ||
    !isIsoCalendarDate(input.endDate) ||
    input.startDate > input.endDate
  ) {
    throw new Error("market_invalid_range");
  }
};

const canonicalProviderPrice = (
  value: number | null,
  exactValue?: string | null,
): string | null => {
  const source = exactValue ?? (value === null ? null : String(value));
  if (source === null) return null;
  try {
    const canonical = canonicalizeDecimal(source);
    return DecimalValue.parse(canonical).isPositive() ? canonical : null;
  } catch {
    return null;
  }
};

const validateBars = (bars: readonly DailyBar[]): DailyBar[] => {
  const ordered = [...bars].sort((left, right) =>
    left.date.localeCompare(right.date),
  );
  for (let index = 0; index < ordered.length; index += 1) {
    const bar = ordered[index];
    if (!bar || !isIsoCalendarDate(bar.date)) throw new Error("market_schema");
    if (index > 0 && ordered[index - 1]?.date === bar.date)
      throw new Error("market_schema");
  }
  return ordered;
};

const validateSplits = (splits: readonly ActiveSplit[]): ActiveSplit[] =>
  [...splits]
    .map((split) => {
      if (
        !isIsoCalendarDate(split.effectiveDate) ||
        !/^[1-9]\d*$/.test(split.numerator) ||
        !/^[1-9]\d*$/.test(split.denominator)
      ) {
        throw new Error("market_invalid_split");
      }
      return split;
    })
    .sort((left, right) =>
      left.effectiveDate.localeCompare(right.effectiveDate),
    );

const errorCode = (error: unknown): string => {
  const message = error instanceof Error ? error.message : "market_provider";
  return message.length > 0 ? message.slice(0, 120) : "market_provider";
};

const errorResult = (
  input: MarketFactsInput,
  retrievedAt: string,
  code: string,
  message: string,
  tradingDate: string | null = null,
): MarketFactsResult => ({
  facts: [],
  errors: [
    {
      id: `${input.instrumentId}:${tradingDate ?? input.startDate}`,
      instrumentId: input.instrumentId,
      tradingDate,
      previousTradingDate: null,
      previousRawCloseDecimal: null,
      currentRawCloseDecimal: null,
      provider: input.provider,
      providerRevision: input.providerRevision,
      retrievedAt,
      freshness: "fresh",
      status: "error",
      persistable: false,
      errorCode: code,
      errorMessage: message,
    },
  ],
});

const factError = (input: {
  market: MarketFactsInput & { retrievedAt: string };
  tradingDate: string;
  previousTradingDate: string | null;
  previousRawCloseDecimal: string | null;
  currentRawCloseDecimal: string | null;
  errorCode: string;
  errorMessage: string;
}): MarketFactError => ({
  id: `${input.market.instrumentId}:${input.tradingDate}`,
  instrumentId: input.market.instrumentId,
  tradingDate: input.tradingDate,
  previousTradingDate: input.previousTradingDate,
  previousRawCloseDecimal: input.previousRawCloseDecimal,
  currentRawCloseDecimal: input.currentRawCloseDecimal,
  provider: input.market.provider,
  providerRevision: input.market.providerRevision,
  retrievedAt: input.market.retrievedAt,
  freshness: "fresh",
  status: "error",
  persistable: false,
  errorCode: input.errorCode,
  errorMessage: input.errorMessage,
});

const normalizeFact = (
  market: MarketFactsInput & { retrievedAt: string },
  current: DailyBar,
  previous: DailyBar | undefined,
  splits: readonly ActiveSplit[],
): NormalizedMarketFact | MarketFactError => {
  const currentRawCloseDecimal = canonicalProviderPrice(
    current.close,
    current.closeDecimal,
  );
  if (!previous) {
    return factError({
      market,
      tradingDate: current.date,
      previousTradingDate: null,
      previousRawCloseDecimal: null,
      currentRawCloseDecimal,
      errorCode: "no_previous_bar",
      errorMessage: "No completed previous trading bar was available.",
    });
  }
  const previousRawCloseDecimal = canonicalProviderPrice(
    previous.close,
    previous.closeDecimal,
  );
  if (!currentRawCloseDecimal || !previousRawCloseDecimal) {
    return factError({
      market,
      tradingDate: current.date,
      previousTradingDate: previous.date,
      previousRawCloseDecimal,
      currentRawCloseDecimal,
      errorCode: "invalid_price",
      errorMessage: "A completed bar did not contain a positive close.",
    });
  }

  let splitRatio: RationalParts = { numerator: 1n, denominator: 1n };
  for (const split of splits) {
    if (
      split.effectiveDate > previous.date &&
      split.effectiveDate <= current.date
    ) {
      splitRatio = multiplyRational(
        splitRatio,
        normalizeRational(BigInt(split.numerator), BigInt(split.denominator)),
      );
    }
  }
  const previousValue = decimalToRational(previousRawCloseDecimal);
  const currentValue = decimalToRational(currentRawCloseDecimal);
  const adjustedPrevious = multiplyRational(previousValue, {
    numerator: splitRatio.denominator,
    denominator: splitRatio.numerator,
  });
  const amount = subtractRational(currentValue, adjustedPrevious);
  const percent = multiplyRational(divideRational(amount, adjustedPrevious), {
    numerator: 100n,
    denominator: 1n,
  });
  return {
    id: `${market.instrumentId}:${current.date}`,
    instrumentId: market.instrumentId,
    tradingDate: current.date,
    previousTradingDate: previous.date,
    previousRawCloseDecimal,
    currentRawCloseDecimal,
    crossingSplitNumerator: String(splitRatio.numerator),
    crossingSplitDenominator: String(splitRatio.denominator),
    splitAdjustedPreviousCloseDecimal: rationalToDecimal(adjustedPrevious),
    movementAmountDecimal: rationalToDecimal(amount),
    movementPercentDecimal: rationalToDecimal(percent),
    rawCloseDifferenceDecimal: rationalToDecimal(
      subtractRational(currentValue, previousValue),
    ),
    movementBasis,
    provider: market.provider,
    providerRevision: market.providerRevision,
    retrievedAt: market.retrievedAt,
    freshness: "fresh",
    status: "valid",
    errorCode: null,
    errorMessage: null,
  };
};

export class MarketFactsService {
  constructor(
    private readonly provider: MarketDataProvider,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Provider failures and invalid bars are returned as non-persistable errors;
   * callers retain existing valid D1 facts and retry instead of overwriting
   * them with a schema-invalid error row.
   */
  async normalizeResult(input: MarketFactsInput): Promise<MarketFactsResult> {
    assertRange(input);
    const retrievedAt = input.retrievedAt ?? this.now().toISOString();
    const market = { ...input, retrievedAt };
    const splits = validateSplits(input.activeSplits);
    let series: DailySeries;
    try {
      series = await this.provider.getInstrument(
        input.symbol,
        addDays(input.startDate, -LOOKBACK_CALENDAR_DAYS),
        input.endDate,
      );
    } catch (error) {
      return errorResult(
        input,
        retrievedAt,
        errorCode(error),
        "The market provider did not return a usable range.",
      );
    }
    if (series.metadata.symbol.toUpperCase() !== input.symbol.toUpperCase()) {
      return errorResult(
        input,
        retrievedAt,
        "market_symbol_mismatch",
        "The market provider returned a different symbol.",
      );
    }
    let bars: DailyBar[];
    try {
      bars = validateBars(series.bars);
    } catch (error) {
      return errorResult(
        input,
        retrievedAt,
        errorCode(error),
        "The market provider returned invalid bars.",
      );
    }
    const facts: NormalizedMarketFact[] = [];
    const errors: MarketFactError[] = [];
    for (const bar of bars) {
      if (bar.date < input.startDate || bar.date > input.endDate) continue;
      const index = bars.findIndex((candidate) => candidate.date === bar.date);
      const normalized = normalizeFact(market, bar, bars[index - 1], splits);
      if (normalized.status === "error") errors.push(normalized);
      else facts.push(normalized);
    }
    return { facts, errors };
  }

  async normalize(input: MarketFactsInput): Promise<NormalizedMarketFact[]> {
    return (await this.normalizeResult(input)).facts;
  }
}

export const normalizeMarketFacts = (
  provider: MarketDataProvider,
  input: MarketFactsInput,
  now?: () => Date,
) => new MarketFactsService(provider, now).normalizeResult(input);
