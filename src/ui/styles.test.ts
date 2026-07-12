import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
const calendarStyles = readFileSync(
  new URL("./calendar.css", import.meta.url),
  "utf8",
);

describe("legacy stylesheet boundary", () => {
  it("keeps legacy control and typography rules out of the Astryx shell", () => {
    expect(styles).toContain(".legacy-app button");
    expect(styles).toContain(".legacy-app a");
    expect(styles).toContain(".legacy-app input");
    expect(styles).toContain(".legacy-app h1");
    expect(styles).toContain("min-height: 100dvh");
    expect(styles).toContain("background: var(--background)");
    expect(styles).not.toMatch(/\nbutton,\ninput,\nselect\s*\{/);
    expect(styles).not.toMatch(/\n:focus-visible\s*\{/);
  });

  it("keeps custom product CSS scoped to the calendar and phone fallback", () => {
    expect(calendarStyles).toContain(".calendar-grid");
    expect(calendarStyles).toContain("prefers-reduced-motion");
    expect(styles).toContain(".backfill-date-layout");
    expect(styles).toContain('content: "∙ 必填"');
    expect(styles).toContain(".horizontal-scroll-hint");
    expect(styles).toContain(".calendar-mover-dialog__body");
    expect(styles).not.toContain(".product-page {");
    expect(styles).not.toContain(".product-shell {");
  });
});
