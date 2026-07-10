import { Hono } from "hono";
import { RunRepository } from "../../db/runs";
import type { Env } from "../env";

export const retryRoutes = new Hono<{ Bindings: Env }>();

retryRoutes.post("/:id/retry", async (context) => {
  const queued = await new RunRepository(context.env.DB).retryAnalysis(
    context.req.param("id"),
    context.env.SCREENING_QUEUE,
    new Date().toISOString(),
  );
  return queued
    ? context.json({ queued: true as const }, 202)
    : context.json(
        {
          error: {
            code: "screening_not_retryable",
            message: "This screening cannot be retried.",
          },
        },
        409,
      );
});
