import { describe, expect, it } from "vitest";
import { isNewProductUiEnabled } from "./featureFlags";

describe("new product UI feature flag", () => {
  it("is disabled by default and only enables for an explicit true value", () => {
    expect(isNewProductUiEnabled(undefined)).toBe(false);
    expect(isNewProductUiEnabled("false")).toBe(false);
    expect(isNewProductUiEnabled("TRUE")).toBe(false);
    expect(isNewProductUiEnabled("true")).toBe(true);
  });
});
