import { Hono } from "hono";
import { runEarningsHistoryBackfill } from "../earnings-history";
import type { Env } from "../env";
import { logEvent } from "../log";

export const earningsRoutes = new Hono<{ Bindings: Env }>();

earningsRoutes.get("/history-backfill", (context) =>
  context.html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>Earnings history maintenance</title>
    <style>
      body { max-width: 42rem; margin: 4rem auto; padding: 0 1rem; font: 16px/1.5 system-ui; }
      button { padding: 0.6rem 0.9rem; font: inherit; cursor: pointer; }
      pre { min-height: 4rem; padding: 1rem; overflow: auto; background: CanvasText; color: Canvas; }
    </style>
  </head>
  <body>
    <main>
      <h1>Earnings history maintenance</h1>
      <p>Run one bounded batch of up to eight instruments. Deferred work resumes automatically on the next weekday refresh.</p>
      <button id="run" type="button">Run one batch</button>
      <pre id="result" aria-live="polite">Ready.</pre>
    </main>
    <script>
      const button = document.querySelector("#run");
      const result = document.querySelector("#result");
      button.addEventListener("click", async () => {
        button.disabled = true;
        result.textContent = "Running…";
        try {
          const response = await fetch("/api/earnings/history-backfill", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Stock-Tracker-Request": "1",
            },
            body: "{}",
          });
          const body = await response.json();
          result.textContent = JSON.stringify({ status: response.status, body }, null, 2);
        } catch (error) {
          result.textContent = String(error);
        } finally {
          button.disabled = false;
        }
      });
    </script>
  </body>
</html>`),
);

earningsRoutes.post("/history-backfill", async (context) => {
  const now = new Date();
  const summary = await runEarningsHistoryBackfill(context.env, now);
  logEvent("earnings_history_refresh_manual", {
    requestedAt: now.toISOString(),
    result: JSON.stringify(summary),
  });
  return context.json({ summary });
});
