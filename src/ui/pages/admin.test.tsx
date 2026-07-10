// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackfillPage } from "./BackfillPage";
import { WatchlistPage } from "./WatchlistPage";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("admin pages", () => {
  it("shows a composed watchlist loading state before the first response", () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>(() => undefined),
    );

    render(<WatchlistPage />);

    expect(screen.getByRole("status").textContent).toContain(
      "Loading watchlist",
    );
    expect(screen.queryByText("Build your coverage list")).toBeNull();
  });

  it("uppercases a symbol before submitting", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ tickers: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ticker: {
              id: "shop",
              symbol: "SHOP.TO",
              companyName: "Shopify Inc.",
              exchange: "TOR",
              currency: "CAD",
              active: true,
            },
          }),
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tickers: [
              {
                id: "shop",
                symbol: "SHOP.TO",
                companyName: "Shopify Inc.",
                exchange: "TOR",
                currency: "CAD",
                active: true,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    render(<WatchlistPage />);
    await screen.findByText("0/100 active");
    await userEvent.type(screen.getByLabelText("Yahoo symbol"), "shop.to");
    await userEvent.click(screen.getByRole("button", { name: "Add ticker" }));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      symbol: "SHOP.TO",
    });
    expect(await screen.findByText("Shopify Inc. · TOR · CAD")).toBeTruthy();
  });

  it("blocks a 31-day backfill in the browser", async () => {
    render(<BackfillPage />);
    await userEvent.type(screen.getByLabelText("Start date"), "2026-06-01");
    await userEvent.type(screen.getByLabelText("End date"), "2026-07-01");
    await userEvent.click(
      screen.getByRole("button", { name: "Start backfill" }),
    );
    expect(screen.getByRole("alert").textContent).toContain("30 calendar days");
  });
});
