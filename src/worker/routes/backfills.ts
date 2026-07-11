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
import { ApiError } from "../errors";

const createSchema = z
  .object({
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    reprocessExisting: z.boolean().default(false),
  })
  .strict();

const pipelineRetrySchema = z
  .object({
    workItemId: z.string().min(1).optional(),
    screeningId: z.string().min(1).optional(),
  })
  .strict()
  .refine((value) => value.workItemId || value.screeningId, {
    message: "workItemId is required",
  });

export const backfillRoutes = new Hono<{ Bindings: Env }>();

const parseLimit = (value: string | undefined): number => {
  if (value === undefined) return 25;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
    throw new ApiError(
      422,
      "limit",
      "The limit is outside the supported range.",
    );
  }
  return parsed;
};

type BackfillCursor = { id: string } | { id: string; createdAt: string };

const decodeCursor = (value: string | undefined): BackfillCursor | null => {
  if (!value) return null;
  try {
    const parsed = z
      .object({
        id: z.string().min(1).max(128),
        createdAt: z.string().min(1).max(64).optional(),
      })
      .strict()
      .parse(JSON.parse(atob(value)));
    return parsed.createdAt
      ? { id: parsed.id, createdAt: parsed.createdAt }
      : { id: parsed.id };
  } catch {
    throw new ApiError(422, "cursor", "The cursor is invalid.");
  }
};

const encodeCursor = (value: object): string => btoa(JSON.stringify(value));

backfillRoutes.get("/", async (context) => {
  const query = context.req.query();
  const cursor = decodeCursor(query.cursor);
  const result = await new RunRepository(context.env.DB).listBackfills({
    limit: parseLimit(query.limit),
    cursor: cursor
      ? "createdAt" in cursor
        ? { id: cursor.id, createdAt: cursor.createdAt }
        : cursor.id
      : null,
  });
  return context.json({
    jobs: result.jobs,
    nextCursor: result.nextCursor ? encodeCursor(result.nextCursor) : null,
  });
});

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
  const tickerRepository = new TickerRepository(context.env.DB);
  // Always probe normalized Backfill jobs first so an already-created
  // pipeline job remains readable if the feature flag is later turned off.
  // The adapter itself rejects scheduled/ledger jobs, preserving resource
  // boundaries for this status endpoint.
  const pipeline = new BackfillPipelineAdapter({
    db: context.env.DB,
    listActiveSymbols: async () =>
      (await tickerRepository.listActive()).map((ticker) => ticker.symbol),
  });
  const job =
    (await pipeline.getStatus(id)) ??
    (await new RunRepository(context.env.DB).getBackfill(id));
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

// Planner continuation is an explicit worker path. Browser status polling is
// deliberately read-only and never advances cursors.
backfillRoutes.post("/:id/continue", async (context) => {
  if (!backfillPipelineFlagEnabled(context.env)) {
    return context.json(
      {
        error: {
          code: "pipeline_disabled",
          message: "Pipeline continuation is not enabled.",
        },
      },
      409,
    );
  }
  const pipeline = new BackfillPipelineAdapter({
    db: context.env.DB,
    listActiveSymbols: async () =>
      (await new TickerRepository(context.env.DB).listActive()).map(
        (ticker) => ticker.symbol,
      ),
  });
  if (!(await pipeline.getStatus(context.req.param("id")))) {
    return context.json(
      {
        error: {
          code: "backfill_not_found",
          message: "Backfill not found.",
        },
      },
      404,
    );
  }
  const result = await pipeline.continuePlanning(
    context.req.param("id"),
    new Date().toISOString(),
  );
  return context.json(result, 202);
});

backfillRoutes.post("/:id/retry", async (context) => {
  if (!backfillPipelineFlagEnabled(context.env)) {
    return context.json(
      {
        error: {
          code: "pipeline_disabled",
          message: "Pipeline retries are not enabled.",
        },
      },
      409,
    );
  }
  const body = pipelineRetrySchema.parse(await context.req.json());
  const pipeline = new BackfillPipelineAdapter({
    db: context.env.DB,
    listActiveSymbols: async () =>
      (await new TickerRepository(context.env.DB).listActive()).map(
        (ticker) => ticker.symbol,
      ),
  });
  const result = await pipeline.retry({
    pipelineJobId: context.req.param("id"),
    workItemId: body.workItemId ?? body.screeningId ?? "",
    now: new Date().toISOString(),
  });
  if (result.kind === "queued") {
    return context.json(
      { queued: true as const, workItemId: result.workItemId },
      202,
    );
  }
  if (result.kind === "not_found") {
    return context.json(
      {
        error: {
          code: "backfill_not_found",
          message: "Backfill work item not found.",
        },
      },
      404,
    );
  }
  return context.json(
    {
      error: {
        code: "pipeline_work_not_retryable",
        message: "This pipeline work item cannot be retried.",
      },
    },
    409,
  );
});
