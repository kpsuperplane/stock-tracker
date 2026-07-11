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
  PORTFOLIO_NEW_WRITES_ENABLED?: unknown;
}

export interface PortfolioFeatureFlags {
  dualWrite: boolean;
  migrator: boolean;
  newReads: boolean;
  newWrites: boolean;
}

export const defaultPortfolioFeatureFlags: PortfolioFeatureFlags = {
  dualWrite: false,
  migrator: false,
  newReads: false,
  newWrites: false,
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
  newWrites: parseFeatureFlag(env.PORTFOLIO_NEW_WRITES_ENABLED),
});
