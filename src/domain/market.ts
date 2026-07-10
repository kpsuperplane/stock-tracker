import type { DailySeries } from "../providers/market-data";

export type Comparison =
  | {
      ok: false;
      code:
        | "no_trading_data"
        | "no_previous_bar"
        | "missing_adjusted_price"
        | "invalid_price";
    }
  | {
      ok: true;
      targetDate: string;
      previousDate: string;
      previousPrice: number;
      currentPrice: number;
      priceBasis: "adjusted" | "close";
    };

const validPrice = (price: number | null) =>
  price !== null && Number.isFinite(price) && price > 0;

export const selectComparison = (
  series: DailySeries,
  targetDate: string,
): Comparison => {
  const bars = [...series.bars]
    .filter((bar) => bar.date <= targetDate)
    .sort((left, right) => left.date.localeCompare(right.date));
  const currentIndex = bars.findIndex((bar) => bar.date === targetDate);
  if (currentIndex < 0) return { ok: false, code: "no_trading_data" };
  const previous = bars[currentIndex - 1];
  const current = bars[currentIndex];
  if (!previous || !current) return { ok: false, code: "no_previous_bar" };

  if (
    previous.adjustedClose !== null &&
    current.adjustedClose !== null
  ) {
    if (
      !validPrice(previous.adjustedClose) ||
      !validPrice(current.adjustedClose)
    ) {
      return { ok: false, code: "invalid_price" };
    }
    return {
      ok: true,
      targetDate,
      previousDate: previous.date,
      previousPrice: previous.adjustedClose,
      currentPrice: current.adjustedClose,
      priceBasis: "adjusted",
    };
  }

  const hasAction = [...series.corporateActionDates].some(
    (date) => date > previous.date && date <= current.date,
  );
  if (hasAction || previous.close === null || current.close === null) {
    return { ok: false, code: "missing_adjusted_price" };
  }
  if (!validPrice(previous.close) || !validPrice(current.close)) {
    return { ok: false, code: "invalid_price" };
  }
  return {
    ok: true,
    targetDate,
    previousDate: previous.date,
    previousPrice: previous.close,
    currentPrice: current.close,
    priceBasis: "close",
  };
};

export const calculateMovement = (
  comparison: Extract<Comparison, { ok: true }>,
) => {
  const changeAmount = comparison.currentPrice - comparison.previousPrice;
  const changePct = (changeAmount / comparison.previousPrice) * 100;
  return {
    changeAmount,
    changePct,
    qualified: Math.abs(changePct) >= 5,
  };
};
