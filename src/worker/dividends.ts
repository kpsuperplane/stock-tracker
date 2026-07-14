import { AlphaVantageDividendEventProvider } from "../providers/alpha-vantage-dividends";
import { YahooDividendEventProvider } from "../providers/yahoo-dividends";
import { AlphaVantageRequestBudget } from "../services/alpha-vantage-budget";
import {
  type DividendRefreshSummary,
  ScheduledDividendRefreshService,
} from "../services/dividend-refresh";
import { easternMarketDate } from "../shared/dates";
import type { Env } from "./env";

export const runDividendRefresh = (
  env: Env,
  now: Date,
  budget = new AlphaVantageRequestBudget(
    env.DB,
    easternMarketDate(now.toISOString()),
    () => now,
  ),
): Promise<DividendRefreshSummary> =>
  new ScheduledDividendRefreshService({
    db: env.DB,
    provider: env.ALPHA_VANTAGE_API_KEY
      ? new AlphaVantageDividendEventProvider(
          env.ALPHA_VANTAGE_API_KEY,
          budget.fetcher("dividend"),
        )
      : new YahooDividendEventProvider(),
    now: () => now,
  }).refreshHeldInstruments();
