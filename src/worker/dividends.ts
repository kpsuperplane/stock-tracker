import { AlphaVantageDividendEventProvider } from "../providers/alpha-vantage-dividends";
import { PrimaryFallbackDividendProvider } from "../providers/fallback-dividends";
import { YahooDividendEventProvider } from "../providers/yahoo-dividends";
import { AlphaVantageRequestBudget } from "../services/alpha-vantage-budget";
import {
  DividendRefreshConsumer,
  DividendRefreshDispatcher,
} from "../services/dividend-queue";
import {
  type DividendRefreshSummary,
  ScheduledDividendRefreshService,
} from "../services/dividend-refresh";
import type { DividendRefreshMessage } from "../shared/contracts";
import { easternMarketDate } from "../shared/dates";
import type { Env } from "./env";

export const dividendProviderFor = (env: Env, now: Date) => {
  const budget = new AlphaVantageRequestBudget(
    env.DB,
    easternMarketDate(now.toISOString()),
    () => now,
  );
  return new PrimaryFallbackDividendProvider(
    new YahooDividendEventProvider(fetch, () => now),
    env.ALPHA_VANTAGE_API_KEY
      ? new AlphaVantageDividendEventProvider(
          env.ALPHA_VANTAGE_API_KEY,
          budget.fetcher("dividend"),
          () => now,
        )
      : null,
    (code) => budget.disableDividendFallback(code),
  );
};

/** Compatibility entrypoint for direct/manual refresh callers. */
export const runDividendRefresh = (
  env: Env,
  now: Date,
): Promise<DividendRefreshSummary> =>
  new ScheduledDividendRefreshService({
    db: env.DB,
    provider: dividendProviderFor(env, now),
    now: () => now,
  }).refreshHeldInstruments();

export const dispatchDividendRefreshes = (
  env: Env,
  now: Date,
  queue: Queue<DividendRefreshMessage> = env.NORMALIZED_WORK_QUEUE as Queue<DividendRefreshMessage>,
  limit = 100,
) =>
  new DividendRefreshDispatcher({
    db: env.DB,
    queue,
    now: () => now,
    limit,
  }).dispatch();

export const consumeDividendRefresh = (
  env: Env,
  now: Date,
  message: DividendRefreshMessage,
) =>
  new DividendRefreshConsumer({
    db: env.DB,
    provider: dividendProviderFor(env, now),
    now: () => now,
  }).process(message);
