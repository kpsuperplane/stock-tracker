import { describe, expect, it } from "vitest";
import {
  APP_ROUTES,
  type AppRoute,
  isPlainLeftClick,
  pathForRoute,
  routeForPath,
  sharedScopeSearch,
} from "./routing";

describe("product routing", () => {
  it("exposes stable destinations for each product page", () => {
    const expected: Record<AppRoute, string> = {
      today: "/today",
      portfolio: "/portfolio",
      events: "/events",
      calendar: "/calendar",
      status: "/status",
      accounts: "/accounts",
    };

    expect(APP_ROUTES.map((route) => route.id)).toEqual([
      "today",
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

  it("falls back to Today for the root and unknown paths", () => {
    expect(routeForPath("/")).toBe("today");
    expect(routeForPath("/backfill")).toBe("today");
    expect(routeForPath("/unknown")).toBe("today");
    expect(routeForPath("not-a-path")).toBe("today");
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

  it("carries only shared account scope between product routes", () => {
    expect(
      sharedScopeSearch(
        "?scopeType=account&scopeId=brokerage&range=1y&metric=dividends&currency=CAD",
      ),
    ).toBe("?scopeType=account&scopeId=brokerage");
    expect(sharedScopeSearch("?range=30d&metric=totalValue")).toBe("");
  });
});
