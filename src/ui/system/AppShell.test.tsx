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
    expect(markup).toContain('aria-label="折叠侧边栏"');
    expect(markup).not.toContain(">Portfolio<");
  });

  it("keeps both language choices visible and named in the collapsed rail", () => {
    const markup = renderToStaticMarkup(
      <ProductApp
        initialPath="/portfolio"
        initialLocale="cn"
        initialSidebarCollapsed
      />,
    );

    expect(markup).toContain('aria-label="EN"');
    expect(markup).toContain('aria-label="中文"');
    expect(markup).toContain(">EN</span>");
    expect(markup).toContain(">中</span>");
    expect(markup).toContain('aria-label="展开侧边栏"');
  });
});
