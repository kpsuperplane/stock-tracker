export interface ProviderRangeCoverage {
  requestedStartDate: string;
  requestedEndDate: string;
  coverageStartDate: string | null;
  coverageEndDate: string | null;
  isComplete: boolean;
  basis: "provider-confirmed" | "source-reported" | "unverified";
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
