import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductApp } from "./AppShell";

describe("product AppShell", () => {
  it("renders the calendar route with an active, keyboard-reachable nav item", () => {
    const markup = renderToStaticMarkup(
      <ProductApp initialPath="/calendar" initialLocale="en" />,
    );

    expect(markup).toContain('data-testid="product-app-shell"');
    expect(markup).toContain('href="/calendar"');
    expect(markup).toContain('aria-current="page"');
    expect(markup).toContain("Calendar");
    expect(markup).toContain('aria-label="Language"');
    expect(markup).toContain("中文");
    expect(markup).not.toContain("legacy-app");
  });

  it("renders Chinese navigation copy when CN is selected", () => {
    const markup = renderToStaticMarkup(
      <ProductApp initialPath="/portfolio" initialLocale="cn" />,
    );

    expect(markup).toContain("投资组合");
    expect(markup).toContain("事件");
    expect(markup).toContain("日历");
    expect(markup).toContain("回补");
    expect(markup).toContain('aria-label="导航"');
    expect(markup).not.toContain(">Portfolio<");
  });

  it("renders the product navigation as a horizontal top nav", () => {
    const markup = renderToStaticMarkup(
      <ProductApp initialPath="/portfolio" initialLocale="en" />,
    );

    expect(markup).toContain('aria-label="Navigation"');
    expect(markup).toContain('href="/portfolio"');
    expect(markup).toContain('href="/events"');
    expect(markup).toContain('href="/calendar"');
    expect(markup).toContain('href="/backfill"');
    expect(markup).not.toContain("product-sidebar");
  });
});
