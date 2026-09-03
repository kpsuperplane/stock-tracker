import { readPortfolioFeatureFlags } from "../config/features";
import { RunRepository } from "../db/runs";
import { TickerRepository } from "../db/tickers";
import { isMarketTradingDayForExchange } from "../domain/market-calendar";
import { AlphaVantageEarningsProvider } from "../providers/alpha-vantage-earnings";
import { YahooCorporateActionProvider } from "../providers/yahoo-corporate-actions";
import { AlphaVantageRequestBudget } from "../services/alpha-vantage-budget";
import { ScheduledEarningsRefreshService } from "../services/earnings-refresh";
import { reconcileEventCoverage } from "../services/event-coverage";
import { EventImportRecoveryService } from "../services/event-import-recovery";
import { JobsService } from "../services/jobs";
import { LegacyDualWriteService } from "../services/legacy-dual-write";
import { LegacyFactMigrator } from "../services/legacy-fact-migrator";
import { ReadModelRefreshOutbox } from "../services/read-model-refresh";
import {
  RESOURCE_ENVELOPES,
  ResourceGovernor,
} from "../services/resource-governor";
import { RetentionCleanupService } from "../services/retention-cleanup";
import {
  listHeldInstruments,
  NORMALIZED_DISPATCH_CRON,
  NORMALIZED_PLANNER_CRONS,
  type ScheduledPlannerResult,
  ScheduledReconciliationService,
} from "../services/scheduled-reconciliation";
import { ScheduledSplitRefreshService } from "../services/split-refresh";
import { WorkDispatcherService } from "../services/work-dispatcher";
import type { ReadModelRefreshMessage } from "../shared/contracts";
import {
  easternCloseUtc,
  easternMarketDate,
  previousCalendarDate,
} from "../shared/dates";
import { dispatchDividendRefreshes } from "./dividends";
import { runEarningsHistoryBackfill } from "./earnings-history";
import type { Env } from "./env";
import { safeErrorMessage } from "./errors";
import { logEvent } from "./log";
import { syncSchedulerFor } from "./sync";

export const LEGACY_SCREENING_CRON = "0 22 * * MON-FRI";

const latestCompletedDate = (now: Date, exchange: string): string => {
  const timestamp = now.toISOString();
  const today = easternMarketDate(timestamp);
  let candidate =
    timestamp >= easternCloseUtc(today) ? today : previousCalendarDate(today);
  while (!isMarketTradingDayForExchange(candidate, exchange)) {
    candidate = previousCalendarDate(candidate);
  }
  return candidate;
};

const isNormalizedPlannerCron = (cron: string): boolean =>
  (NORMALIZED_PLANNER_CRONS as readonly string[]).includes(cron);

const refreshEarningsHistory = async (env: Env, now: Date): Promise<string> => {
  try {
    const result = JSON.stringify(await runEarningsHistoryBackfill(env, now));
    logEvent("earnings_history_refresh_scheduled", {
      scheduledTime: now.toISOString(),
      result,
    });
    return result;
  } catch (error) {
    const result = JSON.stringify({
      status: "failed",
      message: safeErrorMessage(error),
    });
    logEvent("earnings_history_refresh_failed", {
      scheduledTime: now.toISOString(),
      message: safeErrorMessage(error),
    });
    return result;
  }
};

const continueActiveBackfills = async (
  env: Env,
  _now: string,
): Promise<void> => {
  if (!readPortfolioFeatureFlags(env).newWrites) return;
  const pendingBackfills = await env.DB.prepare(
    `SELECT job.id FROM pipeline_jobs job
        JOIN work_items planner
          ON planner.pipeline_job_id = job.id
         AND planner.scope = 'job_planning'
       WHERE job.sync_lane = 'history'
         AND job.status IN ('pending', 'planning', 'running')
         AND planner.state = 'pending'
         AND (
           job.planning_phase = 'market'
           OR (job.planning_phase = 'analysis'
             AND job.market_work_pending = 0)
           OR (job.planning_phase = 'dividends'
             AND job.analysis_work_pending = 0)
         )
        ORDER BY job.priority DESC, job.created_at
        LIMIT 10`,
  ).all<{ id: string }>();
  if (pendingBackfills.results.length === 0) return;
  await env.NORMALIZED_WORK_QUEUE.sendBatch(
    pendingBackfills.results.map(({ id }) => ({
      body: { planningPipelineJobId: id },
      contentType: "json" as const,
    })),
  );
};

