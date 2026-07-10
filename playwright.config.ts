import { existsSync, readFileSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";

const localVars = existsSync(".dev.vars")
  ? readFileSync(".dev.vars", "utf8")
  : readFileSync(".dev.vars.example", "utf8");
const value = (name: string, fallback: string) =>
  localVars.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim() ?? fallback;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    httpCredentials: {
      username: value("BASIC_AUTH_USERNAME", "local-owner"),
      password: value("BASIC_AUTH_PASSWORD", "local-password"),
    },
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "phone",
      use: {
        ...devices["iPhone 13"],
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
  webServer: {
    command:
      "test -f .dev.vars || cp .dev.vars.example .dev.vars; npm run dev -- --host 127.0.0.1",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: !process.env.CI,
  },
});
