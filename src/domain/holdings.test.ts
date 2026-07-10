import { describe, expect, it } from "vitest";
import {
  canonicalizeDecimal,
  DecimalValue,
  formatDecimal,
  INPUT_DECIMAL_BOUNDS,
} from "./decimal";
import {
  type ActiveSplit,
  deriveHoldings,
  type LedgerTransaction,
} from "./holdings";

const transaction = (
  id: string,
  tradeDate: string,
  side: LedgerTransaction["side"],
  quantityDecimal: string,
): LedgerTransaction => ({ id, tradeDate, side, quantityDecimal });

const split = (
  id: string,
  effectiveDate: string,
  numerator: string,
  denominator: string,
): ActiveSplit => ({ id, effectiveDate, numerator, denominator });

const input = (
  overrides: Partial<Parameters<typeof deriveHoldings>[0]> = {},
) => ({
  today: "2026-07-10",
  transactions: [],
  activeSplits: [],
  ...overrides,
});

describe("decimal boundary", () => {
  it("canonicalizes decimal strings without JavaScript number conversion", () => {
    expect(canonicalizeDecimal("+001.230000")).toBe("1.23");
    expect(canonicalizeDecimal("-.500")).toBe("-0.5");
    expect(canonicalizeDecimal("-0.000000")).toBe("0");
    expect(() => canonicalizeDecimal("1e3")).toThrow("decimal");
  });

  it("enforces six-digit user input precision and configured transaction bounds", () => {
    expect(canonicalizeDecimal("1.123456", INPUT_DECIMAL_BOUNDS)).toBe(
      "1.123456",
    );
    expect(() =>
      canonicalizeDecimal("1.1234567", INPUT_DECIMAL_BOUNDS),
    ).toThrow("fractional");
    expect(canonicalizeDecimal("1000000000", INPUT_DECIMAL_BOUNDS)).toBe(
      "1000000000",
    );
    expect(() =>
      canonicalizeDecimal("1000000000.000001", INPUT_DECIMAL_BOUNDS),
    ).toThrow("maximum");
  });

  it("multiplies and compares exactly while retaining derived precision", () => {
    const product = DecimalValue.parse("0.000001").multiply("0.000001");
    expect(product.toString()).toBe("0.000000000001");
    expect(DecimalValue.parse("10.00").compare("9.999999999999")).toBe(1);
    expect(DecimalValue.parse("1.2").equals("1.200000000000")).toBe(true);
  });

  it("rounds only at the display boundary", () => {
    expect(formatDecimal("1.2345674")).toBe("1.234567");
    expect(formatDecimal("1.2345675")).toBe("1.234568");
    expect(formatDecimal("-1.2345675")).toBe("-1.234568");
  });
});

