import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

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
});
