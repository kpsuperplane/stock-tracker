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
  it("provides a skip link and a product wordmark", async () => {
    window.location.hash = "#/today";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ report: null, currentRun: null }), {
        status: 200,
      }),
    );

    render(<App />);

    expect(
      screen.getByRole("link", { name: "Skip to report" }).getAttribute("href"),
    ).toBe("#main-content");
    expect(screen.getByRole("link", { name: "Close Move home" })).toBeTruthy();
  });

  it("shows a helpful state for an unknown route", () => {
    window.location.hash = "#/missing";
    const fetchMock = vi.spyOn(globalThis, "fetch");

    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Page not found" }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Return to today" })
        .getAttribute("href"),
    ).toBe("#/today");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
