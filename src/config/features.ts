/**
 * Deployment-controlled portfolio cutover flags.
 *
 * These flags deliberately accept only the literal boolean true or the exact
 * string "true". Environment variables are untrusted input; values such as
 * "on", "1", or arbitrary non-empty strings must never enable production
 * behavior accidentally.
 */
export interface FeatureFlagEnv {
  PORTFOLIO_DUAL_WRITE_ENABLED?: unknown;
  PORTFOLIO_MIGRATOR_ENABLED?: unknown;
  PORTFOLIO_NEW_READS_ENABLED?: unknown;
  PORTFOLIO_HISTORY_ENABLED?: unknown;
  PORTFOLIO_NEW_WRITES_ENABLED?: unknown;
  SYNC_CURRENT_ENABLED?: unknown;
  SYNC_FUTURE_ENABLED?: unknown;
  SYNC_RECENT_ENABLED?: unknown;
  SYNC_HISTORY_ENABLED?: unknown;
  READ_MODEL_CACHE_ENABLED?: unknown;
  READ_MODEL_PUBLISH_ENABLED?: unknown;
  LEGACY_SYNC_ENABLED?: unknown;
}

export interface PortfolioFeatureFlags {
  dualWrite: boolean;
  migrator: boolean;
  newReads: boolean;
  history: boolean;
  newWrites: boolean;
  syncCurrent: boolean;
  syncFuture: boolean;
  syncRecent: boolean;
  syncHistory: boolean;
  readModelCache: boolean;
  readModelPublish: boolean;
  legacySync: boolean;
}

export const defaultPortfolioFeatureFlags: PortfolioFeatureFlags = {
  dualWrite: false,
  migrator: false,
  newReads: false,
  history: false,
  newWrites: false,
  syncCurrent: false,
  syncFuture: false,
  syncRecent: false,
  syncHistory: false,
  readModelCache: false,
  readModelPublish: false,
  legacySync: false,
};

export const parseFeatureFlag = (value: unknown): boolean =>
  value === true || value === "true";

export const readPortfolioFeatureFlags = (
  env: FeatureFlagEnv,
): PortfolioFeatureFlags => ({
  ...defaultPortfolioFeatureFlags,
  dualWrite: parseFeatureFlag(env.PORTFOLIO_DUAL_WRITE_ENABLED),
  migrator: parseFeatureFlag(env.PORTFOLIO_MIGRATOR_ENABLED),
  newReads: parseFeatureFlag(env.PORTFOLIO_NEW_READS_ENABLED),
  history: parseFeatureFlag(env.PORTFOLIO_HISTORY_ENABLED),
  newWrites: parseFeatureFlag(env.PORTFOLIO_NEW_WRITES_ENABLED),
  syncCurrent: parseFeatureFlag(env.SYNC_CURRENT_ENABLED),
  syncFuture: parseFeatureFlag(env.SYNC_FUTURE_ENABLED),
  syncRecent: parseFeatureFlag(env.SYNC_RECENT_ENABLED),
  syncHistory: parseFeatureFlag(env.SYNC_HISTORY_ENABLED),
  readModelCache: parseFeatureFlag(env.READ_MODEL_CACHE_ENABLED),
  readModelPublish: parseFeatureFlag(env.READ_MODEL_PUBLISH_ENABLED),
  legacySync: parseFeatureFlag(env.LEGACY_SYNC_ENABLED),
});
