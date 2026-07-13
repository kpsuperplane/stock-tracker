import { describe, expect, it } from "vitest";
import {
  APP_ROUTES,
  type AppRoute,
  isPlainLeftClick,
  pathForRoute,
  routeForPath,
} from "./routing";

describe("product routing", () => {
  it("exposes stable destinations for each product page", () => {
    const expected: Record<AppRoute, string> = {
      portfolio: "/portfolio",
      events: "/events",
      calendar: "/calendar",
      status: "/status",
      accounts: "/accounts",
    };

    expect(APP_ROUTES.map((route) => route.id)).toEqual([
      "portfolio",
      "events",
      "calendar",
      "status",
      "accounts",
    ]);
    for (const [route, path] of Object.entries(expected) as Array<
      [AppRoute, string]
    >) {
      expect(pathForRoute(route)).toBe(path);
      expect(routeForPath(path)).toBe(route);
      expect(routeForPath(`${path}/`)).toBe(route);
      expect(routeForPath(`${path}?view=week#today`)).toBe(route);
    }
  });

  it("falls back to Portfolio for the root and unknown paths", () => {
    expect(routeForPath("/")).toBe("portfolio");
    expect(routeForPath("/backfill")).toBe("portfolio");
    expect(routeForPath("/unknown")).toBe("portfolio");
    expect(routeForPath("not-a-path")).toBe("portfolio");
  });

  it("only intercepts unmodified primary-button clicks", () => {
    const plain = {
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    };
    expect(isPlainLeftClick(plain)).toBe(true);
    expect(isPlainLeftClick({ ...plain, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...plain, metaKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plain, ctrlKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plain, shiftKey: true })).toBe(false);
    expect(isPlainLeftClick({ ...plain, altKey: true })).toBe(false);
  });
});
