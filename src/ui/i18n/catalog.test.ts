import { describe, expect, it } from "vitest";
import { type Locale, messageCatalog } from "./catalog";

describe("static locale catalog", () => {
  it("contains the product destinations and language control in both locales", () => {
    const requiredKeys = [
      "appName",
      "navigation",
      "portfolio",
      "events",
      "calendar",
      "accounts",
      "language",
      "english",
      "chinese",
      "collapseSidebar",
      "expandSidebar",
    ] as const;

    for (const locale of ["en", "cn"] as Locale[]) {
      for (const key of requiredKeys) {
        expect(messageCatalog[locale][key]).toBeTruthy();
      }
    }
    expect(messageCatalog.en.portfolio).toBe("Portfolio");
    expect(messageCatalog.cn.portfolio).toBe("投资组合");
  });
});
