import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TickerRepository } from "../../src/db/tickers";
import { handleScheduled } from "../../src/worker/scheduled";

describe("scheduled handler", () => {
  it("snapshots and dispatches one idempotent weekday run", async () => {
    const now = "2026-07-09T22:00:00.000Z";
    await new TickerRepository(env.DB).insert({
      id: "scheduled-aapl",
      symbol: "AAPL",
      companyName: "Apple Inc.",
      exchange: "NMS",
      currency: "USD",
      now,
    });
    const controller = {
      scheduledTime: Date.parse(now),
      cron: "0 22 * * MON-FRI",
      noRetry() {},
    } as ScheduledController;
    await handleScheduled(controller, env);
    await handleScheduled(controller, env);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM report_runs WHERE origin = 'scheduled'",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT status, symbol, target_date FROM screenings LIMIT 1",
      ).first(),
    ).toEqual({ status: "queued", symbol: "AAPL", target_date: "2026-07-09" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM dispatch_events",
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("does not run the legacy scheduler for new planner or dispatcher triggers", async () => {
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM report_runs WHERE origin = 'scheduled'",
    ).first<{ count: number }>();
    const triggers = ["30 20 * * MON-FRI", "30 21 * * MON-FRI", "*/15 * * * *"];
    for (const cron of triggers) {
      await handleScheduled(
        {
          scheduledTime: Date.parse("2026-07-10T20:30:00.000Z"),
          cron,
          noRetry() {},
        } as ScheduledController,
        env,
      );
    }
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM report_runs WHERE origin = 'scheduled'",
    ).first<{ count: number }>();
    expect(after).toEqual(before);
  });
});
