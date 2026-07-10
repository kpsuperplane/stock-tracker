import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("deployment safety", () => {
  it("keeps Worker integration tests off the production Wrangler config", () => {
    const config = readFileSync("vitest.worker.config.ts", "utf8");

    expect(config).not.toContain('configPath: "./wrangler.jsonc"');
    expect(config).toContain('configPath: "./wrangler.test.jsonc"');
  });
});
