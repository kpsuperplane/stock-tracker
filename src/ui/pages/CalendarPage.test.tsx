import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  CalendarDividendDto,
  CalendarEarningsDto,
  CalendarMoverDto,
  CalendarReadModelDto,
} from "../../shared/contracts";
import { ApiClientError } from "../api";
import { MoverDialog } from "../calendar/MoverDialog";
import { summarizePeriodDividends } from "../calendar/PeriodDividendSummary";
import { I18nProvider } from "../i18n/I18nProvider";
import {
  CalendarPage,
  calendarErrorMessageKey,
  calendarLoadMoreDisabled,
  mergeCalendarPages,
} from "./CalendarPage";

const mover: CalendarMoverDto = {
  id: "mover-1",
  instrumentId: "instrument-1",
  symbol: "AAPL",
  companyName: "Apple Inc.",
  exchange: "NASDAQ",
  currency: "USD",
  quantityDecimal: "2",
  heldQuantityDecimal: "2",
  valuationDecimal: "400.20",
  latestTradingDate: "2026-07-10",
  currentRawCloseDecimal: "200.10",
  tradingDate: "2026-07-10",
  movement: {
    tradingDate: "2026-07-10",
    previousTradingDate: "2026-07-09",
    previousRawCloseDecimal: "190",
    currentRawCloseDecimal: "200.10",
    movementAmountDecimal: "10.10",
    movementPercentDecimal: "5.315789",
    rawCloseDifferenceDecimal: "10.10",
    basis: "split_adjusted_price_return",
    qualified: true,
  },
  summaryZhCn: "苹果公司发布了新的产品更新。",
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
};

const dividend: CalendarDividendDto = {
  id: "dividend-1",
  instrumentId: "instrument-1",
  symbol: "AAPL",
  companyName: "Apple Inc.",
  currency: "USD",
  exDate: "2026-07-10",
  paymentDate: "2026-07-20",
  amountPerShareDecimal: "0.25",
  heldQuantityDecimal: "2",
  expectedTotalValueDecimal: "0.50",
  eligible: true,
  status: "active",
  sourceUrl: "https://example.com/dividend",
  provider: "provider-x",
};

const earnings: CalendarEarningsDto = {
  id: "earnings-1",
  instrumentId: "instrument-1",
  symbol: "AAPL",
  companyName: "Apple Inc.",
  reportDate: "2026-07-12",
  fiscalDateEnding: "2026-06-30",
  epsEstimateDecimal: "1.42",
  currency: "USD",
  timeOfDay: "post-market",
  heldQuantityDecimal: "2",
  status: "active",
  provider: "alpha-vantage-earnings",
};

const calendar: CalendarReadModelDto = {
  startDate: "2026-07-01",
  endDate: "2026-07-31",
  asOfDate: "2026-07-11",
  locale: "en",
  actualTradingDates: ["2026-07-10"],
  movers: [mover],
  dividends: [dividend],
  earnings: [earnings],
  events: [
    { ...mover, kind: "mover" },
    { ...dividend, kind: "dividend" },
    { ...earnings, kind: "earnings" },
  ],
  pending: [],
  pendingFacts: [],
  splitReview: [],
  futureDividendStatus: "not_currently_known",
  earningsCoverageStatus: "current",
  conflicts: [],
  nextCursor: null,
};

