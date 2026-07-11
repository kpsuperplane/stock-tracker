import { readPortfolioFeatureFlags } from "../config/features";
import { RunRepository } from "../db/runs";
import { TickerRepository } from "../db/tickers";
import {
  BackfillPipelineAdapter,
  backfillPipelineFlagEnabled,
} from "../services/backfill-pipeline";
import { JobsService } from "../services/jobs";
import { LegacyDualWriteService } from "../services/legacy-dual-write";
import type { Env } from "./env";
import { logEvent } from "./log";

export const LEGACY_SCREENING_CRON = "0 22 * * MON-FRI";

export const handleScheduled = async (
  controller: ScheduledController,
  env: Env,
) => {
  // Task 1 only provisions the future planner/dispatcher triggers. They must
  // remain no-ops until Task 4 wires a normalized scheduler. The legacy
  // trigger remains unchanged until that cutover is explicitly implemented.
  if (controller.cron !== LEGACY_SCREENING_CRON) return;
  const now = new Date(controller.scheduledTime).toISOString();
  const portfolioFlags = readPortfolioFeatureFlags(env);
  const dualWrite = new LegacyDualWriteService(env.DB, {
    enabled: portfolioFlags.dualWrite,
  });
  const jobs = new JobsService(
    new RunRepository(env.DB, dualWrite),
    new TickerRepository(env.DB),
    env.SCREENING_QUEUE,
  );
  const runId = await jobs.startScheduled(now.slice(0, 10), now);
  const dispatched = await jobs.dispatch(now);
  let compatibilityRetried = 0;
  if (portfolioFlags.dualWrite) {
    try {
      compatibilityRetried = await dualWrite.retryPending(now);
    } catch (error) {
      logEvent("legacy_dual_write_retry_failed", {
        code: "legacy_dual_write_retry_failed",
        message: String(error).slice(0, 500),
      });
    }
  }
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
    compatibilityRetried,
  });
};
