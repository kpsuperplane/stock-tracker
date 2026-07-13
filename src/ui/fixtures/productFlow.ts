import type {
  CalendarMoverDto,
  CalendarReadModelDto,
  PortfolioReadModelDto,
} from "../../shared/contracts";
import type { ImportPreviewResponse } from "../api";

/**
 * Small deterministic product-flow fixture shared by the integration test and
 * local UI review. It represents one imported buy flowing into the derived
 * Portfolio and a qualifying Calendar mover.
 */
const movement = {
  tradingDate: "2026-07-10",
  previousTradingDate: "2026-07-09",
  previousRawCloseDecimal: "190",
  currentRawCloseDecimal: "200.10",
  movementAmountDecimal: "10.10",
  movementPercentDecimal: "5.315789",
  rawCloseDifferenceDecimal: "10.10",
  basis: "split_adjusted_price_return" as const,
  qualified: true,
};

const source = {
  title: "Apple News",
  publisher: "Fixture Press",
  publishedAt: "2026-07-10T12:00:00.000Z",
  sourceUrl: "https://example.com/fixture/apple",
  cited: true,
};

const position = {
  instrumentId: "instrument-aapl",
  symbol: "AAPL",
  companyName: "Apple Inc.",
  exchange: "NASDAQ",
  currency: "USD" as const,
  quantityDecimal: "2",
  valuationDecimal: "400.20",
  latestTradingDate: "2026-07-10",
  currentRawCloseDecimal: "200.10",
  movement,
  summaryZhCn: "苹果发布了新的产品更新。",
  analysisStatus: "complete" as const,
  sources: [source],
  freshness: "fresh" as const,
  conflicts: [],
};

export const productFlowFixture = {
  csv: {
    filename: "portfolio-events-fixture.csv",
    contents:
      "trade_date,symbol,side,quantity,price\n2026-07-10,AAPL,BUY,2,180\n",
  },
  importPreview: {
    kind: "preview" as const,
    batchId: "fixture-import-1",
    basePositionBasisRevision: 7,
    rows: [
      {
        rowNumber: 2,
        symbol: "AAPL",
        tradeDate: "2026-07-10",
        side: "buy" as const,
        quantityDecimal: "2",
        priceDecimal: "180",
        status: "valid" as const,
        errors: [],
      },
    ],
    reviews: [],
    projectedHoldings: { "instrument-aapl": "2" },
    expiresAt: "2026-07-11T23:59:59.000Z",
  } satisfies ImportPreviewResponse,
  portfolio: {
    asOfDate: "2026-07-11",
    latestTradingDate: "2026-07-10",
    actualTradingDates: ["2026-07-10"],
    locale: "en" as const,
    positions: [position],
    totals: { USD: "400.20", CAD: "0" },
    conflicts: [],
    freshness: "fresh" as const,
    nextCursor: null,
  } satisfies PortfolioReadModelDto,
  calendar: {
    startDate: "2026-07-01",
    endDate: "2026-07-31",
    asOfDate: "2026-07-11",
    locale: "en" as const,
    actualTradingDates: ["2026-07-10"],
    movers: [
      {
        ...position,
        id: "mover-aapl-2026-07-10",
        heldQuantityDecimal: "2",
        tradingDate: "2026-07-10",
      } satisfies CalendarMoverDto,
    ],
    dividends: [],
    earnings: [],
    events: [
      {
        ...position,
        id: "mover-aapl-2026-07-10",
        heldQuantityDecimal: "2",
        tradingDate: "2026-07-10",
        kind: "mover" as const,
      },
    ],
    pending: [],
    pendingFacts: [],
    splitReview: [],
    futureDividendStatus: "not_currently_known" as const,
    earningsCoverageStatus: "unavailable" as const,
    conflicts: [],
    nextCursor: null,
  } satisfies CalendarReadModelDto,
} as const;
