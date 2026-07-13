import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  PortfolioHistoryCurrencyDto,
  PortfolioHistoryReadModelDto,
} from "../../shared/contracts";
import { ApiClientError } from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import {
  PortfolioPage,
  portfolioHistoryErrorMessageKey,
} from "./PortfolioPage";

const currencyResult: PortfolioHistoryCurrencyDto = {
  currency: "CAD",
  summaries: {
    totalValue: { valueDecimal: "1250", periodDeltaDecimal: "125" },
    realizedGains: { valueDecimal: "80", periodDeltaDecimal: "30" },
    unrealizedGains: { valueDecimal: "250", periodDeltaDecimal: "75" },
    dividends: { valueDecimal: "42.5", periodDeltaDecimal: "12.5" },
  },
  points: [
    {
      date: "2025-07-10",
      totalValueDecimal: "1125",
      realizedGainsDecimal: "50",
      unrealizedGainsDecimal: "175",
      dividendsDecimal: "30",
      status: "complete",
    },
    {
      date: "2026-07-10",
      totalValueDecimal: "1250",
      realizedGainsDecimal: "80",
      unrealizedGainsDecimal: "250",
      dividendsDecimal: "42.5",
      status: "estimated",
    },
  ],
  positions: [
    {
      instrumentId: "aapl",
      symbol: "AAPL",
      companyName: "Apple Inc.",
      exchange: "NASDAQ",
      currency: "CAD",
      quantityDecimal: "5",
      averageCostDecimal: "200",
      bookCostDecimal: "1000",
      marketValueDecimal: "1250",
      unrealizedGainDecimal: "250",
      realizedGainDecimal: "80",
      dividendsDecimal: "42.5",
      latestPriceDecimal: "250",
      latestPriceDate: "2026-07-10",
      valuationStatus: "estimated",
    },
  ],
  granularity: "daily",
  coverage: {
    status: "estimated",
    missingPrices: [],
    splitConflicts: [],
    dividendRefresh: [],
  },
};

const history: PortfolioHistoryReadModelDto = {
  range: "1y",
  startDate: "2025-07-10",
  endDate: "2026-07-10",
  dataThrough: "2026-07-10",
  locale: "en",
  currencies: [
    currencyResult,
    {
      ...currencyResult,
      currency: "USD",
      positions: [],
      coverage: { ...currencyResult.coverage, status: "complete" },
    },
  ],
};

describe("PortfolioPage", () => {
  it("renders the default Total value, 1Y, CAD view and exact data tables", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <PortfolioPage
          initialHistory={history}
          initialState={{ metric: "totalValue", range: "1y", currency: "CAD" }}
        />
      </I18nProvider>,
    );

    expect(markup).toContain('data-testid="portfolio-page"');
    expect(markup).toContain("Total value");
    expect(markup).toContain("Realized gains");
    expect(markup).toContain("Unrealized gains");
    expect(markup).toContain("Dividends");
    expect(markup).toContain("CA$1,250.00");
    expect(markup).toContain("+CA$125.00");
    expect(markup).toContain("1Y");
    expect(markup).toContain("CAD");
    expect(markup).toContain("USD");
    expect(markup).toContain("Download portfolio data");
    expect(markup).toContain('role="combobox" aria-label="Select date range"');
    expect(markup).not.toContain("Close popover");
    expect(markup).not.toContain("Track securities value");
    expect(markup).not.toContain("Data through");
    expect(markup).not.toContain("Show chart data");
    expect(markup).toContain("Holdings at range end");
    expect(markup).toContain("AAPL");
    expect(markup).toContain("Apple Inc.");
    expect(markup).toContain("Some values use transaction-price estimates");
    expect(markup).toContain("Total value performance chart");
  });

  it("renders bilingual performance copy and empty-scope guidance", () => {
    const chinese = renderToStaticMarkup(
      <I18nProvider initialLocale="cn">
        <PortfolioPage
          initialHistory={{ ...history, locale: "cn" }}
          initialState={{ metric: "dividends", range: "all", currency: "CAD" }}
        />
      </I18nProvider>,
    );
    expect(chinese).toContain("总市值");
    expect(chinese).toContain("已实现收益");
    expect(chinese).toContain("下载投资组合数据");

    const empty = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <PortfolioPage
          initialHistory={{ ...history, currencies: [] }}
          initialState={{ metric: "totalValue", range: "1y" }}
        />
      </I18nProvider>,
    );
    expect(empty).toContain("No portfolio transactions in this scope");
    expect(empty).toContain('href="/events"');
  });

  it("distinguishes a disabled history endpoint from retryable failures", () => {
    expect(
      portfolioHistoryErrorMessageKey(
        new ApiClientError(
          "disabled",
          404,
          "portfolio_history_disabled",
          {},
          new Headers(),
        ),
      ),
    ).toBe("portfolioHistoryDisabled");
    expect(portfolioHistoryErrorMessageKey(new Error("network"))).toBe(
      "portfolioHistoryLoadError",
    );
  });
});
