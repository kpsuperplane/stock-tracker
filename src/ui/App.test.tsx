import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App feature-flag boundary", () => {
  it("keeps the legacy dashboard when the product shell flag is unset", () => {
    const markup = renderToStaticMarkup(<App />);

    expect(markup).toContain('id="main-content"');
    expect(markup).toContain('id="history"');
    expect(markup).toContain('id="watchlist"');
    expect(markup).not.toContain('data-testid="product-app-shell"');
  });
});
