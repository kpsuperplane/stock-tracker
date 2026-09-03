import { describe, expect, it } from "vitest";
import {
  isMarketTradingDayForExchange,
  isUsMarketHoliday,
} from "./market-calendar";

describe("market calendar", () => {
  it.each([
    "2018-12-05",
    "2025-01-09",
  ])("treats the exceptional US closure on %s as a non-trading day", (date) => {
    expect(isUsMarketHoliday(date)).toBe(true);
    expect(isMarketTradingDayForExchange(date, "NYSE")).toBe(false);
    expect(isMarketTradingDayForExchange(date, "NASDAQ")).toBe(false);
  });

  it("does not apply US exceptional closures to Toronto", () => {
    expect(isMarketTradingDayForExchange("2025-01-09", "TOR")).toBe(true);
  });
});
