import {
  type DecimalBounds,
  DecimalValue,
  INPUT_DECIMAL_BOUNDS,
} from "./decimal";

export interface LedgerTransaction {
  id: string;
  tradeDate: string;
  side: "buy" | "sell";
  quantityDecimal: string;
}

export interface ActiveSplit {
  id: string;
  effectiveDate: string;
  numerator: string;
  denominator: string;
}

export interface HeldInterval {
  startDate: string;
  endDate: string;
}

export interface HoldingsInput {
  today: string;
  transactions: readonly LedgerTransaction[];
  activeSplits: readonly ActiveSplit[];
}

export class HoldingsDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HoldingsDomainError";
  }
}

const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

const validDate = (value: string): boolean => {
  const match = datePattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(Date.UTC(year, month - 1, day));
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day
  );
};

const assertDate = (value: string, label: string): void => {
  if (!validDate(value)) throw new HoldingsDomainError(`invalid ${label} date`);
};

const nextDate = (date: string): string => {
  const result = new Date(`${date}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() + 1);
  return result.toISOString().slice(0, 10);
};

const previousDate = (date: string): string => {
  const result = new Date(`${date}T12:00:00.000Z`);
  result.setUTCDate(result.getUTCDate() - 1);
  return result.toISOString().slice(0, 10);
};

const splitInteger = (value: string): DecimalValue => {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new HoldingsDomainError(
      "split ratio values must be positive integers",
    );
  }
  return DecimalValue.parse(value);
};

interface NormalizedTransaction {
  id: string;
  tradeDate: string;
  signedQuantity: DecimalValue;
}

interface NormalizedSplit {
  id: string;
  effectiveDate: string;
  ratio: DecimalValue;
}

const normalizeTransactions = (
  transactions: readonly LedgerTransaction[],
  today: string,
  bounds: DecimalBounds,
): NormalizedTransaction[] =>
  transactions.map((transaction) => {
    assertDate(transaction.tradeDate, "trade");
    if (transaction.tradeDate > today) {
      throw new HoldingsDomainError("future trade dates are not allowed");
    }
    const quantity = DecimalValue.parse(transaction.quantityDecimal, bounds);
    if (!quantity.isPositive()) {
      throw new HoldingsDomainError("transaction quantity must be positive");
    }
    return {
      id: transaction.id,
      tradeDate: transaction.tradeDate,
      signedQuantity:
        transaction.side === "buy"
          ? quantity
          : DecimalValue.zero().subtract(quantity),
    };
  });

const normalizeSplits = (splits: readonly ActiveSplit[]): NormalizedSplit[] =>
  splits.map((split) => {
    assertDate(split.effectiveDate, "split effective");
    return {
      id: split.id,
      effectiveDate: split.effectiveDate,
      ratio: splitInteger(split.numerator).divide(
        splitInteger(split.denominator),
      ),
    };
  });

const groupByDate = <T extends { id: string }>(
  rows: readonly T[],
  date: (row: T) => string,
): Map<string, T[]> => {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = date(row);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  for (const group of grouped.values())
    group.sort((left, right) => left.id.localeCompare(right.id));
  return grouped;
};

export class Holdings {
  private readonly transactionsByDate: Map<string, NormalizedTransaction[]>;
  private readonly splitsByDate: Map<string, NormalizedSplit[]>;
  private readonly eventDates: string[];

  constructor(
    private readonly today: string,
    transactions: readonly NormalizedTransaction[],
    splits: readonly NormalizedSplit[],
  ) {
    this.transactionsByDate = groupByDate(
      transactions,
      (transaction) => transaction.tradeDate,
    );
    this.splitsByDate = groupByDate(splits, (split) => split.effectiveDate);
    this.eventDates = [
      ...new Set([
        ...this.transactionsByDate.keys(),
        ...this.splitsByDate.keys(),
      ]),
    ].sort((left, right) => left.localeCompare(right));
    this.validateHistory();
  }

  currentQuantity(): string {
    return this.quantityOn(this.today);
  }

  quantityOn(date: string): string {
    assertDate(date, "query");
    return this.fold(date, true).toString();
  }

  quantityAtStartOfDay(date: string): string {
    assertDate(date, "query");
    return this.fold(date, false).toString();
  }

  isEligibleForScreening(date: string): boolean {
    return DecimalValue.parse(this.quantityAtStartOfDay(date)).isPositive();
  }

  quantityForExDividend(exDividendDate: string): string {
    return this.quantityAtStartOfDay(exDividendDate);
  }

  isEligibleForExDividend(exDividendDate: string): boolean {
    return DecimalValue.parse(
      this.quantityForExDividend(exDividendDate),
    ).isPositive();
  }

  heldIntervals(range: { startDate: string; endDate: string }): HeldInterval[] {
    assertDate(range.startDate, "range start");
    assertDate(range.endDate, "range end");
    if (range.startDate > range.endDate) {
      throw new HoldingsDomainError(
        "held interval range start must not be after end",
      );
    }

    const intervals: HeldInterval[] = [];
    let intervalStart: string | undefined;
    for (
      let date = range.startDate;
      date <= range.endDate;
      date = nextDate(date)
    ) {
      if (this.isEligibleForScreening(date)) {
        intervalStart ??= date;
      } else if (intervalStart) {
        intervals.push({
          startDate: intervalStart,
          endDate: previousDate(date),
        });
        intervalStart = undefined;
      }
    }
    if (intervalStart)
      intervals.push({ startDate: intervalStart, endDate: range.endDate });
    return intervals;
  }

  private validateHistory(): void {
    let quantity = DecimalValue.zero();
    for (const date of this.eventDates) {
      if (date > this.today) break;
      quantity = this.applySplits(quantity, date);
      quantity = quantity.add(this.netTransactions(date));
      if (quantity.isNegative()) {
        throw new HoldingsDomainError(
          "negative historical holdings are not allowed",
        );
      }
    }
  }

  private fold(date: string, includeTransactionsOnDate: boolean): DecimalValue {
    let quantity = DecimalValue.zero();
    for (const eventDate of this.eventDates) {
      if (eventDate > date) break;
      quantity = this.applySplits(quantity, eventDate);
      if (eventDate < date || includeTransactionsOnDate) {
        quantity = quantity.add(this.netTransactions(eventDate));
      }
    }
    return quantity;
  }

  private applySplits(quantity: DecimalValue, date: string): DecimalValue {
    return (this.splitsByDate.get(date) ?? []).reduce(
      (current, split) => current.multiply(split.ratio),
      quantity,
    );
  }

  private netTransactions(date: string): DecimalValue {
    return (this.transactionsByDate.get(date) ?? []).reduce(
      (current, transaction) => current.add(transaction.signedQuantity),
      DecimalValue.zero(),
    );
  }
}

export const deriveHoldings = (input: HoldingsInput): Holdings => {
  assertDate(input.today, "today");
  const transactions = normalizeTransactions(
    input.transactions,
    input.today,
    INPUT_DECIMAL_BOUNDS,
  );
  const splits = normalizeSplits(input.activeSplits);
  return new Holdings(input.today, transactions, splits);
};
