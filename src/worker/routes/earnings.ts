import { Hono } from "hono";
import { runEarningsHistoryBackfill } from "../earnings-history";
import type { Env } from "../env";
import { logEvent } from "../log";

export const earningsRoutes = new Hono<{ Bindings: Env }>();

earningsRoutes.post("/history-backfill", async (context) => {
  const now = new Date();
  const summary = await runEarningsHistoryBackfill(context.env, now);
  logEvent("earnings_history_refresh_manual", {
    requestedAt: now.toISOString(),
    result: JSON.stringify(summary),
  });
  return context.json({ summary });
});
