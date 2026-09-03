export interface EarningsInstrumentReference {
  instrumentId: string;
  symbol: string;
  providerSymbol: string;
  exchange: string;
}

export interface NormalizedEarningsEvent {
  type: "earnings";
  instrumentId: string;
  symbol: string;
  reportDate: string;
  fiscalDateEnding: string;
  epsEstimate: string | null;
  currency: "USD" | "CAD";
  timeOfDay: string | null;
  provider: string;
  providerEventId: string;
  providerRevision: string;
}

export interface EarningsEventRange {
  range: {
    requestedStartDate: string;
    requestedEndDate: string;
    provider: string;
    observedAt: string;
    providerRevision: string;
    /** Number of provider rows before portfolio-symbol filtering. */
    sourceEventCount?: number;
  };
  events: NormalizedEarningsEvent[];
}

export interface EarningsProvider {
  getEarningsCalendar(
    instruments: readonly EarningsInstrumentReference[],
    startDate: string,
    endDate: string,
  ): Promise<EarningsEventRange>;
}

export interface EarningsHistoryRange {
  range: {
    requestedStartDate: string;
    requestedEndDate: string;
    provider: string;
    observedAt: string;
    providerRevision: string;
    secCik: string | null;
    /** False when the provider returned useful events with known gaps. */
    complete?: boolean;
  };
  events: NormalizedEarningsEvent[];
}

export interface EarningsHistoryProvider {
  getEarningsHistory(
    instrument: EarningsInstrumentReference & { currency: "USD" | "CAD" },
    startDate: string,
    endDate: string,
  ): Promise<EarningsHistoryRange>;
}
