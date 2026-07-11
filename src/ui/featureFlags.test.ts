import { describe, expect, it } from "vitest";
import { isNewProductUiEnabled } from "./featureFlags";

describe("new product UI feature flag", () => {
  it("only enables for an explicit true value and mirrors the build flag", () => {
    expect(isNewProductUiEnabled("false")).toBe(false);
    expect(isNewProductUiEnabled("TRUE")).toBe(false);
    expect(isNewProductUiEnabled("true")).toBe(true);
    expect(isNewProductUiEnabled()).toBe(
      (import.meta.env.VITE_NEW_PRODUCT_UI as string | undefined) === "true",
    );
  });
});