describe("CalendarPage", () => {
  it("keeps a dimmed calendar shell in place during the initial load", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <CalendarPage today="2026-07-11" initialAnchorDate="2026-07-11" />
      </I18nProvider>,
    );

    expect(markup).toContain(
      'class="calendar-page__content calendar-page__content--loading"',
    );
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("calendar-grid calendar-grid--month");
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Loading calendar…");
  });

  it("renders dense month cells, signed movers, dividends, and dialog-ready buttons", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <CalendarPage
          initialCalendar={calendar}
          today="2026-07-11"
          initialAnchorDate="2026-07-11"
        />
      </I18nProvider>,
    );

    expect(markup).toContain('data-testid="calendar-page"');
    expect(markup).toContain("Market calendar");
    expect(markup).toContain("+5.32%");
    expect(markup).toContain("AAPL $0.50");
    expect(markup).toContain("AAPL · Earnings");
    expect(markup).toContain("Dividends: USD $0.50");
    expect(markup).not.toContain("Monthly dividends: USD $0.50");
    expect(markup).toContain("Dividend breakdown");
    expect(markup).toContain('role="radiogroup" aria-label="Calendar view"');
    expect(markup).toContain('aria-checked="true" data-value="month"');
    expect(markup).toContain('aria-checked="false" data-value="week"');
    expect(markup).toContain('aria-label="AAPL, Dividend, AAPL $0.50"');
    expect(markup).toContain('aria-label="AAPL, Earnings, AAPL · Earnings"');
    expect(markup).not.toContain(
      "Future dividend coverage is not currently known.",
    );
    expect(markup).not.toContain("Earnings coverage is not current.");
    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="AAPL, Mover, AAPL +5.32%"');
  });

  it("switches static labels to Chinese while retaining Chinese summaries", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="cn">
        <MoverDialog
          selection={{ kind: "mover", event: mover }}
          onOpenChange={() => undefined}
          onSelect={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("异动");
    expect(markup).toContain("苹果公司发布了新的产品更新。");
    expect(markup).toContain("https://example.com/apple");
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
    expect(markup).not.toContain("Mover");
    expect(markup).toContain('aria-label="关闭"');
  });

  it("shows native dividend totals and source details in the dialog", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <MoverDialog
          selection={{ kind: "dividend", event: dividend }}
          onOpenChange={() => undefined}
          onSelect={() => undefined}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("Ex-dividend date");
    expect(markup).toContain("Expected total");
    expect(markup).toContain("$0.50");
    expect(markup).toContain("https://example.com/dividend");
    expect(markup).toContain('target="_blank"');
    expect(markup).toContain('rel="noopener noreferrer"');
  });

  it("shows earnings timing, fiscal period, estimate, and provider details", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <MoverDialog
          selection={{ kind: "earnings", event: earnings }}
          onOpenChange={() => undefined}
          onSelect={() => undefined}
        />
      </I18nProvider>,
    );
    expect(markup).toContain("Report date");
    expect(markup).toContain("Fiscal period ending");
    expect(markup).toContain("EPS estimate");
    expect(markup).toContain("Post-market");
    expect(markup).toContain("$1.42");
    expect(markup).toContain("alpha-vantage-earnings");

    const chinese = renderToStaticMarkup(
      <I18nProvider initialLocale="cn">
        <MoverDialog
          selection={{ kind: "earnings", event: earnings }}
          onOpenChange={() => undefined}
          onSelect={() => undefined}
        />
      </I18nProvider>,
    );
    expect(chinese).toContain("财报日期");
    expect(chinese).toContain("盘后");
  });

  it("renders the week layout and pending date facts", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <CalendarPage
          initialCalendar={{
            ...calendar,
            events: [],
            movers: [],
            dividends: [],
            earnings: [],
            pending: [
              {
                kind: "market_fact",
                instrumentId: "instrument-2",
                symbol: "SHOP.TO",
                date: "2026-07-08",
                status: "pending",
                message: "Waiting for close.",
              },
            ],
          }}
          today="2026-07-11"
          initialView="week"
          initialAnchorDate="2026-07-08"
        />
      </I18nProvider>,
    );

    expect(markup).toContain("Week");
    expect(markup).toContain("Dividends: $0.00");
    expect(markup).toContain('aria-checked="true" data-value="week"');
    expect(markup).toContain("Market data pending: Waiting for close.");
  });

  it("totals period dividends exactly by native currency", () => {
    const summary = summarizePeriodDividends(
      [
        dividend,
        {
          ...dividend,
          id: "dividend-2",
          symbol: "MSFT",
          expectedTotalValueDecimal: "0.20",
        },
        {
          ...dividend,
          id: "dividend-3",
          symbol: "SHOP.TO",
          currency: "CAD",
          expectedTotalValueDecimal: "1.25",
        },
        {
          ...dividend,
          id: "dividend-4",
          symbol: "UNKNOWN",
          expectedTotalValueDecimal: null,
        },
        {
          ...dividend,
          id: "dividend-outside",
          exDate: "2026-08-01",
          expectedTotalValueDecimal: "100",
        },
      ],
      "2026-07-01",
      "2026-07-31",
    );

    expect(summary.totals).toEqual({ USD: "0.7", CAD: "1.25" });
    expect(summary.dividends).toHaveLength(4);
    expect(summary.unavailableCount).toBe(1);
  });

  it("discloses busy dates and keeps an empty range on the calendar", () => {
    const busy = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <CalendarPage
          initialCalendar={{
            ...calendar,
            events: [
              ...calendar.events,
              { ...mover, id: "mover-2", symbol: "MSFT", kind: "mover" },
              { ...mover, id: "mover-3", symbol: "NVDA", kind: "mover" },
            ],
          }}
          today="2026-07-11"
          initialAnchorDate="2026-07-11"
        />
      </I18nProvider>,
    );
    expect(busy).toContain("+1 more events");

    const empty = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <CalendarPage
          initialCalendar={{
            ...calendar,
            events: [],
            movers: [],
            dividends: [],
            earnings: [],
            pending: [],
          }}
          today="2026-07-11"
        />
      </I18nProvider>,
    );
    expect(empty).toContain("calendar-grid calendar-grid--month");
  });

  it("surfaces paginated calendar ranges and merges subsequent pages", () => {
    const paginated = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <CalendarPage
          initialCalendar={{ ...calendar, nextCursor: "cursor-2" }}
          today="2026-07-11"
        />
      </I18nProvider>,
    );
    expect(paginated).toContain("Load more calendar events");
    expect(paginated).toContain("This range has more events.");

    const merged = mergeCalendarPages(
      {
        ...calendar,
        earnings: [],
        events: [{ ...mover, kind: "mover" }],
      },
      {
        ...calendar,
        actualTradingDates: ["2026-07-11"],
        events: [
          { ...dividend, kind: "dividend" },
          { ...earnings, kind: "earnings" },
        ],
        movers: [],
        dividends: [dividend],
        earnings: [earnings],
        nextCursor: null,
      },
    );
    expect(merged.events).toHaveLength(3);
    expect(merged.earnings).toEqual([earnings]);
    expect(merged.actualTradingDates).toEqual(["2026-07-10", "2026-07-11"]);
    expect(merged.nextCursor).toBeNull();
    expect(calendarLoadMoreDisabled(false, false, false)).toBe(false);
    expect(calendarLoadMoreDisabled(true, false, false)).toBe(true);
    expect(calendarLoadMoreDisabled(false, true, false)).toBe(true);
    expect(calendarLoadMoreDisabled(false, false, true)).toBe(true);
    expect(calendarLoadMoreDisabled(false, false, false, true)).toBe(true);
  });

  it("keeps sync warnings and banners off the calendar", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <CalendarPage
          initialCalendar={{
            ...calendar,
            earningsCoverageStatus: "unavailable",
          }}
          today="2026-07-11"
        />
      </I18nProvider>,
    );
    expect(markup).not.toContain("Earnings coverage is not current.");
    expect(markup).not.toContain(
      "Scheduled earnings dates may be incomplete until the next successful Alpha Vantage refresh.",
    );
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("Close popover");
  });

  it("uses error severity for failed facts and conflict codes", () => {
    const moverError = {
      ...mover,
      freshness: "error" as const,
      analysisStatus: "error" as const,
    };
    const dividendError = { ...dividend, status: "error" as const };
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <div>
          <MoverDialog
            selection={{ kind: "mover", event: moverError }}
            onOpenChange={() => undefined}
            onSelect={() => undefined}
          />
          <MoverDialog
            selection={{ kind: "dividend", event: dividendError }}
            onOpenChange={() => undefined}
            onSelect={() => undefined}
          />
        </div>
      </I18nProvider>,
    );
    expect(
      markup.match(/data-variant="error"/g)?.length,
    ).toBeGreaterThanOrEqual(3);
    expect(markup).toContain('aria-label="Close"');
    expect(markup).toContain(">Error<");
    const cnDividendMarkup = renderToStaticMarkup(
      <I18nProvider initialLocale="cn">
        <MoverDialog
          selection={{ kind: "dividend", event: dividendError }}
          onOpenChange={() => undefined}
          onSelect={() => undefined}
        />
      </I18nProvider>,
    );
    expect(cnDividendMarkup).toContain(">错误<");
    expect(cnDividendMarkup).not.toContain(">error<");
  });

  it("maps read-model failures to explicit copy", () => {
    expect(
      calendarErrorMessageKey(
        new ApiClientError(
          "disabled",
          404,
          "read_model_disabled",
          {},
          new Headers(),
        ),
      ),
    ).toBe("calendarReadModelDisabled");
    expect(calendarErrorMessageKey(new Error("network"))).toBe(
      "calendarLoadError",
    );
  });
});
