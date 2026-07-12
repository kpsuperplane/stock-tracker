import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { App } from "./App";

describe("App", () => {
  it("always renders the product shell", () => {
    const markup = renderToStaticMarkup(<App />);
    expect(markup).toContain('data-testid="product-app-shell"');
    expect(markup).not.toContain('class="legacy-app"');
  });
});
