import { readPortfolioFeatureFlags } from "../config/features";
import { RunRepository } from "../db/runs";
import { TickerRepository } from "../db/tickers";
import { AlphaVantageDividendEventProvider } from "../providers/alpha-vantage-dividends";
import { YahooDividendEventProvider } from "../providers/yahoo-dividends";
import {
  BackfillPipelineAdapter,
  backfillPipelineFlagEnabled,
} from "../services/backfill-pipeline";
import { ScheduledDividendRefreshService } from "../services/dividend-refresh";
import { JobsService } from "../services/jobs";
import { LegacyDualWriteService } from "../services/legacy-dual-write";
import { LegacyFactMigrator } from "../services/legacy-fact-migrator";
import { RetentionCleanupService } from "../services/retention-cleanup";
import {
  NORMALIZED_DISPATCH_CRON,
  NORMALIZED_PLANNER_CRONS,
  ScheduledReconciliationService,
} from "../services/scheduled-reconciliation";
import { WorkDispatcherService } from "../services/work-dispatcher";
import type { Env } from "./env";
import { safeErrorMessage } from "./errors";
import { logEvent } from "./log";

export const LEGACY_SCREENING_CRON = "0 22 * * MON-FRI";

const isNormalizedPlannerCron = (cron: string): boolean =>
  (NORMALIZED_PLANNER_CRONS as readonly string[]).includes(cron);

const dividendProviderFor = (env: Env) =>
  env.ALPHA_VANTAGE_API_KEY
    ? new AlphaVantageDividendEventProvider(env.ALPHA_VANTAGE_API_KEY)
    : new YahooDividendEventProvider();

const continueActiveBackfills = async (
  env: Env,
  now: string,
): Promise<void> => {
  if (!backfillPipelineFlagEnabled(env)) return;
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
    pendingBackfills.results.map(({ id }) => adapter.continuePlanning(id, now)),
  );
};

export const handleScheduled = async (
  controller: ScheduledController,
  env: Env,
) => {
  const portfolioFlags = readPortfolioFeatureFlags(env);
  const scheduledTime = new Date(controller.scheduledTime);
  if (isNormalizedPlannerCron(controller.cron)) {
    if (!portfolioFlags.newWrites) return;
    const result = await new ScheduledReconciliationService({
      db: env.DB,
      now: () => scheduledTime,
    }).plan(scheduledTime);
    logEvent("portfolio_planner_scheduled", {
      cron: controller.cron,
      scheduledTime: scheduledTime.toISOString(),
      result: JSON.stringify(result),
    });
    return;
  }
  if (controller.cron === NORMALIZED_DISPATCH_CRON) {
    const cleanup = await new RetentionCleanupService({
      db: env.DB,
      now: () => scheduledTime,
    }).run();
    if (!portfolioFlags.newWrites) {
      logEvent("portfolio_cleanup_scheduled", {
        scheduledTime: scheduledTime.toISOString(),
        cleanup: JSON.stringify(cleanup),
      });
      return;
    }
    const plannerContinuation = await new ScheduledReconciliationService({
      db: env.DB,
      now: () => scheduledTime,
    }).continueScheduledPlanning(scheduledTime);
    await continueActiveBackfills(env, scheduledTime.toISOString());
    const result = await new WorkDispatcherService({
      db: env.DB,
      queue: env.NORMALIZED_WORK_QUEUE,
      dlq: env.NORMALIZED_WORK_DLQ,
      now: () => scheduledTime,
    }).dispatch();
    logEvent("portfolio_dispatch_scheduled", {
      scheduledTime: scheduledTime.toISOString(),
      cleanup: JSON.stringify(cleanup),
      plannerContinuation: JSON.stringify(plannerContinuation),
      result: JSON.stringify(result),
    });
    return;
  }
  // Keep the legacy scheduler authoritative while the normalized write flag
  // is disabled (and available as the rollback path after enabling it).
  if (controller.cron !== LEGACY_SCREENING_CRON) return;
  const now = new Date(controller.scheduledTime).toISOString();
  let dividendRefresh: string | null = null;
  try {
    dividendRefresh = JSON.stringify(
      await new ScheduledDividendRefreshService({
        db: env.DB,
        provider: dividendProviderFor(env),
        now: () => new Date(now),
      }).refreshHeldInstruments(),
    );
    logEvent("dividend_refresh_scheduled", {
      scheduledTime: now,
      result: dividendRefresh,
    });
  } catch (error) {
    dividendRefresh = JSON.stringify({
      status: "failed",
      message: safeErrorMessage(error),
    });
    logEvent("dividend_refresh_failed", {
      scheduledTime: now,
      message: safeErrorMessage(error),
    });
  }
  let migrationResult: string | null = null;
  if (portfolioFlags.migrator) {
    try {
      const migration = await new LegacyFactMigrator(env.DB, {
        enabled: true,
        now: () => new Date(now),
      }).runPage({ now, pageSize: 100 });
      migrationResult = JSON.stringify(migration);
      logEvent("portfolio_migration_scheduled", {
        scheduledTime: now,
        result: migrationResult,
      });
    } catch (error) {
      migrationResult = JSON.stringify({
        status: "failed",
        message: safeErrorMessage(error),
      });
      logEvent("portfolio_migration_failed", {
        scheduledTime: now,
        message: safeErrorMessage(error),
      });
    }
  }
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
  let compatibilitySeeded = 0;
  let compatibilityRetried = 0;
  if (portfolioFlags.dualWrite) {
    try {
      compatibilitySeeded = await dualWrite.seedRecentPublishedRuns(now, 3);
      compatibilityRetried = await dualWrite.retryPending(now);
    } catch (error) {
      logEvent("legacy_dual_write_retry_failed", {
        code: "legacy_dual_write_retry_failed",
        message: String(error).slice(0, 500),
      });
    }
  }
  await continueActiveBackfills(env, now);
  logEvent("scheduled_dispatch", {
    runId,
    tradingDate: now.slice(0, 10),
    dispatched,
    compatibilitySeeded,
    compatibilityRetried,
    migration: migrationResult,
    dividends: dividendRefresh,
  });
};
