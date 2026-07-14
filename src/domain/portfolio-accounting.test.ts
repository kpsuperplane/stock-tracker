import { describe, expect, it } from "vitest";
import {
  PortfolioAccountingEngine,
  type PortfolioAccountingInput,
} from "./portfolio-accounting";

const instrument = {
  id: "instrument",
  symbol: "TEST",
  companyName: "Test Corp",
  exchange: "TSX",
  currency: "CAD" as const,
};

const build = (
  transactions: PortfolioAccountingInput["transactions"],
  options: Partial<PortfolioAccountingInput> = {},
) =>
  new PortfolioAccountingEngine({
    instruments: options.instruments ?? [instrument],
    transactions,
    splits: options.splits ?? [],
    dividends: options.dividends ?? [],
  });

const buy = (
  id: string,
  date: string,
  quantity: string,
  price: string,
  accountId = "account",
) => ({
  id,
  accountId,
  instrumentId: instrument.id,
  tradeDate: date,
  side: "buy" as const,
  quantityDecimal: quantity,
  priceDecimal: price,
});

const sell = (
  id: string,
  date: string,
  quantity: string,
  price: string,
  accountId = "account",
) => ({ ...buy(id, date, quantity, price, accountId), side: "sell" as const });

describe("PortfolioAccountingEngine", () => {
  it("uses weighted-average cost for partial and full sales", () => {
    const engine = build([
      buy("b1", "2025-01-01", "10", "10"),
      buy("b2", "2025-01-02", "10", "20"),
      sell("s1", "2025-01-03", "5", "25"),
    ]);
    engine.advanceTo("2025-01-03");
    expect(engine.snapshot()[0]).toMatchObject({
      quantity: expect.objectContaining({}),
    });
    expect(engine.snapshot()[0]?.quantity.toString()).toBe("15");
    expect(engine.snapshot()[0]?.bookCost.toString()).toBe("225");
    expect(engine.snapshot()[0]?.averageCost.toString()).toBe("15");
    expect(engine.snapshot()[0]?.realizedGain.toString()).toBe("50");

    const disposal = build([
      buy("b", "2025-01-01", "3", "7.5"),
      sell("s", "2025-01-02", "3", "6"),
    ]);
    disposal.advanceTo("2025-01-02");
    expect(disposal.snapshot()[0]?.quantity.toString()).toBe("0");
    expect(disposal.snapshot()[0]?.bookCost.toString()).toBe("0");
    expect(disposal.snapshot()[0]?.realizedGain.toString()).toBe("-4.5");
  });

  it("tracks a free acquisition with a zero cost basis", () => {
    const engine = build([
      buy("free", "2025-01-01", "3", "0"),
      sell("sale", "2025-01-02", "1", "4.5"),
    ]);

    engine.advanceTo("2025-01-02");

    expect(engine.snapshot()[0]?.quantity.toString()).toBe("2");
    expect(engine.snapshot()[0]?.bookCost.toString()).toBe("0");
    expect(engine.snapshot()[0]?.averageCost.toString()).toBe("0");
    expect(engine.snapshot()[0]?.realizedGain.toString()).toBe("4.5");
  });

  it("cleans residual cost before a disposal and re-entry", () => {
    const engine = build([
      buy("b1", "2025-01-01", "3", "10"),
      sell("s1", "2025-01-02", "3", "11"),
      buy("b2", "2025-01-03", "0.25", "8.4"),
    ]);
    engine.advanceTo("2025-01-03");
    expect(engine.snapshot()[0]?.quantity.toString()).toBe("0.25");
    expect(engine.snapshot()[0]?.bookCost.toString()).toBe("2.1");
    expect(engine.snapshot()[0]?.averageCost.toString()).toBe("8.4");
    expect(engine.snapshot()[0]?.realizedGain.toString()).toBe("3");
  });

  it("applies splits first and buys before same-day sells", () => {
    const engine = build(
      [
        buy("z-buy", "2025-02-01", "10", "12"),
        sell("a-sell", "2025-02-01", "5", "15"),
      ],
      {
        splits: [
          {
            id: "split",
            instrumentId: instrument.id,
            effectiveDate: "2025-02-01",
            numerator: "2",
            denominator: "1",
          },
        ],
      },
    );
    engine.advanceTo("2025-02-01");
    expect(engine.snapshot()[0]?.quantity.toString()).toBe("5");
    expect(engine.snapshot()[0]?.bookCost.toString()).toBe("60");
    expect(engine.snapshot()[0]?.realizedGain.toString()).toBe("15");
  });

  it("supports forward, reverse, and fractional split quantities", () => {
    const engine = build([buy("b", "2025-01-01", "1.25", "16")], {
      splits: [
        {
          id: "s1",
          instrumentId: instrument.id,
          effectiveDate: "2025-01-02",
          numerator: "3",
          denominator: "2",
        },
        {
          id: "s2",
          instrumentId: instrument.id,
          effectiveDate: "2025-01-03",
          numerator: "1",
          denominator: "5",
        },
      ],
    });
    engine.advanceTo("2025-01-03");
    expect(engine.snapshot()[0]?.quantity.toString()).toBe("0.375");
    expect(engine.snapshot()[0]?.bookCost.toString()).toBe("20");
  });

  it("keeps account cost bases isolated before aggregation", () => {
    const engine = build([
      buy("b1", "2025-01-01", "10", "10", "one"),
      buy("b2", "2025-01-01", "10", "30", "two"),
      sell("s1", "2025-01-02", "5", "20", "one"),
    ]);
    engine.advanceTo("2025-01-02");
    expect(engine.snapshot()[0]?.quantity.toString()).toBe("15");
    expect(engine.snapshot()[0]?.bookCost.toString()).toBe("350");
    expect(engine.snapshot()[0]?.realizedGain.toString()).toBe("50");
  });

  it("recognizes dividends from split-adjusted start-of-day quantity", () => {
    const engine = build(
      [
        buy("before", "2025-01-01", "10", "10"),
        buy("same-day", "2025-02-01", "10", "10"),
        sell("same-day-sale", "2025-02-01", "5", "10"),
      ],
      {
        splits: [
          {
            id: "split",
            instrumentId: instrument.id,
            effectiveDate: "2025-02-01",
            numerator: "2",
            denominator: "1",
          },
        ],
        dividends: [
          {
            id: "dividend",
            instrumentId: instrument.id,
            exDate: "2025-02-01",
            amountPerShareDecimal: "0.25",
          },
        ],
      },
    );
    engine.advanceTo("2025-02-01");
    expect(engine.snapshot()[0]?.dividends.toString()).toBe("5");
  });
});
