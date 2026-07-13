import { describe, expect, it } from "vitest";
import { parsePortfolioUrlState } from "./state";

describe("portfolio URL state", () => {
  it("restores supported metric, range, currency, and custom dates", () => {
    expect(
      parsePortfolioUrlState(
        "?metric=bookValue&range=custom&currency=USD&startDate=2025-01-01&endDate=2025-06-30",
      ),
    ).toEqual({
      metric: "bookValue",
      range: "custom",
      currency: "USD",
      startDate: "2025-01-01",
      endDate: "2025-06-30",
    });
  });

  it("falls back safely for unsupported or reversed state", () => {
    expect(
      parsePortfolioUrlState(
        "?metric=unknown&range=custom&currency=EUR&startDate=2025-06-30&endDate=2025-01-01",
      ),
    ).toEqual({ metric: "totalValue", range: "custom" });
    expect(parsePortfolioUrlState("?range=unknown")).toEqual({
      metric: "totalValue",
      range: "1y",
    });
  });
});
