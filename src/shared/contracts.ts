export interface ScreeningJobMessage {
  screeningId: string;
  reportRunId: string;
  tickerId: string;
}

/** The normalized pipeline queue deliberately carries only the outbox batch ID. */
export interface PipelineDispatchMessage {
  dispatchBatchId: string;
}

export type QueueMessage = ScreeningJobMessage | PipelineDispatchMessage;

/**
 * Queue routing discriminants.  The two message contracts are intentionally
 * exact and mutually exclusive: a normalized message can never be mistaken
 * for a legacy screening payload (or vice versa) during the transition.
 */
export const isPipelineDispatchMessage = (
  body: unknown,
): body is PipelineDispatchMessage => {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 1 &&
    typeof candidate.dispatchBatchId === "string" &&
    candidate.dispatchBatchId.length > 0
  );
};

export const isScreeningJobMessage = (
  body: unknown,
): body is ScreeningJobMessage => {
  if (typeof body !== "object" || body === null) return false;
  const candidate = body as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    typeof candidate.screeningId === "string" &&
    candidate.screeningId.length > 0 &&
    typeof candidate.reportRunId === "string" &&
    candidate.reportRunId.length > 0 &&
    typeof candidate.tickerId === "string" &&
    candidate.tickerId.length > 0
  );
};

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

