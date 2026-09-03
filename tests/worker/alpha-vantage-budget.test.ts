import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
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

  it("reserves five fallback calls and leaves twenty calls for earnings", async () => {
    const budget = new AlphaVantageRequestBudget(
      env.DB,
      "2026-07-14",
      () => new Date("2026-07-14T22:00:00.000Z"),
    );
    for (let index = 0; index < 5; index += 1) {
      await budget.reserve("dividend");
    }
    await expect(budget.reserve("dividend")).rejects.toThrow(
      "provider_daily_limit",
    );
    for (let index = 0; index < 20; index += 1) {
      await budget.reserve("earnings_history");
    }
    await expect(budget.reserve("earnings_calendar")).rejects.toThrow(
      "provider_daily_limit",
    );
  });

  it("persists the daily dividend fallback circuit breaker", async () => {
    const budget = new AlphaVantageRequestBudget(
      env.DB,
      "2026-07-15",
      () => new Date("2026-07-15T22:00:00.000Z"),
    );
    await budget.disableDividendFallback("provider_entitlement");
    await expect(budget.reserve("dividend")).rejects.toThrow(
      "provider_daily_limit",
    );
    expect(
      await env.DB.prepare(
        `SELECT dividend_fallback_disabled AS disabled,
                dividend_fallback_error AS error
           FROM alpha_vantage_daily_usage WHERE usage_date = '2026-07-15'`,
      ).first(),
    ).toEqual({ disabled: 1, error: "provider_entitlement" });
  });

  it("paces provider fetches through the shared forward-and-history budget", async () => {
    let clock = 0;
    const waits: number[] = [];
    const budget = new AlphaVantageRequestBudget(
      env.DB,
      "2026-07-16",
      () => new Date("2026-07-16T22:00:00.000Z"),
      25,
      async (milliseconds) => {
        waits.push(milliseconds);
        clock += milliseconds;
      },
      () => clock,
      1_100,
    );
    const providerFetch = vi.fn(async () => new Response("ok"));
    await budget.fetcher(
      "earnings_calendar",
      providerFetch,
    )("https://example.com");
    await budget.fetcher(
      "earnings_history",
      providerFetch,
    )("https://example.com");
    await budget.fetcher(
      "earnings_history",
      providerFetch,
    )("https://example.com");

    expect(waits).toEqual([1_100, 1_100]);
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });
});
