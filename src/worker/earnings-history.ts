import { AlphaVantageEarningsHistoryProvider } from "../providers/alpha-vantage-earnings-history";
import { SecEarningsHistoryProvider } from "../providers/sec-earnings";
import { AlphaVantageRequestBudget } from "../services/alpha-vantage-budget";
import {
  EarningsHistoryBackfillService,
  type EarningsHistoryBackfillSummary,
} from "../services/earnings-history-backfill";
import { easternMarketDate } from "../shared/dates";
import type { Env } from "./env";

export const runEarningsHistoryBackfill = (
  env: Env,
  now: Date,
  budget = new AlphaVantageRequestBudget(
    env.DB,
    easternMarketDate(now.toISOString()),
    () => now,
  ),
): Promise<EarningsHistoryBackfillSummary> =>
  new EarningsHistoryBackfillService({
    db: env.DB,
    ...(env.SEC_USER_AGENT
      ? { secProvider: new SecEarningsHistoryProvider(env.SEC_USER_AGENT) }
      : {}),
    ...(env.ALPHA_VANTAGE_API_KEY
      ? {
          alphaProvider: new AlphaVantageEarningsHistoryProvider(
            env.ALPHA_VANTAGE_API_KEY,
            budget.fetcher("earnings_history"),
          ),
        }
      : {}),
    now: () => now,
  }).refreshDue();
