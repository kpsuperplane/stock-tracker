import type { PortfolioFeatureFlags } from "../config/features";
import { AlphaVantageEarningsProvider } from "../providers/alpha-vantage-earnings";
import { YahooCorporateActionProvider } from "../providers/yahoo-corporate-actions";
import { AlphaVantageRequestBudget } from "../services/alpha-vantage-budget";
import { ScheduledEarningsRefreshService } from "../services/earnings-refresh";
import { reconcileEventCoverage } from "../services/event-coverage";
import {
  RESOURCE_ENVELOPES,
  ResourceGovernor,
  utcUsageDate,
} from "../services/resource-governor";
import { listHeldInstruments } from "../services/scheduled-reconciliation";
import { ScheduledSplitRefreshService } from "../services/split-refresh";
import type { DividendRefreshMessage } from "../shared/contracts";
import { easternMarketDate } from "../shared/dates";
import { dispatchDividendRefreshes } from "./dividends";
import { runEarningsHistoryBackfill } from "./earnings-history";
import type { Env } from "./env";
import { safeErrorMessage } from "./errors";
import { logEvent } from "./log";
import { syncSchedulerFor } from "./sync";

interface CompactProducerDependencies {
  latestCompletedDate: (now: Date, exchange: string) => string;
}

const runOncePerDay = async <T>(
  env: Env,
  now: Date,
  deterministicKey: string,
  envelope: (typeof RESOURCE_ENVELOPES)[keyof typeof RESOURCE_ENVELOPES],
  operation: () => Promise<T>,
): Promise<
  | T
  | { status: "waiting"; reason: "daily_budget" }
  | { status: "already_attempted" }
> => {
  const governor = new ResourceGovernor(env.DB, () => now);
  const reservation = await governor.reserve(deterministicKey, envelope);
  if (!reservation) return { status: "waiting", reason: "daily_budget" };
  if (!(await governor.consume(reservation.id))) {
    return { status: "already_attempted" };
  }
  return operation();
};

export const runCompactScheduledProducers = async (
  env: Env,
  now: Date,
  flags: PortfolioFeatureFlags,
  dependencies: CompactProducerDependencies,
) => {
  const timestamp = now.toISOString();
  const scheduler = syncSchedulerFor(env, () => now);
  const held = flags.syncCurrent
    ? await listHeldInstruments(env.DB, easternMarketDate(timestamp))
    : [];
  const foregroundIntents = await scheduler.ensureForegroundCoverage(
    held.map((instrument) => ({
      id: instrument.id,
      latestCompletedDate: dependencies.latestCompletedDate(
        now,
        instrument.exchange,
      ),
    })),
    flags.syncRecent,
  );
  const dispatch = await scheduler.dispatch(16);

  const eventCoverage = await runOncePerDay(
    env,
    now,
    `event-coverage:${utcUsageDate(now)}`,
    RESOURCE_ENVELOPES.foregroundCoverageMaintenance,
    () => reconcileEventCoverage(env.DB, timestamp),
  );
  const dividendDispatch =
    flags.syncCurrent || flags.syncFuture
      ? await dispatchDividendRefreshes(
          env,
          now,
          env.SYNC_FOREGROUND_QUEUE as Queue<DividendRefreshMessage>,
          12,
        )
      : { due: 0, queued: 0, sendFailures: 0, recovered: 0 };

  let splitRefresh: unknown = { status: "current_lane_disabled" };
  if (flags.syncCurrent) {
    try {
      splitRefresh = await runOncePerDay(
        env,
        now,
        `split-refresh:${utcUsageDate(now)}`,
        RESOURCE_ENVELOPES.foregroundSplitRefresh,
        () =>
          new ScheduledSplitRefreshService({
            db: env.DB,
            provider: new YahooCorporateActionProvider(),
            now: () => now,
          }).refreshPending(),
      );
    } catch (error) {
      splitRefresh = { status: "failed", message: safeErrorMessage(error) };
    }
  }

  let earningsRefresh: unknown = { status: "future_lane_disabled" };
  if (flags.syncFuture) {
    try {
      const alphaBudget = new AlphaVantageRequestBudget(
        env.DB,
        easternMarketDate(timestamp),
        () => now,
      );
      earningsRefresh = await runOncePerDay(
        env,
        now,
        `earnings-calendar:${easternMarketDate(timestamp)}`,
        RESOURCE_ENVELOPES.foregroundEarnings,
        () =>
          new ScheduledEarningsRefreshService({
            db: env.DB,
            ...(env.ALPHA_VANTAGE_API_KEY
              ? {
                  provider: new AlphaVantageEarningsProvider(
                    env.ALPHA_VANTAGE_API_KEY,
                    alphaBudget.fetcher("earnings_calendar"),
                  ),
                }
              : {}),
            now: () => now,
          }).refreshHeldInstruments(),
      );
    } catch (error) {
      earningsRefresh = {
        status: "failed",
        message: safeErrorMessage(error),
      };
    }
  }

  let earningsHistory: unknown = { status: "history_lane_disabled" };
  if (flags.syncHistory) {
    try {
      earningsHistory = await runOncePerDay(
        env,
        now,
        `earnings-history:${utcUsageDate(now)}`,
        RESOURCE_ENVELOPES.historyEarnings,
        () => runEarningsHistoryBackfill(env, now),
      );
    } catch (error) {
      earningsHistory = {
        status: "failed",
        message: safeErrorMessage(error),
      };
    }
  }

  const result = {
    foregroundIntents,
    dispatch,
    eventCoverage,
    dividendDispatch,
    splitRefresh,
    earningsRefresh,
    earningsHistory,
  };
  logEvent("compact_sync_producers_scheduled", {
    scheduledTime: timestamp,
    result: JSON.stringify(result),
  });
  return result;
};
