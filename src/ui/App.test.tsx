// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

afterEach(() => {
  cleanup();
  window.location.hash = "";
  vi.restoreAllMocks();
});

describe("App chrome", () => {
  it("renders every workflow in one document with anchor navigation", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/reports/latest") {
        return new Response(
          JSON.stringify({ report: null, currentRun: null }),
          { status: 200 },
        );
      }
      if (url === "/api/reports") {
        return new Response(JSON.stringify({ reports: [], nextCursor: null }), {
          status: 200,
        });
      }
      if (url === "/api/tickers") {
        return new Response(JSON.stringify({ tickers: [] }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    render(<App />);

    expect(
      screen.getByRole("link", { name: "Skip to report" }).getAttribute("href"),
    ).toBe("#main-content");
    expect(
      screen
        .getByRole("link", { name: "Close Move home" })
        .getAttribute("href"),
    ).toBe("#today");
    expect(
      screen.getByRole("link", { name: "Daily brief" }).getAttribute("href"),
    ).toBe("#today");
    expect(
      screen.getByRole("link", { name: "Archive" }).getAttribute("href"),
    ).toBe("#history");
    expect(
      screen.getByRole("link", { name: "Watchlist" }).getAttribute("href"),
    ).toBe("#watchlist");
    expect(
      screen.getByRole("link", { name: "Backfill" }).getAttribute("href"),
    ).toBe("#backfill");
    expect(
      await screen.findByRole("heading", { name: "Watchlist" }),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "History" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Backfill" })).toBeTruthy();
  });
});
