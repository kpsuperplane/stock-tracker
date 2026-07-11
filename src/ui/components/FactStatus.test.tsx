import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import { FactStatus, freshnessBadgeVariant } from "./FactStatus";

describe("FactStatus", () => {
  it("maps freshness to semantic badges and keeps conflicts visible", () => {
    expect(freshnessBadgeVariant("fresh")).toBe("success");
    expect(freshnessBadgeVariant("stale")).toBe("warning");
    expect(freshnessBadgeVariant("error")).toBe("error");
    expect(freshnessBadgeVariant("unavailable")).toBe("neutral");

    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <FactStatus
          freshness="pending"
          conflicts={[{ code: "pending", message: "Waiting for refresh." }]}
        />
      </I18nProvider>,
    );
    expect(markup).toContain("Pending");
    expect(markup).toContain("Waiting for refresh.");
  });
});
