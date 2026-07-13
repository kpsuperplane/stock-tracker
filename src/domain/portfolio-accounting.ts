import { RationalValue } from "./decimal";

export type PortfolioCurrency = "CAD" | "USD";

export interface PortfolioAccountingInstrument {
  id: string;
  symbol: string;
  companyName: string;
  exchange: string;
  currency: PortfolioCurrency;
}

export interface PortfolioAccountingTransaction {
  id: string;
  accountId: string;
  instrumentId: string;
  tradeDate: string;
  side: "buy" | "sell";
  quantityDecimal: string;
  priceDecimal: string;
}

export interface PortfolioAccountingSplit {
  id: string;
  instrumentId: string;
  effectiveDate: string;
  numerator: string;
  denominator: string;
}

export interface PortfolioAccountingDividend {
  id: string;
  instrumentId: string;
  exDate: string;
  amountPerShareDecimal: string;
}

export interface PortfolioAccountingInput {
  instruments: readonly PortfolioAccountingInstrument[];
  transactions: readonly PortfolioAccountingTransaction[];
  splits: readonly PortfolioAccountingSplit[];
  dividends: readonly PortfolioAccountingDividend[];
}

export interface PortfolioAccountingPosition {
  instrument: PortfolioAccountingInstrument;
  quantity: RationalValue;
  bookCost: RationalValue;
  averageCost: RationalValue;
  realizedGain: RationalValue;
  dividends: RationalValue;
}

interface AccountPosition {
  quantity: RationalValue;
  bookCost: RationalValue;
  realizedGain: RationalValue;
  dividends: RationalValue;
}

type DatedEvent =
  | ({ kind: "split" } & PortfolioAccountingSplit)
  | ({ kind: "dividend" } & PortfolioAccountingDividend)
  | ({ kind: "transaction" } & PortfolioAccountingTransaction);

const zeroPosition = (): AccountPosition => ({
  quantity: RationalValue.zero(),
  bookCost: RationalValue.zero(),
  realizedGain: RationalValue.zero(),
  dividends: RationalValue.zero(),
});

const eventDate = (event: DatedEvent): string =>
  event.kind === "split"
    ? event.effectiveDate
    : event.kind === "dividend"
      ? event.exDate
      : event.tradeDate;

const eventOrder = (event: DatedEvent): number => {
  if (event.kind === "split") return 0;
  if (event.kind === "dividend") return 1;
  return event.side === "buy" ? 2 : 3;
};

export class PortfolioAccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PortfolioAccountingError";
  }
}

/**
 * A monotonic portfolio ledger. Quantities and costs remain rational until the
 * read-model boundary, including average-cost removal on partial disposals.
 */
export class PortfolioAccountingEngine {
  private readonly instruments = new Map<
    string,
    PortfolioAccountingInstrument
  >();
  private readonly events: DatedEvent[];
  private readonly positions = new Map<string, AccountPosition>();
  private eventIndex = 0;
  private currentDate: string | null = null;

  constructor(input: PortfolioAccountingInput) {
    for (const instrument of input.instruments)
      this.instruments.set(instrument.id, instrument);
    this.events = [
      ...input.splits.map((event) => ({ ...event, kind: "split" as const })),
      ...input.dividends.map((event) => ({
        ...event,
        kind: "dividend" as const,
      })),
      ...input.transactions.map((event) => ({
        ...event,
        kind: "transaction" as const,
      })),
    ].sort((left, right) => {
      const dateComparison = eventDate(left).localeCompare(eventDate(right));
      if (dateComparison !== 0) return dateComparison;
      const orderComparison = eventOrder(left) - eventOrder(right);
      return orderComparison !== 0
        ? orderComparison
        : left.id.localeCompare(right.id);
    });
  }

  advanceTo(date: string): void {
    if (this.currentDate !== null && date < this.currentDate) {
      throw new PortfolioAccountingError(
        "portfolio accounting dates must be monotonic",
      );
    }
    while (this.eventIndex < this.events.length) {
      const current = this.events[this.eventIndex];
      if (!current || eventDate(current) > date) break;
      const dateToApply = eventDate(current);
      while (this.eventIndex < this.events.length) {
        const event = this.events[this.eventIndex];
        if (!event || eventDate(event) !== dateToApply) break;
        this.apply(event);
        this.eventIndex += 1;
      }
    }
    this.currentDate = date;
  }

