import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MoverDialog } from "./calendar/MoverDialog";
import { productFlowFixture } from "./fixtures/productFlow";
import { I18nProvider } from "./i18n/I18nProvider";
import { BackfillPage } from "./pages/BackfillPage";
import { CalendarPage } from "./pages/CalendarPage";
import { EventImportDialog } from "./pages/EventImportDialog";
import { PortfolioPage } from "./pages/PortfolioPage";

const renderProduct = (children: React.ReactNode, locale: "en" | "cn" = "en") =>
  renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>{children}</I18nProvider>,
  );

describe("Plan 3 product-flow fixture", () => {
  it("connects CSV preview data to Portfolio, Calendar mover details, and Backfill progress", () => {
    const importMarkup = renderProduct(
      <EventImportDialog
        isOpen
        onOpenChange={() => undefined}
        positionBasisRevision={
          productFlowFixture.importPreview.basePositionBasisRevision
        }
        initialPreview={productFlowFixture.importPreview}
      />,
    );
    expect(importMarkup).toContain("Rows: 1");
    expect(importMarkup).toContain("AAPL");
    expect(importMarkup).toContain("Valid");
    expect(importMarkup).toContain("<table");
    expect(importMarkup).toContain("<thead");

    const portfolioMarkup = renderProduct(
      <PortfolioPage initialPortfolio={productFlowFixture.portfolio} />,
    );
    expect(portfolioMarkup).toContain("AAPL");
    expect(portfolioMarkup).toContain("$400.20");
    expect(portfolioMarkup).toContain("苹果发布了新的产品更新。");
    expect(portfolioMarkup).toContain("<table");

    const mover = productFlowFixture.calendar.movers[0];
    if (!mover) throw new Error("fixture mover missing");
    const calendarMarkup = renderProduct(
      <CalendarPage
        initialCalendar={productFlowFixture.calendar}
        today="2026-07-11"
        initialAnchorDate="2026-07-10"
      />,
    );
    expect(calendarMarkup).toContain("+5.32%");
    expect(calendarMarkup).toContain('aria-haspopup="dialog"');

    const dialogMarkup = renderProduct(
      <MoverDialog
        selection={{ kind: "mover", event: mover }}
        onOpenChange={() => undefined}
        onSelect={() => undefined}
      />,
    );
    expect(dialogMarkup).toContain("苹果发布了新的产品更新。");
    expect(dialogMarkup).toContain("Movement");
    expect(dialogMarkup).toContain('aria-modal="true"');
    expect(dialogMarkup).toContain('aria-label="Close"');

    const backfillMarkup = renderProduct(
      <BackfillPage
        today="2026-07-11"
        initialJobs={[productFlowFixture.backfill]}
      />,
    );
    expect(backfillMarkup).toContain("Manual backfills");
    expect(backfillMarkup).toContain("Complete");
    expect(backfillMarkup).toContain("Processed: 1");
    expect(backfillMarkup).toContain('role="status"');
    expect(backfillMarkup).toContain('role="progressbar"');
  });

  it("keeps static labels bilingual while summaries remain Chinese", () => {
    const portfolioMarkup = renderProduct(
      <PortfolioPage initialPortfolio={productFlowFixture.portfolio} />,
      "cn",
    );
    expect(portfolioMarkup).toContain("美元合计");
    expect(portfolioMarkup).toContain("苹果发布了新的产品更新。");
    expect(portfolioMarkup).not.toContain("USD total");
  });
});
