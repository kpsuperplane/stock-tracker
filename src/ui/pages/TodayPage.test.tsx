import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PortfolioReadModelDto } from "../../shared/contracts";
import { ApiClientError } from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import {
  formatSignedDecimal,
  movementTone,
  sortPortfolioPositions,
  TodayPage,
  todayErrorMessageKey,
} from "./TodayPage";

const portfolio: PortfolioReadModelDto = {
  asOfDate: "2026-07-11",
  latestTradingDate: "2026-07-10",
  actualTradingDates: ["2026-07-10"],
  locale: "en",
  totals: { USD: "1000.5", CAD: "2000" },
  freshness: "stale",
  conflicts: [
    {
      code: "market_fact_stale",
      message: "A close is stale.",
      instrumentId: "instrument-2",
    },
  ],
  nextCursor: null,
  positions: [
    {
      instrumentId: "instrument-1",
      symbol: "AAPL",
      companyName: "Apple Inc.",
      exchange: "NASDAQ",
      currency: "USD",
      quantityDecimal: "2.5",
      valuationDecimal: "1000.5",
      latestTradingDate: "2026-07-10",
      currentRawCloseDecimal: "400.2",
      movement: {
        tradingDate: "2026-07-10",
        previousTradingDate: "2026-07-09",
        previousRawCloseDecimal: "380",
        currentRawCloseDecimal: "400.2",
        movementAmountDecimal: "20.2",
        movementPercentDecimal: "5.315789",
        rawCloseDifferenceDecimal: "20.2",
        basis: "split_adjusted_price_return",
        qualified: true,
      },
      summaryZhCn: "苹果发布了新的产品更新。",
      analysisStatus: "complete",
      sources: [
        {
          title: "Apple News",
          publisher: "Example",
          publishedAt: "2026-07-10T12:00:00.000Z",
          sourceUrl: "https://example.com/apple",
          cited: true,
        },
      ],
      freshness: "fresh",
      conflicts: [],
    },
    {
      instrumentId: "instrument-2",
      symbol: "SHOP.TO",
      companyName: "Shopify Inc.",
      exchange: "TSX",
      currency: "CAD",
      quantityDecimal: "0.5",
      valuationDecimal: null,
      latestTradingDate: "2026-07-10",
      currentRawCloseDecimal: null,
      movement: {
        tradingDate: "2026-07-10",
        previousTradingDate: "2026-07-09",
        previousRawCloseDecimal: null,
        currentRawCloseDecimal: null,
        movementAmountDecimal: "-4",
        movementPercentDecimal: "-2",
        rawCloseDifferenceDecimal: null,
        basis: "split_adjusted_price_return",
        qualified: false,
      },
      summaryZhCn: null,
      analysisStatus: "error",
      sources: [],
      freshness: "stale",
      conflicts: [
        {
          code: "invalid_close_decimal",
          message: "The stored close is invalid.",
          instrumentId: "instrument-2",
        },
      ],
    },
  ],
};

describe("TodayPage", () => {
  it("renders the completed date, movement, Chinese summary, sources, and stale state", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <TodayPage initialPortfolio={portfolio} />
      </I18nProvider>,
    );

    expect(markup).toContain('data-testid="today-page"');
    expect(markup).not.toContain("USD total");
    expect(markup).not.toContain("CAD total");
    expect(markup).toContain("close Jul 10, 2026");
    expect(markup).toContain("AAPL");
    expect(markup).not.toContain("Apple Inc.");
    expect(markup).not.toContain("Shopify Inc.");
    expect(markup.indexOf("AAPL")).toBeLessThan(markup.indexOf("SHOP.TO"));
    expect(markup).toContain("+5.32%");
    expect(markup).toContain("+$20.20");
    expect(markup).toContain("苹果发布了新的产品更新。");
    expect(markup).toContain("https://example.com/apple");
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).toContain(">Sources<");
    expect(markup).toContain('colSpan="5"');
    expect(markup).not.toContain("Movement basis:");
    expect(markup).not.toContain("Previous close:");
    expect(markup).not.toContain(">Summary<");
    expect(markup).not.toContain("Trading date");
    expect(markup).not.toContain("Freshness");
    expect(markup).not.toContain("Under ±5% threshold");
    expect(markup).toContain("A close is stale.");
  });

  it("keeps stored Chinese summaries while translating static labels to CN", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="cn">
        <TodayPage initialPortfolio={portfolio} />
      </I18nProvider>,
    );

    expect(markup).not.toContain("美元合计");
    expect(markup).not.toContain("加元合计");
    expect(markup).toContain("苹果发布了新的产品更新。");
    expect(markup).toContain(">来源<");
    expect(markup).toContain('colSpan="5"');
    expect(markup).not.toContain("交易日期");
    expect(markup).not.toContain("新鲜度");
    expect(markup).not.toContain("低于 ±5% 阈值");
    expect(markup).not.toContain("超过 ±5% 阈值");
    expect(markup).not.toContain("USD total");
  });

  it("shows a loading state without an SSR payload and an explicit zero-position state", () => {
    const loading = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <TodayPage />
      </I18nProvider>,
    );
    expect(loading).toContain("Loading Today");

    const empty = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <TodayPage
          initialPortfolio={{
            ...portfolio,
            positions: [],
            totals: { USD: "0", CAD: "0" },
            freshness: "unavailable",
            conflicts: [],
          }}
        />
      </I18nProvider>,
    );
    expect(empty).toContain("No current holdings");
  });
});

describe("portfolio movement formatters", () => {
  it("sorts positions by descending movement and puts missing values last", () => {
    const positivePosition = portfolio.positions.find(
      (position) => position.symbol === "AAPL",
    );
    const negativePosition = portfolio.positions.find(
      (position) => position.symbol === "SHOP.TO",
    );
    if (!positivePosition || !negativePosition) {
      throw new Error("test portfolio fixtures are incomplete");
    }
    const missingMovement = {
      ...negativePosition,
      instrumentId: "instrument-3",
      symbol: "NVDA",
      movement: null,
    };

    expect(
      sortPortfolioPositions([
        negativePosition,
        missingMovement,
        positivePosition,
      ]).map((position) => position.symbol),
    ).toEqual(["AAPL", "SHOP.TO", "NVDA"]);
  });

  it("preserves signed decimal strings and identifies direction", () => {
    expect(formatSignedDecimal("5.315789", "en")).toBe("+5.32");
    expect(formatSignedDecimal("-2", "cn")).toBe("-2");
    expect(formatSignedDecimal("-0.000", "en")).toBe("0.00");
    expect(movementTone(portfolio.positions[0]?.movement ?? null)).toBe(
      "positive",
    );
    expect(movementTone(portfolio.positions[1]?.movement ?? null)).toBe(
      "negative",
    );
    expect(
      movementTone({
        ...(portfolio.positions[1]?.movement as NonNullable<
          PortfolioReadModelDto["positions"][number]["movement"]
        >),
        movementPercentDecimal: "-0.000",
      }),
    ).toBe("neutral");
    expect(
      todayErrorMessageKey(
        new ApiClientError(
          "disabled",
          404,
          "read_model_disabled",
          {},
          new Headers(),
        ),
      ),
    ).toBe("todayReadModelDisabled");
  });
});
