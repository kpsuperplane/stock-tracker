import { describe, expect, it } from "vitest";
import { gapBridgePath } from "./PortfolioPerformanceChart";

describe("gapBridgePath", () => {
  it("bridges each internal run of missing chart points", () => {
    expect(
      gapBridgePath([
        { x: 0, y: null },
        { x: 10, y: 15 },
        { x: 20, y: null },
        { x: 30, y: null },
        { x: 40, y: 25 },
        { x: 50, y: 30 },
        { x: 60, y: null },
        { x: 70, y: 20 },
        { x: 80, y: null },
      ]),
    ).toBe("M 10 15 L 40 25 M 50 30 L 70 20");
  });

  it("does not add a bridge when every adjacent point is defined", () => {
    expect(
      gapBridgePath([
        { x: 0, y: 10 },
        { x: 10, y: 20 },
      ]),
    ).toBeNull();
  });
});
