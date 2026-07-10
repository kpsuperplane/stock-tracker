export interface ProviderRangeCoverage {
  requestedStartDate: string;
  requestedEndDate: string;
  coverageStartDate: string;
  coverageEndDate: string;
  isComplete: boolean;
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
  range: ProviderRangeCoverage;
  events: NormalizedSplitEvent[];
}

export interface CorporateActionProvider {
  getSplits(
    symbol: string,
    startDate: string,
    endDate: string,
  ): Promise<SplitEventRange>;
}
