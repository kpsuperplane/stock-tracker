import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const calendarStyles = readFileSync(
  new URL("./calendar.css", import.meta.url),
  "utf8",
);

describe("product stylesheet", () => {
  it("contains no legacy UI selectors", () => {
    expect(styles).not.toContain(".legacy-app");
    expect(styles).not.toContain(".dashboard");
    expect(styles).not.toContain(".portfolio-table");
    expect(styles).toContain("min-height: 100dvh");
  });

  it("keeps custom product CSS scoped to the calendar and phone fallback", () => {
    expect(calendarStyles).toContain(".calendar-grid");
    expect(calendarStyles).toContain("prefers-reduced-motion");
    expect(styles).toContain(".backfill-date-layout");
    expect(styles).toContain('content: "∙ 必填"');
    expect(styles).toContain(".product-top-nav");
    expect(styles).toContain(
      "background-color: var(--color-background-surface)",
    );
    expect(styles).not.toContain(".horizontal-scroll-hint");
    expect(styles).toContain(".calendar-mover-dialog__body");
    expect(styles).not.toContain(".product-page {");
    expect(styles).not.toContain(".product-shell {");
  });

  it("does not force minimum widths on tables", () => {
    for (const className of [
      "product-portfolio-table",
      "product-events-table",
      "product-split-table",
    ]) {
      const rule = styles.match(
        new RegExp(`\\.${className}[^{}]*\\{([^}]*)\\}`),
      );
      expect(rule?.[1] ?? "").not.toContain("min-width");
    }
  });
});
