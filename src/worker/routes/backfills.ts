import { Hono } from "hono";
import { z } from "zod";
import { RunRepository } from "../../db/runs";
import { TickerRepository } from "../../db/tickers";
import { JobsService } from "../../services/jobs";
import type { Env } from "../env";

const createSchema = z
  .object({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    reprocessExisting: z.boolean().default(false),
  })
  .strict();

export const backfillRoutes = new Hono<{ Bindings: Env }>();

backfillRoutes.post("/", async (context) => {
  const body = createSchema.parse(await context.req.json());
  const service = new JobsService(
    new RunRepository(context.env.DB),
    new TickerRepository(context.env.DB),
    context.env.SCREENING_QUEUE,
  );
  const now = new Date().toISOString();
  const id = await service.createBackfill(body, now);
  await service.dispatch(now);
  return context.json({ id }, 202);
});

backfillRoutes.get("/:id", async (context) => {
  const job = await new RunRepository(context.env.DB).getBackfill(
    context.req.param("id"),
  );
  return job
    ? context.json({ job })
    : context.json(
        {
          error: {
            code: "backfill_not_found",
            message: "Backfill not found.",
          },
        },
        404,
      );
});
