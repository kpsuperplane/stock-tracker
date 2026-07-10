import type { ProviderRangeCoverage } from "./corporate-actions";

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
}

export interface DividendEventRange {
  symbol: string;
  range: ProviderRangeCoverage;
  events: NormalizedDividendEvent[];
}

export interface DividendProvider {
  getDividends(
    symbol: string,
    startDate: string,
    endDate: string,
  ): Promise<DividendEventRange>;
}
