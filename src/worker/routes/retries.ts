import { Hono } from "hono";
import { RunRepository } from "../../db/runs";
import type { Env } from "../env";

export const retryRoutes = new Hono<{ Bindings: Env }>();

retryRoutes.post("/:id/retry", async (context) => {
  const result = await new RunRepository(context.env.DB).retryAnalysis(
    context.req.param("id"),
    context.env.SCREENING_QUEUE,
    new Date().toISOString(),
  );
  if (result === "queued") return context.json({ queued: true as const }, 202);
  if (result === "daily_dispatch_limit") {
    return context.json(
      {
        error: {
          code: "daily_dispatch_limit",
          message:
            "The daily screening limit has been reached. Try again later.",
        },
      },
      429,
    );
  }
  return context.json(
    {
      error: {
        code: "screening_not_retryable",
        message: "This screening cannot be retried.",
      },
    },
    409,
  );
});
