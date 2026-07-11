import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { EventsTimelineDto } from "../../shared/contracts";
import { I18nProvider } from "../i18n/I18nProvider";
import { EventImportDialog } from "./EventImportDialog";
import { EventsPage, resolveMutationBasisRevision } from "./EventsPage";

const timeline: EventsTimelineDto = {
  positionBasisRevision: 4,
  nextCursor: null,
  events: [
    {
      type: "transaction",
      id: "tx-1",
      instrumentId: "instrument-1",
      symbol: "AAPL",
      companyName: "Apple Inc.",
      currency: "USD",
      tradeDate: "2026-07-10",
      side: "buy",
      quantityDecimal: "2",
      priceDecimal: "200",
      revision: 1,
      createdAt: "2026-07-10T20:00:00.000Z",
      updatedAt: "2026-07-10T20:00:00.000Z",
    },
    {
      type: "split",
      id: "split-1",
      instrumentId: "instrument-1",
      symbol: "AAPL",
      companyName: "Apple Inc.",
      currency: "USD",
      effectiveDate: "2020-08-31",
      numerator: "4",
      denominator: "1",
      provider: "yahoo",
      providerEventId: "split-1",
      providerRevision: "2026-07-10",
      retrievedAt: "2026-07-10T20:00:00.000Z",
      revision: 2,
      status: "active",
      conflictCode: null,
      conflictMessage: null,
    },
  ],
};

describe("EventsPage", () => {
  it("uses the confirmed basis revision for a split-review retry", () => {
    expect(resolveMutationBasisRevision(4, 5)).toBe(5);
    expect(resolveMutationBasisRevision(4)).toBe(4);
  });

  it("renders dense transaction and split rows from the stable timeline contract", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <EventsPage initialTimeline={timeline} />
      </I18nProvider>,
    );

    expect(markup).toContain('data-testid="events-page"');
    expect(markup).toContain("AAPL");
    expect(markup).toContain("Apple Inc.");
    expect(markup).toContain("Buy");
    expect(markup).toContain("Split");
    expect(markup).toContain("Active");
    expect(markup).toContain("Import CSV");
  });

  it("keeps empty states explicit and bilingual", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="cn">
        <EventsPage
          initialTimeline={{
            events: [],
            nextCursor: null,
            positionBasisRevision: 0,
          }}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("没有找到投资组合事件");
    expect(markup).toContain("添加交易");
  });
});

describe("EventImportDialog", () => {
  it("documents the template and review-first import flow", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <EventImportDialog
          isOpen
          onOpenChange={() => undefined}
          positionBasisRevision={3}
        />
      </I18nProvider>,
    );

    expect(markup).toContain("Import portfolio events");
    expect(markup).toContain("Download template");
    expect(markup).toContain("Preview import");
    expect(markup).toContain("trade_date,symbol,side,quantity,price");
  });
});
