import type { YahooInstrumentType } from "../domain/instruments";

export interface InstrumentMetadata {
  symbol: string;
  companyName: string;
  exchange: string;
  currency: string;
  instrumentType: YahooInstrumentType;
}

export interface DailyBar {
  date: string;
  close: number | null;
  adjustedClose: number | null;
  /** Exact provider decimal text when the adapter can preserve it. */
  closeDecimal?: string | null;
  adjustedCloseDecimal?: string | null;
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
