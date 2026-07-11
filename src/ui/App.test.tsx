import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";
import { isNewProductUiEnabled } from "./featureFlags";

describe("App feature-flag boundary", () => {
  it("keeps the legacy dashboard by default and renders the product shell when enabled", () => {
    const markup = renderToStaticMarkup(<App />);

    if (isNewProductUiEnabled()) {
      expect(markup).toContain('data-testid="product-app-shell"');
      expect(markup).not.toContain('class="legacy-app"');
    } else {
      expect(markup).toContain('id="main-content"');
      expect(markup).toContain('id="history"');
      expect(markup).toContain('id="watchlist"');
      expect(markup).toContain('class="legacy-app"');
      expect(markup).not.toContain('data-testid="product-app-shell"');
    }
  });
});
