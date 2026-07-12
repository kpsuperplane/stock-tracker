import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { Providers } from "./Providers";

describe("ASTRYX application providers", () => {
  it("uses the neutral theme and exposes an accessible notification overlay root", () => {
    const markup = renderToStaticMarkup(
      <Providers>
        <div data-testid="provider-child">provider child</div>
      </Providers>,
    );

    expect(markup).toContain('data-astryx-theme="neutral"');
    expect(markup).toContain('role="region"');
    expect(markup).toContain('aria-label="Notifications"');
    expect(markup).toContain('data-testid="provider-child"');
  });

  it("keeps the product shell inside the provider boundary", () => {
    const markup = renderToStaticMarkup(
      <Providers>
        <App />
      </Providers>,
    );

    expect(markup).toContain('data-testid="product-app-shell"');
    expect(markup).not.toContain('class="legacy-app"');
  });
});
