import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDecimalString,
  formatNativeCurrency,
} from "./formatters";

describe("locale-aware financial formatters", () => {
  it("groups decimal strings without converting them through Number", () => {
    expect(formatDecimalString("123456789.123456", "en")).toBe(
      "123,456,789.123456",
    );
    expect(formatDecimalString("-0.500000", "cn")).toBe("-0.500000");
    expect(formatDecimalString("100000000000000000000.25", "en")).toBe(
      "100,000,000,000,000,000,000.25",
    );
  });

  it("formats native currency independently for USD and CAD", () => {
    expect(formatNativeCurrency("1234.5", "USD", "en")).toBe("$1,234.50");
    expect(formatNativeCurrency("1234.5", "CAD", "en")).toBe("CA$1,234.50");
    expect(formatNativeCurrency("1234.5", "USD", "cn")).toBe("US$1,234.50");
  });

  it("formats date-only values in a stable UTC calendar", () => {
    expect(formatDate("2026-01-05", "en")).toBe("Jan 5, 2026");
    expect(formatDate("2026-01-05", "cn")).toBe("2026年1月5日");
  });
});
