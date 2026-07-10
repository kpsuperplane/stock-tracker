import {
  canonicalizeDecimal,
  DecimalValue,
  RationalValue,
} from "../domain/decimal";
import type { ActiveSplit } from "../domain/holdings";
import type {
  DailyBar,
  DailySeries,
  MarketDataProvider,
} from "../providers/market-data";
import { isIsoCalendarDate } from "../providers/provider-http";

const LOOKBACK_CALENDAR_DAYS = 7;
const movementBasis = "split_adjusted_price_return" as const;

export type MarketFactStatus = "valid" | "error";
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
  currentRawCloseDecimal: string | null;
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
  errorCode: string | null;
  errorMessage: string | null;
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

const ratioToDecimal = (ratio: RationalParts): string =>
  RationalValue.fromRatio(
    String(ratio.numerator),
    String(ratio.denominator),
  ).toString();

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

const canonicalProviderPrice = (value: number | null): string | null => {
  if (value === null) return null;
  if (!Number.isFinite(value) || value <= 0) return null;
  const text = /e/i.test(String(value)) ? value.toFixed(20) : String(value);
  try {
    return canonicalizeDecimal(text);
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

const validateSplits = (splits: readonly ActiveSplit[]): ActiveSplit[] => {
  return [...splits]
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
};

const errorFact = (input: {
  market: MarketFactsInput;
  tradingDate: string;
  previousTradingDate: string | null;
  previousRawCloseDecimal: string | null;
  currentRawCloseDecimal: string | null;
  errorCode: string;
  errorMessage: string;
}): NormalizedMarketFact => ({
  id: `${input.market.instrumentId}:${input.tradingDate}`,
  instrumentId: input.market.instrumentId,
  tradingDate: input.tradingDate,
  previousTradingDate: input.previousTradingDate,
  previousRawCloseDecimal: input.previousRawCloseDecimal,
  currentRawCloseDecimal: input.currentRawCloseDecimal,
  crossingSplitNumerator: "1",
  crossingSplitDenominator: "1",
  splitAdjustedPreviousCloseDecimal: null,
  movementAmountDecimal: null,
  movementPercentDecimal: null,
  rawCloseDifferenceDecimal: null,
  movementBasis,
  provider: input.market.provider,
  providerRevision: input.market.providerRevision,
  retrievedAt: input.market.retrievedAt ?? "",
  freshness: "fresh",
  status: "error",
  errorCode: input.errorCode,
  errorMessage: input.errorMessage,
});

const normalizeFact = (
  market: MarketFactsInput,
  current: DailyBar,
  previous: DailyBar | undefined,
  splits: readonly ActiveSplit[],
): NormalizedMarketFact => {
  const currentRawCloseDecimal = canonicalProviderPrice(current.close);
  if (!previous) {
    return errorFact({
      market,
      tradingDate: current.date,
      previousTradingDate: null,
      previousRawCloseDecimal: null,
      currentRawCloseDecimal,
      errorCode: "no_previous_bar",
      errorMessage: "No completed previous trading bar was available.",
    });
  }
  const previousRawCloseDecimal = canonicalProviderPrice(previous.close);
  if (!currentRawCloseDecimal || !previousRawCloseDecimal) {
    return errorFact({
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
  const adjustedPrevious = DecimalValue.parse(previousRawCloseDecimal).multiply(
    ratioToDecimal({
      numerator: splitRatio.denominator,
      denominator: splitRatio.numerator,
    }),
  );
  const currentValue = DecimalValue.parse(currentRawCloseDecimal);
  const rawPreviousValue = DecimalValue.parse(previousRawCloseDecimal);
  const amount = currentValue.subtract(adjustedPrevious);
  const percent = amount.divide(adjustedPrevious).multiply("100");
  return {
    id: `${market.instrumentId}:${current.date}`,
    instrumentId: market.instrumentId,
    tradingDate: current.date,
    previousTradingDate: previous.date,
    previousRawCloseDecimal,
    currentRawCloseDecimal,
    crossingSplitNumerator: String(splitRatio.numerator),
    crossingSplitDenominator: String(splitRatio.denominator),
    splitAdjustedPreviousCloseDecimal: adjustedPrevious.toString(),
    movementAmountDecimal: amount.toString(),
    movementPercentDecimal: percent.toString(),
    rawCloseDifferenceDecimal: currentValue
      .subtract(rawPreviousValue)
      .toString(),
    movementBasis,
    provider: market.provider,
    providerRevision: market.providerRevision,
    retrievedAt: market.retrievedAt ?? "",
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

  async normalize(input: MarketFactsInput): Promise<NormalizedMarketFact[]> {
    assertRange(input);
    const retrievedAt = input.retrievedAt ?? this.now().toISOString();
    const market = { ...input, retrievedAt };
    const series: DailySeries = await this.provider.getInstrument(
      input.symbol,
      addDays(input.startDate, -LOOKBACK_CALENDAR_DAYS),
      input.endDate,
    );
    if (series.metadata.symbol.toUpperCase() !== input.symbol.toUpperCase()) {
      throw new Error("market_symbol_mismatch");
    }
    const bars = validateBars(series.bars);
    const splits = validateSplits(input.activeSplits);
    return bars
      .filter((bar) => bar.date >= input.startDate && bar.date <= input.endDate)
      .map((bar) => {
        const index = bars.findIndex(
          (candidate) => candidate.date === bar.date,
        );
        return normalizeFact(market, bar, bars[index - 1], splits);
      });
  }
}

export const normalizeMarketFacts = (
  provider: MarketDataProvider,
  input: MarketFactsInput,
  now?: () => Date,
) => new MarketFactsService(provider, now).normalize(input);
