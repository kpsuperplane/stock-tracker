import { DecimalValue } from "../domain/decimal";
import { deriveHoldings } from "../domain/holdings";
import type {
  CalendarDividendDto,
  CalendarMoverDto,
  CalendarPendingDto,
  CalendarReadModelDto,
  PortfolioConflictDto,
  ReadModelLocale,
  ReadModelSourceDto,
} from "../shared/contracts";

interface TransactionRow {
  instrument_id: string;
  trade_date: string;
  quantity_decimal: string;
  side: "buy" | "sell";
  id: string;
}

interface SplitRow {
  instrument_id: string;
  effective_date: string;
  split_numerator: string;
  split_denominator: string;
  id: string;
}

interface FactRow {
  id: string;
  instrument_id: string;
  symbol: string;
  company_name: string;
  exchange: string;
  currency: "USD" | "CAD";
  trading_date: string;
  previous_trading_date: string | null;
  previous_raw_close_decimal: string | null;
  current_raw_close_decimal: string;
  split_adjusted_previous_close_decimal: string | null;
  movement_amount_decimal: string | null;
  movement_percent_decimal: string | null;
  raw_close_difference_decimal: string | null;
  movement_basis: "split_adjusted_price_return" | "legacy_migration";
  status: "valid" | "stale" | "error";
  error_code: string | null;
  error_message: string | null;
}

interface AnalysisRow {
  id: string;
  daily_market_fact_id: string;
  summary_zh_cn: string | null;
  status: "pending" | "complete" | "stale" | "error";
  error_code: string | null;
  error_message: string | null;
}

interface SourceRow {
  movement_analysis_id: string;
  title: string;
  publisher: string | null;
  published_at: string | null;
  source_url: string;
  cited: number;
}

interface DividendRow {
  id: string;
  instrument_id: string;
  symbol: string;
  company_name: string;
  currency: "USD" | "CAD";
  ex_date: string;
  payment_date: string | null;
  amount_per_share_decimal: string;
  status: "active" | "stale" | "error" | "superseded";
  source_url: string | null;
  provider: string;
}

export interface CalendarReadModelInput {
  startDate: string;
  endDate: string;
  asOfDate: string;
  locale: ReadModelLocale;
  cursor?: { date: string; kind: string; id: string } | null;
  limit?: number;
}

const safeDecimal = (value: string | null): string | null => {
  if (value === null) return null;
  try {
    return DecimalValue.parse(value).toString();
  } catch {
    return null;
  }
};

const multiplyDecimal = (left: string, right: string): string | null => {
  const normalizedLeft = safeDecimal(left);
  const normalizedRight = safeDecimal(right);
  if (normalizedLeft === null || normalizedRight === null) return null;
  try {
    return DecimalValue.parse(normalizedLeft)
      .multiply(normalizedRight)
      .toString();
  } catch {
    return null;
  }
};

const qualifies = (value: string | null): boolean => {
  const normalized = safeDecimal(value);
  if (normalized === null) return false;
  const decimal = DecimalValue.parse(normalized);
  return (
    (decimal.isNegative() ? decimal.multiply("-1") : decimal).compare("5") >= 0
  );
};

const safeSourceUrl = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const trimmed = value.trim();
    const parsed = new URL(trimmed);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0 &&
      !parsed.username &&
      !parsed.password
      ? trimmed
      : null;
  } catch {
    return null;
  }
};

const rangePlaceholders = (ids: readonly string[]): string =>
  ids.map((_id, index) => `?${index + 1}`).join(", ");

const pendingMessage = (status: string): string =>
  status === "processing"
    ? "Market data is currently processing."
    : "Market data is waiting to be fetched.";

export class CalendarReadModelService {
  constructor(private readonly db: D1Database) {}