describe("derived holdings", () => {
  it("folds multiple buys and sells and nets same-day transactions before validation", () => {
    const holdings = deriveHoldings(
      input({
        transactions: [
          transaction("buy-2", "2026-07-03", "buy", "2.5"),
          transaction("sell-1", "2026-07-03", "sell", "1"),
          transaction("buy-1", "2026-07-01", "buy", "10"),
          transaction("sell-2", "2026-07-06", "sell", "4.25"),
        ],
      }),
    );

    expect(holdings.quantityOn("2026-07-02")).toBe("10");
    expect(holdings.quantityOn("2026-07-03")).toBe("11.5");
    expect(holdings.currentQuantity()).toBe("7.25");
  });

  it("rejects future trades and histories that go negative at end of a trade day", () => {
    expect(() =>
      deriveHoldings(
        input({
          transactions: [transaction("future", "2026-07-11", "buy", "1")],
        }),
      ),
    ).toThrow("future");

    expect(() =>
      deriveHoldings(
        input({
          transactions: [
            transaction("buy", "2026-07-01", "buy", "1"),
            transaction("sell", "2026-07-02", "sell", "1.000001"),
          ],
        }),
      ),
    ).toThrow("negative");
  });

  it("applies active forward and reverse splits and supports cash-in-lieu sells", () => {
    const forward = deriveHoldings(
      input({
        transactions: [transaction("buy", "2026-07-01", "buy", "10")],
        activeSplits: [split("two-for-one", "2026-07-03", "2", "1")],
      }),
    );
    expect(forward.quantityOn("2026-07-03")).toBe("20");

    const reverse = deriveHoldings(
      input({
        transactions: [
          transaction("buy", "2026-07-01", "buy", "5"),
          transaction("cash-in-lieu", "2026-07-04", "sell", "0.5"),
        ],
        activeSplits: [split("one-for-two", "2026-07-03", "1", "2")],
      }),
    );
    expect(reverse.quantityOn("2026-07-03")).toBe("2.5");
    expect(reverse.currentQuantity()).toBe("2");
  });

  it("uses start-of-day ownership for screening and ex-dividend eligibility", () => {
    const holdings = deriveHoldings(
      input({
        transactions: [
          transaction("buy", "2026-07-01", "buy", "3"),
          transaction("sell", "2026-07-05", "sell", "3"),
        ],
      }),
    );

    expect(holdings.quantityAtStartOfDay("2026-07-01")).toBe("0");
    expect(holdings.isEligibleForScreening("2026-07-01")).toBe(false);
    expect(holdings.quantityAtStartOfDay("2026-07-05")).toBe("3");
    expect(holdings.isEligibleForScreening("2026-07-05")).toBe(true);
    expect(holdings.quantityForExDividend("2026-07-01")).toBe("0");
    expect(holdings.isEligibleForExDividend("2026-07-01")).toBe(false);
    expect(holdings.quantityForExDividend("2026-07-05")).toBe("3");
    expect(holdings.isEligibleForExDividend("2026-07-05")).toBe(true);
    expect(holdings.isEligibleForScreening("2026-07-06")).toBe(false);
  });

  it("includes an effective-date split in start-of-day and ex-dividend quantity", () => {
    const holdings = deriveHoldings(
      input({
        transactions: [transaction("buy", "2026-07-01", "buy", "3")],
        activeSplits: [split("split", "2026-07-05", "2", "1")],
      }),
    );
    expect(holdings.quantityAtStartOfDay("2026-07-05")).toBe("6");
    expect(holdings.quantityForExDividend("2026-07-05")).toBe("6");
  });

  it("returns inclusive held intervals based on start-of-day ownership", () => {
    const holdings = deriveHoldings(
      input({
        transactions: [
          transaction("buy", "2026-07-02", "buy", "1"),
          transaction("sell", "2026-07-05", "sell", "1"),
          transaction("buy-again", "2026-07-07", "buy", "1"),
        ],
      }),
    );
    expect(
      holdings.heldIntervals({
        startDate: "2026-07-01",
        endDate: "2026-07-10",
      }),
    ).toEqual([
      { startDate: "2026-07-03", endDate: "2026-07-05" },
      { startDate: "2026-07-08", endDate: "2026-07-10" },
    ]);
  });

  it("is deterministic across transaction ordering and accepts non-negative generated histories", () => {
    const first = transaction("a", "2026-07-01", "buy", "5");
    const second = transaction("b", "2026-07-03", "sell", "2");
    const third = transaction("c", "2026-07-03", "buy", "1");
    const events = [first, second, third];
    const expected = deriveHoldings(
      input({ transactions: events }),
    ).currentQuantity();
    for (const ordering of [
      events,
      [...events].reverse(),
      [second, first, third],
    ]) {
      expect(
        deriveHoldings(input({ transactions: ordering })).currentQuantity(),
      ).toBe(expected);
    }

    for (let buys = 2; buys <= 12; buys += 1) {
      const history = [
        transaction(`buy-${buys}`, "2026-07-01", "buy", `${buys}`),
        transaction(`sell-${buys}`, "2026-07-02", "sell", `${buys - 1}`),
      ];
      const holdings = deriveHoldings(input({ transactions: history }));
      expect(DecimalValue.parse(holdings.currentQuantity()).isNegative()).toBe(
        false,
      );
    }
  });
});
