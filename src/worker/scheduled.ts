import { RunRepository } from "../db/runs";
import { TickerRepository } from "../db/tickers";
import {
  BackfillPipelineAdapter,
  backfillPipelineFlagEnabled,
} from "../services/backfill-pipeline";
import { JobsService } from "../services/jobs";
import type { Env } from "./env";
import { logEvent } from "./log";

export const handleScheduled = async (
  controller: ScheduledController,
  env: Env,
) => {
  const now = new Date(controller.scheduledTime).toISOString();
  const jobs = new JobsService(
    new RunRepository(env.DB),
    new TickerRepository(env.DB),
    env.SCREENING_QUEUE,
  );
  const runId = await jobs.startScheduled(now.slice(0, 10), now);
  const dispatched = await jobs.dispatch(now);
  if (backfillPipelineFlagEnabled(env)) {
    const pendingBackfills = await env.DB.prepare(
      `SELECT id FROM pipeline_jobs
          WHERE trigger_type = 'backfill'
            AND status IN ('pending', 'planning', 'running')
          ORDER BY priority DESC, created_at
          LIMIT 10`,
    ).all<{ id: string }>();
    const adapter = new BackfillPipelineAdapter({
      db: env.DB,
      listActiveSymbols: async () =>
        (await new TickerRepository(env.DB).listActive()).map(
          (ticker) => ticker.symbol,
        ),
    });
    await Promise.all(
      pendingBackfills.results.map(({ id }) =>
        adapter.continuePlanning(id, now),
      ),
    );
  }
  logEvent("scheduled_dispatch", {
    runId,
    tradingDate: now.slice(0, 10),
    dispatched,
  });
};
