import { describe, expect, it } from "vitest";
import type { DailySeries } from "../providers/market-data";
import { calculateMovement, selectComparison } from "./market";

const series: DailySeries = {
  metadata: {
    symbol: "SHOP.TO",
    companyName: "Shopify Inc.",
    exchange: "TOR",
    currency: "CAD",
    instrumentType: "EQUITY",
  },
  bars: [
    { date: "2026-07-08", close: 100, adjustedClose: 100 },
    { date: "2026-07-09", close: 105, adjustedClose: 105 },
  ],
  corporateActionDates: new Set<string>(),
};

describe("market movement", () => {
  it("qualifies exactly plus five percent before rounding", () => {
    const comparison = selectComparison(series, "2026-07-09");
    expect(comparison.ok).toBe(true);
    if (!comparison.ok) return;
    expect(calculateMovement(comparison)).toMatchObject({
      changePct: 5,
      qualified: true,
    });
  });

  it("qualifies exactly minus five percent", () => {
    const comparison = selectComparison(
      {
        ...series,
        bars: [
          { date: "2026-07-08", close: 100, adjustedClose: 100 },
          { date: "2026-07-09", close: 95, adjustedClose: 95 },
        ],
      },
      "2026-07-09",
    );
    if (!comparison.ok) throw new Error(comparison.code);
    expect(calculateMovement(comparison)).toMatchObject({
      changePct: -5,
      qualified: true,
    });
  });

  it("does not qualify a value that rounds to five percent", () => {
    const comparison = selectComparison(
      {
        ...series,
        bars: [
          { date: "2026-07-08", close: 100, adjustedClose: 100 },
          { date: "2026-07-09", close: 104.999, adjustedClose: 104.999 },
        ],
      },
      "2026-07-09",
    );
    if (!comparison.ok) throw new Error(comparison.code);
    expect(calculateMovement(comparison)).toMatchObject({ qualified: false });
  });

  it("rejects raw-close fallback when a corporate action occurred", () => {
    const comparison = selectComparison(
      {
        ...series,
        bars: [
          { date: "2026-07-08", close: 100, adjustedClose: null },
          { date: "2026-07-09", close: 50, adjustedClose: null },
        ],
        corporateActionDates: new Set(["2026-07-09"]),
      },
      "2026-07-09",
    );
    expect(comparison).toEqual({
      ok: false,
      code: "missing_adjusted_price",
    });
  });

  it("uses raw close only without a corporate action", () => {
    const comparison = selectComparison(
      {
        ...series,
        bars: [
          { date: "2026-07-08", close: 100, adjustedClose: null },
          { date: "2026-07-09", close: 106, adjustedClose: null },
        ],
      },
      "2026-07-09",
    );
    expect(comparison).toMatchObject({ ok: true, priceBasis: "close" });
  });

  it("never substitutes an older or future bar for the target date", () => {
    expect(selectComparison(series, "2026-07-10")).toEqual({
      ok: false,
      code: "no_trading_data",
    });
    expect(selectComparison(series, "2026-07-07")).toEqual({
      ok: false,
      code: "no_trading_data",
    });
  });

  it("rejects a non-positive comparison price", () => {
    const comparison = selectComparison(
      {
        ...series,
        bars: [
          { date: "2026-07-08", close: 0, adjustedClose: 0 },
          { date: "2026-07-09", close: 105, adjustedClose: 105 },
        ],
      },
      "2026-07-09",
    );
    expect(comparison).toEqual({ ok: false, code: "invalid_price" });
  });
});
