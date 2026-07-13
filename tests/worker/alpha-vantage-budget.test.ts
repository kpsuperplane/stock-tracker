import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AlphaVantageRequestBudget } from "../../src/services/alpha-vantage-budget";

describe("AlphaVantageRequestBudget", () => {
  it("atomically caps daily requests and records their purpose", async () => {
    const budget = new AlphaVantageRequestBudget(
      env.DB,
      "2026-07-13",
      () => new Date("2026-07-13T22:00:00.000Z"),
      3,
    );
    await budget.reserve("earnings_calendar");
    await budget.reserve("earnings_history");
    await budget.reserve("dividend");
    await expect(budget.reserve("dividend")).rejects.toThrow(
      "provider_daily_limit",
    );
    expect(
      await env.DB.prepare(
        `SELECT requests_used, earnings_calendar_requests,
                earnings_history_requests, dividend_requests
           FROM alpha_vantage_daily_usage WHERE usage_date = '2026-07-13'`,
      ).first(),
    ).toEqual({
      requests_used: 3,
      earnings_calendar_requests: 1,
      earnings_history_requests: 1,
      dividend_requests: 1,
    });
  });
});
