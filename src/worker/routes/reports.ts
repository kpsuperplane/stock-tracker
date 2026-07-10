import { Hono } from "hono";
import { RunRepository } from "../../db/runs";
import type { Env } from "../env";

export const reportRoutes = new Hono<{ Bindings: Env }>();

reportRoutes.get("/latest", async (context) => {
  const repository = new RunRepository(context.env.DB);
  return context.json({
    report: await repository.latestPublishedReport(),
    currentRun: await repository.currentRun(),
  });
});

reportRoutes.get("/", async (context) => {
  const before = context.req.query("cursor") ?? null;
  const reports = await new RunRepository(context.env.DB).reportHistory(before);
  return context.json({
    reports,
    nextCursor:
      reports.length === 30 ? (reports.at(-1)?.tradingDate ?? null) : null,
  });
});

reportRoutes.get("/:date", async (context) => {
  const report = await new RunRepository(context.env.DB).reportByDate(
    context.req.param("date"),
  );
  return report
    ? context.json({ report })
    : context.json(
        {
          error: { code: "report_not_found", message: "Report not found." },
        },
        404,
      );
});
