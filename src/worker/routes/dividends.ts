import { Hono } from "hono";
import { runDividendRefresh } from "../dividends";
import type { Env } from "../env";
import { logEvent } from "../log";

export const dividendRoutes = new Hono<{ Bindings: Env }>();

dividendRoutes.post("/refresh", async (context) => {
  const now = new Date();
  const summary = await runDividendRefresh(context.env, now);
  logEvent("dividend_refresh_manual", {
    requestedAt: now.toISOString(),
    result: JSON.stringify(summary),
  });
  return context.json({ summary });
});
