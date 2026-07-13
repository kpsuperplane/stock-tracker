export interface SourceReportedDividendRangeCoverage {
  requestedStartDate: string;
  requestedEndDate: string;
  coverageStartDate: null;
  coverageEndDate: null;
  isComplete: false;
  basis: "source-reported";
  provider: string;
  observedAt: string;
  providerRevision: string;
}

export interface DividendEventIdentity {
  provider: string;
  providerEventId: string;
  providerRevision: string;
}

export interface NormalizedDividendEvent extends DividendEventIdentity {
  type: "dividend";
  symbol: string;
  exDate: string;
  amount: string;
  currency: string;
  sourceUrl?: string | null;
}

export interface DividendEventRange {
  symbol: string;
  range: SourceReportedDividendRangeCoverage;
  events: NormalizedDividendEvent[];
}

export interface DividendProvider {
  getDividends(
    symbol: string,
    startDate: string,
    endDate: string,
    currency?: "USD" | "CAD",
  ): Promise<DividendEventRange>;
}
