export interface ScreeningJobMessage {
  screeningId: string;
  reportRunId: string;
  tickerId: string;
}

export type RunStatus =
  | "pending"
  | "running"
  | "complete"
  | "complete_with_errors"
  | "no_market_data";
export type Confidence = "high" | "medium" | "low";

export interface SourceDto {
  title: string;
  publisher: string;
  publishedAt: string;
  url: string;
  cited: boolean;
}

export interface MoverDto {
  screeningId: string;
  symbol: string;
  companyName: string;
  exchange: string;
  currency: string;
  currentPrice: number | null;
  changeAmount: number | null;
  changePct: number | null;
  qualified: boolean | null;
  explanationZhCn: string | null;
  confidence: Confidence | null;
  clearCatalyst: boolean | null;
  analysisStatus: "complete" | "unavailable" | null;
  sources: SourceDto[];
}

export interface ReportSummaryDto {
  id: string;
  tradingDate: string;
  status: RunStatus;
  tickersTotal: number;
  tickersProcessed: number;
  tickersQualified: number;
  tickersFailed: number;
}

export interface ReportDto {
  run: ReportSummaryDto;
  movers: MoverDto[];
}
