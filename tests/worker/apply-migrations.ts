import { applyD1Migrations, type D1Migration } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      BASIC_AUTH_USERNAME: string;
      BASIC_AUTH_PASSWORD: string;
    }
  }
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM dispatch_events"),
    env.DB.prepare("DELETE FROM sources"),
    env.DB.prepare("DELETE FROM analyses"),
    env.DB.prepare("DELETE FROM screenings"),
    env.DB.prepare("DELETE FROM report_runs"),
    env.DB.prepare("DELETE FROM backfill_jobs"),
    env.DB.prepare("DELETE FROM tickers"),
  ]);
});