  async read(input: CalendarReadModelInput): Promise<CalendarReadModelDto> {
    const [
      transactionResult,
      splitResult,
      factResult,
      dividendResult,
      pendingFacts,
      splitReview,
    ] = await Promise.all([
      this.db
        .prepare(
          `SELECT id, instrument_id, trade_date, side, quantity_decimal
             FROM transactions ORDER BY instrument_id, trade_date, id`,
        )
        .all<TransactionRow>(),
      this.db
        .prepare(
          `SELECT id, instrument_id, effective_date,
                    split_numerator, split_denominator
             FROM corporate_actions WHERE status = 'active'
             ORDER BY instrument_id, effective_date, id`,
        )
        .all<SplitRow>(),
      this.db
        .prepare(
          `SELECT f.id, f.instrument_id, i.symbol, i.company_name,
                    i.exchange, i.currency, f.trading_date,
                    f.previous_trading_date, f.previous_raw_close_decimal,
                    f.current_raw_close_decimal,
                    f.split_adjusted_previous_close_decimal,
                    f.movement_amount_decimal, f.movement_percent_decimal,
                    f.raw_close_difference_decimal, f.movement_basis, f.status,
                    f.error_code, f.error_message
             FROM daily_market_facts f JOIN instruments i ON i.id = f.instrument_id
             WHERE f.trading_date >= ?1 AND f.trading_date <= ?2
             ORDER BY f.trading_date, i.symbol, f.id`,
        )
        .bind(input.startDate, input.endDate)
        .all<FactRow>(),
      this.db
        .prepare(
          `SELECT d.id, d.instrument_id, i.symbol, i.company_name,
                    i.currency, d.ex_date, d.payment_date,
                    d.amount_per_share_decimal, d.status, d.source_url,
                    d.provider
             FROM dividend_events d JOIN instruments i ON i.id = d.instrument_id
             WHERE d.ex_date >= ?1 AND d.ex_date <= ?2
             ORDER BY d.ex_date, i.symbol, d.id`,
        )
        .bind(input.startDate, input.endDate)
        .all<DividendRow>(),
      this.db
        .prepare(
          `SELECT w.instrument_id, i.symbol, w.effective_date, w.state
             FROM work_items w LEFT JOIN instruments i ON i.id = w.instrument_id
             WHERE w.scope = 'global_fact' AND w.work_type = 'market_fact'
               AND w.effective_date >= ?1 AND w.effective_date <= ?2
               AND w.state NOT IN ('complete', 'terminal')
             ORDER BY w.effective_date, i.symbol, w.id`,
        )
        .bind(input.startDate, input.endDate)
        .all<{
          instrument_id: string | null;
          symbol: string | null;
          effective_date: string | null;
          state: string;
        }>(),
      this.db
        .prepare(
          `SELECT a.instrument_id, i.symbol, a.effective_date AS date,
                    a.status, 'split_review' AS kind
             FROM corporate_actions a JOIN instruments i ON i.id = a.instrument_id
             WHERE a.status IN ('candidate', 'quarantined')
               AND a.effective_date >= ?1 AND a.effective_date <= ?2
             UNION ALL
             SELECT c.instrument_id, i.symbol, NULL AS date,
                    c.status, 'split_review' AS kind
             FROM corporate_action_coverage c LEFT JOIN instruments i
               ON i.id = c.instrument_id
             WHERE c.status IN ('review_required', 'conflict', 'refreshing', 'unavailable')
               AND c.requested_start_date <= ?2
               AND c.requested_end_date >= ?1
             ORDER BY date`,
        )
        .bind(input.startDate, input.endDate)
        .all<{
          instrument_id: string;
          symbol: string | null;
          date: string | null;
          status: string;
          kind: "split_review";
        }>(),
    ]);

    const transactionsByInstrument = new Map<string, TransactionRow[]>();
    for (const row of transactionResult.results) {
      const list = transactionsByInstrument.get(row.instrument_id) ?? [];
      list.push(row);
      transactionsByInstrument.set(row.instrument_id, list);
    }
    const splitsByInstrument = new Map<string, SplitRow[]>();
    for (const row of splitResult.results) {
      const list = splitsByInstrument.get(row.instrument_id) ?? [];
      list.push(row);
      splitsByInstrument.set(row.instrument_id, list);
    }
    const holdingsByInstrument = new Map<
      string,
      ReturnType<typeof deriveHoldings>
    >();
    const conflicts: PortfolioConflictDto[] = [];
    for (const [
      instrumentId,
      instrumentTransactions,
    ] of transactionsByInstrument) {
      try {
        holdingsByInstrument.set(
          instrumentId,
          deriveHoldings({
            today: input.asOfDate,
            transactions: instrumentTransactions.map((row) => ({
              id: row.id,
              tradeDate: row.trade_date,
              side: row.side,
              quantityDecimal: row.quantity_decimal,
            })),
            activeSplits: (splitsByInstrument.get(instrumentId) ?? []).map(
              (row) => ({
                id: row.id,
                effectiveDate: row.effective_date,
                numerator: row.split_numerator,
                denominator: row.split_denominator,
              }),
            ),
          }),
        );
      } catch (error) {
        conflicts.push({
          code: "holding_derivation_error",
          message: String(error).slice(0, 200),
          instrumentId,
        });
      }
    }

    const factIds = factResult.results.map((row) => row.id);
    const analyses = new Map<string, AnalysisRow>();
    const sources = new Map<string, ReadModelSourceDto[]>();
    if (factIds.length > 0) {
      const placeholders = rangePlaceholders(factIds);
      const result = await this.db
        .prepare(
          `SELECT id, daily_market_fact_id, summary_zh_cn, status,
                  error_code, error_message
           FROM movement_analyses WHERE daily_market_fact_id IN (${placeholders})`,
        )
        .bind(...factIds)
        .all<AnalysisRow>();
      for (const row of result.results)
        analyses.set(row.daily_market_fact_id, row);
      const analysisIds = result.results.map((row) => row.id);
      if (analysisIds.length > 0) {
        const sourceResult = await this.db
          .prepare(
            `SELECT movement_analysis_id, title, publisher, published_at,
                    source_url, cited
             FROM news_sources
             WHERE movement_analysis_id IN (${rangePlaceholders(analysisIds)})
             ORDER BY movement_analysis_id, source_order`,
          )
          .bind(...analysisIds)
          .all<SourceRow>();
        for (const row of sourceResult.results) {
          const sourceUrl = safeSourceUrl(row.source_url);
          if (!sourceUrl) continue;
          const list = sources.get(row.movement_analysis_id) ?? [];
          list.push({
            title: row.title,
            publisher: row.publisher,
            publishedAt: row.published_at,
            sourceUrl,
            cited: Boolean(row.cited),
          });
          sources.set(row.movement_analysis_id, list);
        }
      }
    }

    const movers: CalendarMoverDto[] = [];
    for (const fact of factResult.results) {
      if (fact.status !== "valid") {
        conflicts.push({
          code: fact.error_code ?? `market_fact_${fact.status}`,
          message:
            fact.error_message ?? `The daily market fact is ${fact.status}.`,
          instrumentId: fact.instrument_id,
          effectiveDate: fact.trading_date,
        });
        continue;
      }
      if (!qualifies(fact.movement_percent_decimal)) continue;
      const holdings = holdingsByInstrument.get(fact.instrument_id);
      if (!holdings?.isEligibleForScreening(fact.trading_date)) continue;
      const heldQuantityDecimal = holdings.quantityAtStartOfDay(
        fact.trading_date,
      );
      const analysis = analyses.get(fact.id);
      const movement = {
        tradingDate: fact.trading_date,
        previousTradingDate: fact.previous_trading_date,
        previousRawCloseDecimal: safeDecimal(fact.previous_raw_close_decimal),
        currentRawCloseDecimal: safeDecimal(fact.current_raw_close_decimal),
        movementAmountDecimal: safeDecimal(fact.movement_amount_decimal),
        movementPercentDecimal: safeDecimal(fact.movement_percent_decimal),
        rawCloseDifferenceDecimal: safeDecimal(
          fact.raw_close_difference_decimal,
        ),
        basis: fact.movement_basis,
        qualified: true,
      } as const;
      movers.push({
        id: fact.id,
        instrumentId: fact.instrument_id,
        symbol: fact.symbol,
        companyName: fact.company_name,
        exchange: fact.exchange,
        currency: fact.currency,
        quantityDecimal: heldQuantityDecimal,
        heldQuantityDecimal,
        valuationDecimal: multiplyDecimal(
          heldQuantityDecimal,
          fact.current_raw_close_decimal,
        ),
        latestTradingDate: fact.trading_date,
        currentRawCloseDecimal: safeDecimal(fact.current_raw_close_decimal),
        movement,
        summaryZhCn:
          analysis?.status === "complete" ? analysis.summary_zh_cn : null,
        analysisStatus: analysis?.status ?? "unavailable",
        sources:
          analysis?.status === "complete"
            ? (sources.get(analysis.id) ?? [])
            : [],
        freshness:
          analysis?.status === "complete"
            ? "fresh"
            : (analysis?.status ?? "unavailable"),
        conflicts: [
          ...(fact.movement_basis === "legacy_migration"
            ? [
                {
                  code: "legacy_movement_basis",
                  message: "This movement uses a legacy close basis.",
                  instrumentId: fact.instrument_id,
                  effectiveDate: fact.trading_date,
                },
              ]
            : []),
          ...(safeDecimal(fact.current_raw_close_decimal) === null
            ? [
                {
                  code: "invalid_close_decimal",
                  message: "The stored close is not a valid decimal.",
                  instrumentId: fact.instrument_id,
                  effectiveDate: fact.trading_date,
                },
              ]
            : []),
          ...(analysis && analysis.status !== "complete"
            ? [
                {
                  code:
                    analysis.error_code ??
                    `movement_analysis_${analysis.status}`,
                  message:
                    analysis.error_message ??
                    `The movement analysis is ${analysis.status}.`,
                  instrumentId: fact.instrument_id,
                  effectiveDate: fact.trading_date,
                },
              ]
            : []),
        ],
        tradingDate: fact.trading_date,
      });
    }

    const dividends: CalendarDividendDto[] = [];
    for (const event of dividendResult.results) {
      const holdings = holdingsByInstrument.get(event.instrument_id);
      let heldQuantityDecimal = "0";
      let eligible = false;
      if (holdings) {
        try {
          heldQuantityDecimal = holdings.quantityForExDividend(event.ex_date);
          eligible = holdings.isEligibleForExDividend(event.ex_date);
        } catch {
          conflicts.push({
            code: "dividend_holdings_error",
            message: "Unable to derive holdings for the ex-dividend date.",
            instrumentId: event.instrument_id,
            effectiveDate: event.ex_date,
          });
        }
      }
      dividends.push({
        id: event.id,
        instrumentId: event.instrument_id,
        symbol: event.symbol,
        companyName: event.company_name,
        currency: event.currency,
        exDate: event.ex_date,
        paymentDate: event.payment_date,
        amountPerShareDecimal:
          safeDecimal(event.amount_per_share_decimal) ??
          event.amount_per_share_decimal,
        heldQuantityDecimal,
        expectedTotalValueDecimal: eligible
          ? multiplyDecimal(heldQuantityDecimal, event.amount_per_share_decimal)
          : null,
        eligible,
        status: event.status,
        sourceUrl: safeSourceUrl(event.source_url),
        provider: event.provider,
      });
      if (event.status !== "active") {
        conflicts.push({
          code: `dividend_event_${event.status}`,
          message: `The dividend event is ${event.status}.`,
          instrumentId: event.instrument_id,
          effectiveDate: event.ex_date,
        });
      }
      if (safeDecimal(event.amount_per_share_decimal) === null) {
        conflicts.push({
          code: "invalid_dividend_decimal",
          message: "The stored dividend amount is not a valid decimal.",
          instrumentId: event.instrument_id,
          effectiveDate: event.ex_date,
        });
      }
    }

    const pending: CalendarPendingDto[] = pendingFacts.results.map((row) => ({
      kind: "market_fact",
      instrumentId: row.instrument_id,
      symbol: row.symbol,
      date: row.effective_date,
      status: row.state,
      message: pendingMessage(row.state),
    }));
    const splitPending: CalendarPendingDto[] = splitReview.results.map(
      (row) => ({
        kind: "split_review",
        instrumentId: row.instrument_id,
        symbol: row.symbol,
        date: row.date,
        status: row.status,
        message: "Corporate action history requires review.",
      }),
    );
    pending.push(...splitPending);
    const actualTradingDates = [
      ...new Set(factResult.results.map((row) => row.trading_date)),
    ].sort();
    const eventRows = [
      ...movers.map((mover) => ({ ...mover, kind: "mover" as const })),
      ...dividends.map((dividend) => ({
        ...dividend,
        kind: "dividend" as const,
      })),
    ].sort(
      (left, right) =>
        ("tradingDate" in left ? left.tradingDate : left.exDate).localeCompare(
          "tradingDate" in right ? right.tradingDate : right.exDate,
        ) ||
        left.kind.localeCompare(right.kind) ||
        left.id.localeCompare(right.id),
    );
    const cursor = input.cursor;
    const startIndex = cursor
      ? eventRows.findIndex((event) => {
          const date =
            "tradingDate" in event ? event.tradingDate : event.exDate;
          return (
            date > cursor.date ||
            (date === cursor.date &&
              (event.kind > cursor.kind ||
                (event.kind === cursor.kind && event.id > cursor.id)))
          );
        })
      : 0;
    const offset = startIndex < 0 ? eventRows.length : startIndex;
    const limit = Math.min(Math.max(input.limit ?? 500, 1), 500);
    const selectedEvents = eventRows.slice(offset, offset + limit);
    const selectedIds = new Set(
      selectedEvents.map((event) => `${event.kind}:${event.id}`),
    );
    const selectedMovers = movers.filter((mover) =>
      selectedIds.has(`mover:${mover.id}`),
    );
    const selectedDividends = dividends.filter((dividend) =>
      selectedIds.has(`dividend:${dividend.id}`),
    );
    const last = selectedEvents.at(-1);
    const nextCursor =
      last && offset + selectedEvents.length < eventRows.length
        ? btoa(
            JSON.stringify({
              date: "tradingDate" in last ? last.tradingDate : last.exDate,
              kind: last.kind,
              id: last.id,
            }),
          )
        : null;
    const futureDividendStatus = dividends.some(
      (event) => event.exDate >= input.asOfDate,
    )
      ? "known"
      : "not_currently_known";
    return {
      startDate: input.startDate,
      endDate: input.endDate,
      asOfDate: input.asOfDate,
      locale: input.locale,
      actualTradingDates,
      movers: selectedMovers,
      dividends: selectedDividends,
      events: selectedEvents,
      pending,
      pendingFacts: pendingFacts.results.map((row) => ({
        kind: "market_fact",
        instrumentId: row.instrument_id,
        symbol: row.symbol,
        date: row.effective_date,
        status: row.state,
        message: pendingMessage(row.state),
      })),
      splitReview: splitPending,
      futureDividendStatus,
      conflicts,
      nextCursor,
    };
  }
}