  snapshot(): PortfolioAccountingPosition[] {
    const byInstrument = new Map<string, AccountPosition>();
    for (const [key, position] of this.positions) {
      const instrumentId = key.slice(key.indexOf("\u0000") + 1);
      const aggregate = byInstrument.get(instrumentId) ?? zeroPosition();
      aggregate.quantity = aggregate.quantity.add(position.quantity);
      aggregate.bookCost = aggregate.bookCost.add(position.bookCost);
      aggregate.realizedGain = aggregate.realizedGain.add(
        position.realizedGain,
      );
      aggregate.dividends = aggregate.dividends.add(position.dividends);
      byInstrument.set(instrumentId, aggregate);
    }
    return [...byInstrument.entries()]
      .map(([instrumentId, aggregate]) => {
        const instrument = this.instruments.get(instrumentId);
        if (!instrument)
          throw new PortfolioAccountingError("unknown portfolio instrument");
        return {
          instrument,
          ...aggregate,
          averageCost: aggregate.quantity.isZero()
            ? RationalValue.zero()
            : aggregate.bookCost.divide(aggregate.quantity),
        };
      })
      .sort((left, right) =>
        left.instrument.symbol.localeCompare(right.instrument.symbol),
      );
  }

  private key(accountId: string, instrumentId: string): string {
    return `${accountId}\u0000${instrumentId}`;
  }

  private position(accountId: string, instrumentId: string): AccountPosition {
    const key = this.key(accountId, instrumentId);
    const existing = this.positions.get(key);
    if (existing) return existing;
    const created = zeroPosition();
    this.positions.set(key, created);
    return created;
  }

  private apply(event: DatedEvent): void {
    if (!this.instruments.has(event.instrumentId)) {
      throw new PortfolioAccountingError("event references unknown instrument");
    }
    if (event.kind === "split") {
      const ratio = RationalValue.fromRatio(event.numerator, event.denominator);
      for (const [key, position] of this.positions) {
        if (key.endsWith(`\u0000${event.instrumentId}`))
          position.quantity = position.quantity.multiply(ratio);
      }
      return;
    }
    if (event.kind === "dividend") {
      const amount = RationalValue.fromDecimal(event.amountPerShareDecimal);
      for (const [key, position] of this.positions) {
        if (
          key.endsWith(`\u0000${event.instrumentId}`) &&
          position.quantity.isPositive()
        ) {
          position.dividends = position.dividends.add(
            position.quantity.multiply(amount),
          );
        }
      }
      return;
    }
    this.applyTransaction(event);
  }

  private applyTransaction(event: PortfolioAccountingTransaction): void {
    const position = this.position(event.accountId, event.instrumentId);
    const quantity = RationalValue.fromDecimal(event.quantityDecimal);
    const price = RationalValue.fromDecimal(event.priceDecimal);
    if (!quantity.isPositive() || !price.isPositive()) {
      throw new PortfolioAccountingError(
        "portfolio transactions require positive quantity and price",
      );
    }
    if (event.side === "buy") {
      position.quantity = position.quantity.add(quantity);
      position.bookCost = position.bookCost.add(quantity.multiply(price));
      return;
    }
    if (quantity.compare(position.quantity) > 0) {
      throw new PortfolioAccountingError(
        "portfolio sale exceeds account holdings",
      );
    }
    const proceeds = quantity.multiply(price);
    const removedCost = position.bookCost
      .multiply(quantity)
      .divide(position.quantity);
    position.realizedGain = position.realizedGain.add(
      proceeds.subtract(removedCost),
    );
    position.quantity = position.quantity.subtract(quantity);
    if (position.quantity.isZero()) {
      position.bookCost = RationalValue.zero();
    } else {
      position.bookCost = position.bookCost.subtract(removedCost);
    }
  }
}
