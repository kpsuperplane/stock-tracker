export interface ScreeningJobMessage {
  screeningId: string;
  reportRunId: string;
  tickerId: string;
}

/** The normalized pipeline queue deliberately carries only the outbox batch ID. */
export interface PipelineDispatchMessage {
  dispatchBatchId: string;
}

export type RunStatus =
  | "pending"
  | "running"
  | "complete"
  | "complete_with_errors"
  | "no_market_data";

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

export interface SplitConfirmationDto {
  requestedStartDate: string;
  requestedEndDate: string;
  providerRevision: string;
}

export interface TransactionEventDto {
  type: "transaction";
  id: string;
  instrumentId: string;
  symbol: string;
  companyName: string;
  currency: "USD" | "CAD";
  tradeDate: string;
  side: "buy" | "sell";
  quantityDecimal: string;
  priceDecimal: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface SplitEventDto {
  type: "split";
  id: string;
  instrumentId: string;
  symbol: string;
  companyName: string;
  currency: "USD" | "CAD";
  effectiveDate: string;
  numerator: string;
  denominator: string;
  provider: string;
  providerEventId: string;
  providerRevision: string;
  retrievedAt: string;
  revision: number;
  status: "candidate" | "active" | "superseded" | "quarantined";
  conflictCode: string | null;
  conflictMessage: string | null;
}

export type PortfolioEventDto = TransactionEventDto | SplitEventDto;

export interface EventsTimelineDto {
  events: PortfolioEventDto[];
  nextCursor: string | null;
  positionBasisRevision: number;
}
