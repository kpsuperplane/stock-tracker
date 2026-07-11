import { Hono } from "hono";
import { z } from "zod";
import { RunRepository } from "../../db/runs";
import { TickerRepository } from "../../db/tickers";
import {
  BackfillPipelineAdapter,
  backfillPipelineFlagEnabled,
} from "../../services/backfill-pipeline";
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
  const tickerRepository = new TickerRepository(context.env.DB);
  const pipelineEnabled = backfillPipelineFlagEnabled(context.env);
  const pipeline = pipelineEnabled
    ? new BackfillPipelineAdapter({
        db: context.env.DB,
        listActiveSymbols: async () =>
          (await tickerRepository.listActive()).map((ticker) => ticker.symbol),
      })
    : undefined;
  const service = new JobsService(
    new RunRepository(context.env.DB),
    tickerRepository,
    context.env.SCREENING_QUEUE,
    pipeline,
  );
  const now = new Date().toISOString();
  const id = await service.createBackfill(body, now);
  if (!pipelineEnabled) await service.dispatch(now);
  return context.json({ id }, 202);
});

backfillRoutes.get("/:id", async (context) => {
  const id = context.req.param("id");
  const pipelineEnabled = backfillPipelineFlagEnabled(context.env);
  const tickerRepository = new TickerRepository(context.env.DB);
  const pipeline = pipelineEnabled
    ? new BackfillPipelineAdapter({
        db: context.env.DB,
        listActiveSymbols: async () =>
          (await tickerRepository.listActive()).map((ticker) => ticker.symbol),
      })
    : undefined;
  const job = pipeline
    ? ((await pipeline.getStatus(id)) ??
      (await new RunRepository(context.env.DB).getBackfill(id)))
    : await new RunRepository(context.env.DB).getBackfill(id);
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
