import { readPortfolioFeatureFlags } from "../config/features";
import { WorkersAiExplanationProvider } from "../providers/explanations";
import { YahooMarketDataProvider } from "../providers/yahoo";
import { PortfolioPipelineProcessor } from "../services/portfolio-pipeline-processor";
import {
  SyncIntentScheduler,
  type SyncPriorityClass,
} from "../services/sync-intents";
import { SyncSliceProcessor } from "../services/sync-slice-processor";
import type { SyncSliceMessage } from "../shared/contracts";
import type { Env } from "./env";
import { newsProviderFor } from "./provider-factories";

const enabledPriorityClasses = (env: Env): SyncPriorityClass[] => {
  const flags = readPortfolioFeatureFlags(env);
  return [
    ...(flags.syncCurrent ? (["current"] as const) : []),
    ...(flags.syncFuture ? (["future"] as const) : []),
    ...(flags.syncRecent ? (["recent"] as const) : []),
    ...(flags.syncHistory ? (["history"] as const) : []),
  ];
};

export const syncSchedulerFor = (
  env: Env,
  now: () => Date = () => new Date(),
) =>
  new SyncIntentScheduler({
    db: env.DB,
    foregroundQueue: env.SYNC_FOREGROUND_QUEUE,
    historyQueue: env.SYNC_HISTORY_QUEUE,
    enabledPriorityClasses: enabledPriorityClasses(env),
    now,
  });

export const consumeSyncSlice = async (
  env: Env,
  message: SyncSliceMessage,
  now: () => Date = () => new Date(),
): Promise<"processed" | "stale"> => {
  const flags = readPortfolioFeatureFlags(env);
  if (
    !flags.syncCurrent &&
    !flags.syncFuture &&
    !flags.syncRecent &&
    !flags.syncHistory
  ) {
    return "stale";
  }
  const result = await new SyncSliceProcessor({
    db: env.DB,
    now,
    processor: new PortfolioPipelineProcessor({
      db: env.DB,
      marketDataProvider: new YahooMarketDataProvider(),
      newsProvider: newsProviderFor(env),
      explanationProvider: new WorkersAiExplanationProvider(env.AI),
      now,
    }),
  }).process(message);
  if (result === "processed") await syncSchedulerFor(env, now).dispatch(1);
  return result;
};
