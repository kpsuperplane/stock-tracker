// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoverCard } from "./MoverCard";

const mover = {
  screeningId: "shop",
  symbol: "SHOP.TO",
  companyName: "Shopify Inc.",
  exchange: "TOR",
  currency: "CAD",
  currentPrice: 174.45,
  changeAmount: 12.03,
  changePct: 7.4,
  explanationZhCn: "企业客户增长及分析师上调目标价可能推动上涨。",
  confidence: "high" as const,
  clearCatalyst: true,
  analysisStatus: "complete" as const,
  sources: [
    {
      title: "Shopify shares jump after enterprise update",
      publisher: "Reuters",
      publishedAt: "2026-07-09T18:30:00.000Z",
      url: "https://news/1",
      cited: true,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MoverCard", () => {
  it("shows direction without relying on color and expands English sources", async () => {
    render(<MoverCard mover={mover} />);
    expect(screen.getByText("↑ +7.40%")).toBeTruthy();
    expect(screen.queryByText(/Shopify shares jump/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Show 1 source" }));
    expect(
      screen
        .getByRole("link", { name: /Shopify shares jump/ })
        .getAttribute("rel"),
    ).toBe("noreferrer noopener");
  });

  it("distinguishes no sources from no clear catalyst and unavailable analysis", () => {
    const { rerender } = render(
      <MoverCard
        mover={{
          ...mover,
          explanationZhCn: null,
          confidence: "low",
          clearCatalyst: false,
          sources: [],
        }}
      />,
    );
    expect(screen.getByText("No relevant sources found")).toBeTruthy();
    rerender(
      <MoverCard
        mover={{
          ...mover,
          explanationZhCn: null,
          analysisStatus: "unavailable",
          clearCatalyst: null,
        }}
      />,
    );
    expect(screen.getByText("Explanation unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry explanation" })).toBeTruthy();
  });

  it("invokes retry for unavailable analysis", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ queued: true }), { status: 202 }));
    render(
      <MoverCard mover={{ ...mover, analysisStatus: "unavailable" }} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry explanation" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/screenings/shop/retry",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