export const shouldRunRetentionCleanup = (scheduledTime: Date): boolean =>
  scheduledTime.getUTCHours() === 8 && scheduledTime.getUTCMinutes() === 0;

const emptyCleanup = {
  expiredImportBatches: 0,
  deletedImportRows: 0,
  deletedJobLinks: 0,
  deletedDispatchLinks: 0,
  deletedWorkItems: 0,
  deletedDispatchBatches: 0,
  deletedPipelineJobs: 0,
  deletedRepairMarkers: 0,
};

const enqueueActiveForegroundContinuation = async (
  env: Env,
  recovery: ScheduledPlannerResult,
): Promise<boolean> => {
  if (recovery.kind === "skipped") return false;
  const row = await env.DB.prepare(
    `SELECT 1 AS active FROM pipeline_jobs
      WHERE id = ?1 AND sync_lane = 'current'
        AND status IN ('pending', 'planning', 'running')`,
  )
    .bind(recovery.pipelineJobId)
    .first<{ active: number }>();
  if (row?.active !== 1) return false;
  await env.NORMALIZED_WORK_QUEUE.send({
    planningPipelineJobId: recovery.pipelineJobId,
  });
  return true;
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
    const compactSyncEnabled =
      portfolioFlags.syncCurrent ||
      portfolioFlags.syncFuture ||
      portfolioFlags.syncRecent ||
      portfolioFlags.syncHistory;
    const cleanup = shouldRunRetentionCleanup(scheduledTime)
      ? await new RetentionCleanupService({
          db: env.DB,
          now: () => scheduledTime,
        }).run()
      : emptyCleanup;
    if (!compactSyncEnabled && !portfolioFlags.legacySync) {
      const readModelRefreshes = portfolioFlags.readModelPublish
        ? await new ReadModelRefreshOutbox(
            env.DB,
            env.SYNC_FOREGROUND_QUEUE as Queue<ReadModelRefreshMessage>,
            () => scheduledTime,
          ).recover()
        : 0;
      logEvent("background_sync_paused", {
        scheduledTime: scheduledTime.toISOString(),
        cleanup: JSON.stringify(cleanup),
        readModelRefreshes,
      });
      return;
    }
    const importRecovery = await new EventImportRecoveryService({
      db: env.DB,
      queue: compactSyncEnabled
        ? env.SYNC_FOREGROUND_QUEUE
        : env.NORMALIZED_WORK_QUEUE,
      now: () => scheduledTime,
    }).recover();
    if (compactSyncEnabled) {
      const scheduler = syncSchedulerFor(env, () => scheduledTime);
      const recovered = await scheduler.recoverExpired();
      const readModelRefreshes = portfolioFlags.readModelPublish
        ? await new ReadModelRefreshOutbox(
            env.DB,
            env.SYNC_FOREGROUND_QUEUE as Queue<ReadModelRefreshMessage>,
            () => scheduledTime,
          ).recover()
        : 0;
      const jobs = await env.DB.prepare(
        `SELECT job.id
           FROM pipeline_jobs job
          WHERE job.superseded_at IS NULL
            AND job.status IN ('pending', 'planning', 'running')
            AND NOT EXISTS (
              SELECT 1 FROM sync_intents intent
               WHERE intent.pipeline_job_id = job.id
            )
          ORDER BY CASE job.sync_lane WHEN 'current' THEN 0 ELSE 1 END,
                   job.priority DESC, job.created_at, job.id
          LIMIT 20`,
      ).all<{ id: string }>();
      let createdIntents = 0;
      for (const job of jobs.results) {
        createdIntents += await scheduler.createForPipelineJob(job.id);
      }
      const dispatch = await scheduler.dispatch(16);
      logEvent("compact_sync_recovery_scheduled", {
        scheduledTime: scheduledTime.toISOString(),
        cleanup: JSON.stringify(cleanup),
        importRecovery: JSON.stringify(importRecovery),
        recovered,
        readModelRefreshes,
        createdIntents,
        dispatch: JSON.stringify(dispatch),
      });
      return;
    }
    const eventCoverage = await reconcileEventCoverage(
      env.DB,
      scheduledTime.toISOString(),
    );
    const dividendDispatch = await dispatchDividendRefreshes(
      env,
      scheduledTime,
    );
    if (!portfolioFlags.newWrites) {
      logEvent("portfolio_cleanup_scheduled", {
        scheduledTime: scheduledTime.toISOString(),
        cleanup: JSON.stringify(cleanup),
        importRecovery: JSON.stringify(importRecovery),
        eventCoverage: JSON.stringify(eventCoverage),
        dividendDispatch: JSON.stringify(dividendDispatch),
      });
      return;
    }
    const foregroundRecovery = await new ScheduledReconciliationService({
      db: env.DB,
      now: () => scheduledTime,
    }).recoverLatestCompletedTradingDate(scheduledTime);
    const result = await new WorkDispatcherService({
      db: env.DB,
      queue: env.NORMALIZED_WORK_QUEUE,
      dlq: env.NORMALIZED_WORK_DLQ,
      now: () => scheduledTime,
    }).dispatch();
    const foregroundContinuation = await enqueueActiveForegroundContinuation(
      env,
      foregroundRecovery,
    );
    // Dispatch durable work first so a large reconciliation page cannot starve
    // market facts and analyses that are already ready for the queue.
    const plannerContinuation = await new ScheduledReconciliationService({
      db: env.DB,
      now: () => scheduledTime,
    }).continueAutomaticPlanning(scheduledTime);
    const earningsHistoryRefresh = await refreshEarningsHistory(
      env,
      scheduledTime,
    );
    await continueActiveBackfills(env, scheduledTime.toISOString());
    logEvent("portfolio_dispatch_scheduled", {
      scheduledTime: scheduledTime.toISOString(),
      cleanup: JSON.stringify(cleanup),
      importRecovery: JSON.stringify(importRecovery),
      eventCoverage: JSON.stringify(eventCoverage),
      dividendDispatch: JSON.stringify(dividendDispatch),
      foregroundRecovery: JSON.stringify(foregroundRecovery),
      foregroundContinuation,
      earningsHistory: earningsHistoryRefresh,
      plannerContinuation: JSON.stringify(plannerContinuation),
      result: JSON.stringify(result),
    });
    return;
  }
  // Keep the legacy scheduler authoritative while the normalized write flag
  // is disabled (and available as the rollback path after enabling it).
  if (controller.cron !== LEGACY_SCREENING_CRON) return;
  const compactSyncEnabled =
    portfolioFlags.syncCurrent ||
    portfolioFlags.syncFuture ||
    portfolioFlags.syncRecent ||
    portfolioFlags.syncHistory;
  if (!portfolioFlags.legacySync && !compactSyncEnabled) return;
  const now = new Date(controller.scheduledTime).toISOString();
  let splitRefresh: string | null = null;
  try {
    splitRefresh = JSON.stringify(
      await new ScheduledSplitRefreshService({
        db: env.DB,
        provider: new YahooCorporateActionProvider(),
        now: () => new Date(now),
      }).refreshPending(),
    );
    logEvent("split_refresh_scheduled", {
      scheduledTime: now,
      result: splitRefresh,
    });
  } catch (error) {
    splitRefresh = JSON.stringify({
      status: "failed",
      message: safeErrorMessage(error),
    });
    logEvent("split_refresh_failed", {
      scheduledTime: now,
      message: safeErrorMessage(error),
    });
  }
  const alphaBudget = new AlphaVantageRequestBudget(
    env.DB,
    easternMarketDate(now),
    () => new Date(now),
  );
  let earningsRefresh: string | null = null;
  const shouldRefreshEarnings =
    portfolioFlags.legacySync || portfolioFlags.syncFuture;
  const earningsReservation = shouldRefreshEarnings
    ? await new ResourceGovernor(env.DB, () => new Date(now)).reserve(
        `earnings-calendar:${easternMarketDate(now)}`,
        RESOURCE_ENVELOPES.foregroundEarnings,
      )
    : null;
  try {
    if (!shouldRefreshEarnings) {
      earningsRefresh = JSON.stringify({ status: "future_lane_disabled" });
    } else if (!earningsReservation) {
      earningsRefresh = JSON.stringify({
        status: "waiting",
        reason: "daily_budget",
      });
    } else {
      await new ResourceGovernor(env.DB, () => new Date(now)).consume(
        earningsReservation.id,
      );
      const result = await new ScheduledEarningsRefreshService({
        db: env.DB,
        ...(env.ALPHA_VANTAGE_API_KEY
          ? {
              provider: new AlphaVantageEarningsProvider(
                env.ALPHA_VANTAGE_API_KEY,
                alphaBudget.fetcher("earnings_calendar"),
              ),
            }
          : {}),
        now: () => new Date(now),
      }).refreshHeldInstruments();
      earningsRefresh = JSON.stringify(result);
    }
    logEvent("earnings_refresh_scheduled", {
      scheduledTime: now,
      result: earningsRefresh,
    });
  } catch (error) {
    earningsRefresh = JSON.stringify({
      status: "failed",
      message: safeErrorMessage(error),
    });
    logEvent("earnings_refresh_failed", {
      scheduledTime: now,
      message: safeErrorMessage(error),
    });
  }
  let earningsHistoryRefresh: string | null = null;
  if (compactSyncEnabled) {
    earningsHistoryRefresh = portfolioFlags.syncHistory
      ? await refreshEarningsHistory(env, new Date(now))
      : JSON.stringify({ status: "history_lane_disabled" });
  } else if (portfolioFlags.newWrites) {
    earningsHistoryRefresh = JSON.stringify({
      status: "scheduled_by_normalized_dispatcher",
    });
  } else {
    try {
      earningsHistoryRefresh = JSON.stringify(
        await runEarningsHistoryBackfill(env, new Date(now), alphaBudget),
      );
      logEvent("earnings_history_refresh_scheduled", {
        scheduledTime: now,
        result: earningsHistoryRefresh,
      });
    } catch (error) {
      earningsHistoryRefresh = JSON.stringify({
        status: "failed",
        message: safeErrorMessage(error),
      });
      logEvent("earnings_history_refresh_failed", {
        scheduledTime: now,
        message: safeErrorMessage(error),
      });
    }
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
  let compactProduction: string | null = null;
  if (compactSyncEnabled) {
    const eventCoverage = await reconcileEventCoverage(env.DB, now);
    const dividendDispatch =
      portfolioFlags.syncCurrent || portfolioFlags.syncFuture
        ? await dispatchDividendRefreshes(
            env,
            new Date(now),
            env.SYNC_FOREGROUND_QUEUE as Queue<
              import("../shared/contracts").DividendRefreshMessage
            >,
            12,
          )
        : { due: 0, queued: 0, sendFailures: 0, recovered: 0 };
    const scheduler = syncSchedulerFor(env, () => new Date(now));
    const held = portfolioFlags.syncCurrent
      ? await listHeldInstruments(env.DB, easternMarketDate(now))
      : [];
    const foregroundIntents = await scheduler.ensureForegroundCoverage(
      held.map((instrument) => ({
        id: instrument.id,
        latestCompletedDate: latestCompletedDate(
          new Date(now),
          instrument.exchange,
        ),
      })),
      portfolioFlags.syncRecent,
    );
    const dispatch = await scheduler.dispatch(16);
    compactProduction = JSON.stringify({
      eventCoverage,
      dividendDispatch,
      foregroundIntents,
      dispatch,
    });
  }
  if (!portfolioFlags.legacySync) {
    logEvent("future_refresh_scheduled", {
      scheduledTime: now,
      splits: splitRefresh,
      earnings: earningsRefresh,
      earningsHistory: earningsHistoryRefresh,
      compactProduction,
    });
    return;
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
    splits: splitRefresh,
    earnings: earningsRefresh,
    earningsHistory: earningsHistoryRefresh,
  });
};
