export interface InstrumentMetadata {
  symbol: string;
  companyName: string;
  exchange: string;
  currency: string;
  instrumentType: "EQUITY" | "ETF";
}

export interface DailyBar {
  date: string;
  close: number | null;
  adjustedClose: number | null;
}

export interface DailySeries {
  metadata: InstrumentMetadata;
  bars: DailyBar[];
  corporateActionDates: Set<string>;
}

export interface MarketDataProvider {
  getInstrument(
    symbol: string,
    startDate: string,
    endDate: string,
  ): Promise<DailySeries>;
}
