import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  CalendarDividendDto,
  CalendarMoverDto,
  CalendarReadModelDto,
} from "../../shared/contracts";
import { ApiClientError } from "../api";
import { MoverDialog } from "../calendar/MoverDialog";
import { I18nProvider } from "../i18n/I18nProvider";
import {
  CalendarPage,
  calendarConflictBannerStatus,
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

const calendar: CalendarReadModelDto = {
  startDate: "2026-07-01",
  endDate: "2026-07-31",
  asOfDate: "2026-07-11",
  locale: "en",
  actualTradingDates: ["2026-07-10"],
  movers: [mover],
  dividends: [dividend],
  events: [
    { ...mover, kind: "mover" },
    { ...dividend, kind: "dividend" },
  ],
  pending: [],
  pendingFacts: [],
  splitReview: [],
  futureDividendStatus: "not_currently_known",
  conflicts: [],
  nextCursor: null,
};

describe("CalendarPage", () => {
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
    expect(markup).toContain("AAPL $0.25");
    expect(markup).toContain(
      "Future dividend coverage is not currently known.",
    );
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

  it("renders the week layout and pending date facts", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <CalendarPage
          initialCalendar={{
            ...calendar,
            events: [],
            movers: [],
            dividends: [],
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
    expect(markup).toContain("Market data pending: Waiting for close.");
    expect(markup).not.toContain("No movers or dividends in this range.");
  });

  it("discloses busy dates and keeps a truly empty range explicit", () => {
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
            pending: [],
          }}
          today="2026-07-11"
        />
      </I18nProvider>,
    );
    expect(empty).toContain("No movers or dividends in this range.");
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
      { ...calendar, events: [{ ...mover, kind: "mover" }] },
      {
        ...calendar,
        actualTradingDates: ["2026-07-11"],
        events: [{ ...dividend, kind: "dividend" }],
        movers: [],
        dividends: [dividend],
        nextCursor: null,
      },
    );
    expect(merged.events).toHaveLength(2);
    expect(merged.actualTradingDates).toEqual(["2026-07-10", "2026-07-11"]);
    expect(merged.nextCursor).toBeNull();
    expect(calendarLoadMoreDisabled(false, false, false)).toBe(false);
    expect(calendarLoadMoreDisabled(true, false, false)).toBe(true);
    expect(calendarLoadMoreDisabled(false, true, false)).toBe(true);
    expect(calendarLoadMoreDisabled(false, false, true)).toBe(true);
    expect(calendarLoadMoreDisabled(false, false, false, true)).toBe(true);
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
    expect(
      calendarConflictBannerStatus([
        { code: "legacy_movement_basis", message: "legacy" },
      ]),
    ).toBe("warning");
    expect(
      calendarConflictBannerStatus([
        { code: "market_fact_error", message: "failed" },
      ]),
    ).toBe("error");
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
