export interface UnverifiedSplitRangeCoverage {
  requestedStartDate: string;
  requestedEndDate: string;
  coverageStartDate: null;
  coverageEndDate: null;
  isComplete: false;
  basis: "unverified";
  provider: string;
  observedAt: string;
  providerRevision: string;
}

export interface SplitEventIdentity {
  provider: string;
  providerEventId: string;
  providerRevision: string;
}

export interface NormalizedSplitEvent extends SplitEventIdentity {
  type: "split";
  symbol: string;
  effectiveDate: string;
  numerator: string;
  denominator: string;
}

export interface SplitEventRange {
  symbol: string;
  range: UnverifiedSplitRangeCoverage;
  events: NormalizedSplitEvent[];
}

export interface CorporateActionProvider {
  getSplits(
    symbol: string,
    startDate: string,
    endDate: string,
  ): Promise<SplitEventRange>;
}