export interface AccountDto {
  id: string;
  categoryId: string;
  name: string;
  owner: string;
  sortOrder: number;
  revision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AccountCategoryDto {
  id: string;
  name: string;
  sortOrder: number;
  revision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  accounts: AccountDto[];
}

export type AccountScopeType = "all" | "owner" | "category" | "account";

export interface AccountScopeSelection {
  scopeType: AccountScopeType;
  scopeId?: string;
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
  /** Present for account-aware responses; optional for cached legacy payloads. */
  accountId?: string;
  accountName?: string | null;
  categoryId?: string | null;
  categoryName?: string | null;
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

export type ReadModelLocale = "en" | "cn";

export interface ReadModelSourceDto {
  title: string;
  publisher: string | null;
  publishedAt: string | null;
  sourceUrl: string | null;
  cited: boolean;
}

export interface PortfolioMovementDto {
  tradingDate: string;
  previousTradingDate: string | null;
  previousRawCloseDecimal: string | null;
  currentRawCloseDecimal: string | null;
  movementAmountDecimal: string | null;
  movementPercentDecimal: string | null;
  rawCloseDifferenceDecimal: string | null;
  basis: "split_adjusted_price_return" | "legacy_migration" | null;
  qualified: boolean | null;
}

export interface PortfolioConflictDto {
  code: string;
  message: string;
  instrumentId?: string;
  effectiveDate?: string;
}

export interface PortfolioPositionDto {
  instrumentId: string;
  symbol: string;
  companyName: string;
  exchange: string;
  currency: "USD" | "CAD";
  quantityDecimal: string;
  valuationDecimal: string | null;
  latestTradingDate: string | null;
  currentRawCloseDecimal: string | null;
  movement: PortfolioMovementDto | null;
  summaryZhCn: string | null;
  analysisStatus:
    | "complete"
    | "pending"
    | "stale"
    | "error"
    | "unavailable"
    | null;
  sources: ReadModelSourceDto[];
  freshness: "fresh" | "stale" | "error" | "pending" | "unavailable";
  conflicts: PortfolioConflictDto[];
}

export interface PortfolioReadModelDto {
  asOfDate: string;
  latestTradingDate: string | null;
  actualTradingDates: string[];
  locale: ReadModelLocale;
  positions: PortfolioPositionDto[];
  totals: Record<"USD" | "CAD", string>;
  conflicts: PortfolioConflictDto[];
  freshness: "fresh" | "stale" | "error" | "pending" | "unavailable";
  nextCursor: string | null;
}

export type PortfolioRangePreset =
  | "today"
  | "1w"
  | "30d"
  | "3m"
  | "ytd"
  | "1y"
  | "all"
  | "custom";

export type PortfolioMetric =
  | "totalValue"
  | "realizedGains"
  | "unrealizedGains"
  | "dividends";

export type PortfolioHistoryCoverageStatus =
  | "complete"
  | "estimated"
  | "partial"
  | "pending";

export interface PortfolioHistoryCoverageDto {
  status: PortfolioHistoryCoverageStatus;
  missingPrices: Array<{
    instrumentId: string;
    symbol: string;
    date: string;
  }>;
  splitConflicts: PortfolioConflictDto[];
  dividendRefresh: Array<{
    instrumentId: string;
    symbol: string;
    status: string;
    message: string | null;
  }>;
}

export interface PortfolioHistoryPointDto {
  date: string;
  totalValueDecimal: string | null;
  realizedGainsDecimal: string;
  unrealizedGainsDecimal: string | null;
  dividendsDecimal: string;
  status: Exclude<PortfolioHistoryCoverageStatus, "pending">;
}

export interface PortfolioHistoryPositionDto {
  instrumentId: string;
  symbol: string;
  companyName: string;
  exchange: string;
  currency: "USD" | "CAD";
  quantityDecimal: string;
  averageCostDecimal: string;
  bookCostDecimal: string;
  marketValueDecimal: string | null;
  unrealizedGainDecimal: string | null;
  realizedGainDecimal: string;
  dividendsDecimal: string;
  latestPriceDecimal: string | null;
  latestPriceDate: string | null;
  valuationStatus: "complete" | "estimated" | "partial";
}

export interface PortfolioHistorySummaryDto {
  valueDecimal: string | null;
  periodDeltaDecimal: string | null;
}

export interface PortfolioHistoryCurrencyDto {
  currency: "USD" | "CAD";
  summaries: Record<PortfolioMetric, PortfolioHistorySummaryDto>;
  points: PortfolioHistoryPointDto[];
  positions: PortfolioHistoryPositionDto[];
  granularity: "daily" | "weekly" | "monthly";
  coverage: PortfolioHistoryCoverageDto;
}

export interface PortfolioHistoryReadModelDto {
  range: PortfolioRangePreset;
  startDate: string;
  endDate: string;
  dataThrough: string | null;
  locale: ReadModelLocale;
  currencies: PortfolioHistoryCurrencyDto[];
}

export interface CalendarMoverDto extends PortfolioPositionDto {
  id: string;
  heldQuantityDecimal: string;
  tradingDate: string;
}

export interface CalendarDividendDto {
  id: string;
  instrumentId: string;
  symbol: string;
  companyName: string;
  currency: "USD" | "CAD";
  exDate: string;
  paymentDate: string | null;
  amountPerShareDecimal: string | null;
  heldQuantityDecimal: string;
  expectedTotalValueDecimal: string | null;
  eligible: boolean;
  status: "active" | "stale" | "error" | "superseded";
  sourceUrl: string | null;
  provider: string;
}

export interface CalendarEarningsDto {
  id: string;
  instrumentId: string;
  symbol: string;
  companyName: string;
  reportDate: string;
  fiscalDateEnding: string;
  epsEstimateDecimal: string | null;
  currency: "USD" | "CAD";
  timeOfDay: string | null;
  heldQuantityDecimal: string;
  status: "active" | "stale";
  provider: string;
}

export interface CalendarPendingDto {
  kind: "market_fact" | "split_review";
  instrumentId: string | null;
  symbol: string | null;
  date: string | null;
  status: string;
  message: string;
}

export interface CalendarReadModelDto {
  startDate: string;
  endDate: string;
  asOfDate: string;
  locale: ReadModelLocale;
  actualTradingDates: string[];
  movers: CalendarMoverDto[];
  dividends: CalendarDividendDto[];
  earnings: CalendarEarningsDto[];
  events: Array<
    | (CalendarMoverDto & { kind: "mover" })
    | (CalendarDividendDto & { kind: "dividend" })
    | (CalendarEarningsDto & { kind: "earnings" })
  >;
  pending: CalendarPendingDto[];
  pendingFacts: CalendarPendingDto[];
  splitReview: CalendarPendingDto[];
  futureDividendStatus: "known" | "not_currently_known";
  earningsCoverageStatus: "current" | "stale" | "unavailable";
  conflicts: PortfolioConflictDto[];
  nextCursor: string | null;
}

export interface JobReadModelDto {
  id: string;
  triggerType: string;
  requestedStartDate: string | null;
  requestedEndDate: string | null;
  priority: number;
  status: string;
  createdAt: string;
  updatedAt: string;
  progress: {
    workTotal: number;
    workReused: number;
    workSkipped: number;
    workFetched: number;
    workAnalyzed: number;
    workProcessed: number;
    workFailed: number;
  };
  work: Array<{
    id: string;
    workType: string;
    instrumentId: string | null;
    effectiveDate: string | null;
    state: string;
    outcome: string | null;
    terminalErrorCode: string | null;
    terminalErrorMessage: string | null;
  }>;
  errors: Array<{
    workItemId: string;
    code: string | null;
    message: string | null;
    effectiveDate: string | null;
  }>;
  nextCursor: string | null;
}

export interface EarningsSyncStatusDto {
  provider: string;
  coverageStartDate: string | null;
  coverageEndDate: string | null;
  observedAt: string | null;
  status: "current" | "stale" | "unavailable";
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export interface StatusReadModelDto {
  earningsCoverage: EarningsSyncStatusDto | null;
  jobs: JobReadModelDto[];
  nextCursor: string | null;
}
