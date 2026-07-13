import { deriveHoldings } from "../domain/holdings";
import type {
  CalendarDividendDto,
  CalendarEarningsDto,
  CalendarMoverDto,
  CalendarPendingDto,
  CalendarReadModelDto,
  PortfolioConflictDto,
  ReadModelLocale,
  ReadModelSourceDto,
} from "../shared/contracts";
import {
  type CalendarEventCursor,
  paginateCalendarEvents,
} from "./calendar-event-pagination";
import type {
  AnalysisRow,
  CompleteAnalysisRow,
  DividendRow,
  EarningsCoverageRow,
  EarningsRow,
  FactRow,
  SourceRow,
  SplitRow,
  TransactionRow,
} from "./calendar-read-model-types";
import {
  multiplyDecimal,
  pendingMessage,
  qualifies,
  safeDecimal,
  safeSourceUrl,
} from "./calendar-read-model-utils";

export interface CalendarReadModelInput {
  startDate: string;
  endDate: string;
  asOfDate: string;
  locale: ReadModelLocale;
  accountIds: readonly string[];
  cursor?: CalendarEventCursor | null;
  limit?: number;
}

export class CalendarReadModelService {
  constructor(private readonly db: D1Database) {}

  async read(input: CalendarReadModelInput): Promise<CalendarReadModelDto> {
    const [
      transactionResult,
      splitResult,
      factResult,
      dividendResult,
      earningsResult,
      earningsCoverage,
      pendingFacts,
      splitReview,
    ] = await Promise.all([
      this.db
        .prepare(
          `SELECT id, instrument_id, trade_date, side, quantity_decimal
             FROM transactions
            WHERE account_id IN (SELECT value FROM json_each(?1))
             ORDER BY instrument_id, trade_date, id`,
        )
        .bind(JSON.stringify(input.accountIds))
        .all<TransactionRow>(),
      this.db
        .prepare(
          `SELECT id, instrument_id, effective_date,
                    split_numerator, split_denominator
             FROM corporate_actions
            WHERE status = 'active'
              AND instrument_id IN (
                SELECT DISTINCT instrument_id FROM transactions
                 WHERE account_id IN (SELECT value FROM json_each(?1))
              )
             ORDER BY instrument_id, effective_date, id`,
        )
        .bind(JSON.stringify(input.accountIds))
        .all<SplitRow>(),
      this.db
        .prepare(
          `WITH scoped_instruments AS (
             SELECT DISTINCT instrument_id FROM transactions
              WHERE account_id IN (SELECT value FROM json_each(?1))
           )
           SELECT f.id, f.instrument_id, i.symbol, i.company_name,
                    i.exchange, i.currency, f.trading_date,
                    f.previous_trading_date, f.previous_raw_close_decimal,
                    f.current_raw_close_decimal,
                    f.split_adjusted_previous_close_decimal,
                    f.movement_amount_decimal, f.movement_percent_decimal,
                    f.raw_close_difference_decimal, f.movement_basis, f.status,
                    f.error_code, f.error_message
             FROM daily_market_facts f JOIN instruments i ON i.id = f.instrument_id
             JOIN scoped_instruments scoped ON scoped.instrument_id = f.instrument_id
             WHERE f.trading_date >= ?2 AND f.trading_date <= ?3
             ORDER BY f.trading_date, i.symbol, f.id`,
        )
        .bind(JSON.stringify(input.accountIds), input.startDate, input.endDate)
        .all<FactRow>(),
      this.db
        .prepare(
          `WITH scoped_instruments AS (
             SELECT DISTINCT instrument_id FROM transactions
              WHERE account_id IN (SELECT value FROM json_each(?1))
           )
           SELECT d.id, d.instrument_id, i.symbol, i.company_name,
                    i.currency, d.ex_date, d.payment_date,
                    d.amount_per_share_decimal, d.status,
                    d.error_code, d.error_message, d.source_url,
                    d.provider
             FROM dividend_events d JOIN instruments i ON i.id = d.instrument_id
             JOIN scoped_instruments scoped ON scoped.instrument_id = d.instrument_id
             WHERE d.ex_date >= ?2 AND d.ex_date <= ?3
               AND d.status <> 'superseded'
             ORDER BY d.ex_date, i.symbol, d.id`,
        )
        .bind(JSON.stringify(input.accountIds), input.startDate, input.endDate)
        .all<DividendRow>(),
      this.db
        .prepare(
          `WITH scoped_instruments AS (
             SELECT DISTINCT instrument_id FROM transactions
              WHERE account_id IN (SELECT value FROM json_each(?1))
           )
           SELECT e.id, e.instrument_id, i.symbol, i.company_name,
                  e.report_date, e.fiscal_date_ending,
                  e.eps_estimate_decimal, e.currency, e.time_of_day,
                  e.status, e.provider
             FROM earnings_events e JOIN instruments i ON i.id = e.instrument_id
             JOIN scoped_instruments scoped ON scoped.instrument_id = e.instrument_id
            WHERE e.report_date >= ?2 AND e.report_date <= ?3
              AND e.status <> 'superseded'
            ORDER BY e.report_date, i.symbol, e.id`,
        )
        .bind(JSON.stringify(input.accountIds), input.startDate, input.endDate)
        .all<EarningsRow>(),
      this.db
        .prepare(
          `SELECT coverage_start_date, coverage_end_date, status
             FROM earnings_calendar_coverage
            WHERE provider = 'alpha-vantage-earnings'`,
        )
        .first<EarningsCoverageRow>(),
      this.db
        .prepare(
          `WITH scoped_instruments AS (
             SELECT DISTINCT instrument_id FROM transactions
              WHERE account_id IN (SELECT value FROM json_each(?1))
           )
           SELECT w.instrument_id, i.symbol, w.effective_date, w.state
             FROM work_items w LEFT JOIN instruments i ON i.id = w.instrument_id
             JOIN scoped_instruments scoped ON scoped.instrument_id = w.instrument_id
             WHERE w.scope = 'global_fact' AND w.work_type = 'market_fact'
               AND w.effective_date >= ?2 AND w.effective_date <= ?3
               AND w.state NOT IN ('complete', 'terminal')
             ORDER BY w.effective_date, i.symbol, w.id`,
        )
        .bind(JSON.stringify(input.accountIds), input.startDate, input.endDate)
        .all<{
          instrument_id: string | null;
          symbol: string | null;
          effective_date: string | null;
          state: string;
        }>(),
      this.db
        .prepare(
          `WITH scoped_instruments AS (
             SELECT DISTINCT instrument_id FROM transactions
              WHERE account_id IN (SELECT value FROM json_each(?1))
           )
           SELECT a.instrument_id, i.symbol, a.effective_date AS date,
                    a.status, 'split_review' AS kind
             FROM corporate_actions a JOIN instruments i ON i.id = a.instrument_id
             JOIN scoped_instruments scoped ON scoped.instrument_id = a.instrument_id
             WHERE a.status IN ('candidate', 'quarantined')
               AND a.effective_date >= ?2 AND a.effective_date <= ?3
             UNION ALL
             SELECT c.instrument_id, i.symbol, NULL AS date,
                    c.status, 'split_review' AS kind
             FROM corporate_action_coverage c LEFT JOIN instruments i
               ON i.id = c.instrument_id
             JOIN scoped_instruments scoped ON scoped.instrument_id = c.instrument_id
             WHERE c.status IN ('review_required', 'conflict', 'refreshing', 'unavailable')
               AND c.requested_start_date <= ?3
               AND c.requested_end_date >= ?2
             ORDER BY date`,
        )
        .bind(JSON.stringify(input.accountIds), input.startDate, input.endDate)
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
    const legacyPendingFacts: CalendarPendingDto[] = [];
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
    const completeAnalysesByInstrument = new Map<
      string,
      CompleteAnalysisRow[]
    >();
    const sources = new Map<string, ReadModelSourceDto[]>();
    if (factIds.length > 0) {
      const analysisRows = (
        await this.db
          .prepare(
            `SELECT id, daily_market_fact_id, summary_zh_cn, status,
                    error_code, error_message
             FROM movement_analyses
             WHERE daily_market_fact_id IN (SELECT value FROM json_each(?1))`,
          )
          .bind(JSON.stringify(factIds))
          .all<AnalysisRow>()
      ).results;
      for (const row of analysisRows)
        analyses.set(row.daily_market_fact_id, row);
      const instrumentIdsWithFacts = [
        ...new Set(factResult.results.map((row) => row.instrument_id)),
      ];
      const completeRows = (
        await this.db
          .prepare(
            `SELECT f.instrument_id, f.trading_date, a.id, a.daily_market_fact_id,
                    a.summary_zh_cn, a.status, a.error_code, a.error_message
             FROM movement_analyses a
             JOIN daily_market_facts f ON f.id = a.daily_market_fact_id
             WHERE a.status = 'complete'
               AND f.instrument_id IN (SELECT value FROM json_each(?1))
               AND f.movement_basis <> 'legacy_migration'
               AND f.trading_date <= ?3
               AND (
                 f.trading_date >= ?2
                 OR f.trading_date = (
                   SELECT MAX(previous_fact.trading_date)
                   FROM daily_market_facts previous_fact
                   JOIN movement_analyses previous_analysis
                     ON previous_analysis.daily_market_fact_id = previous_fact.id
                   WHERE previous_fact.instrument_id = f.instrument_id
                     AND previous_fact.movement_basis <> 'legacy_migration'
                     AND previous_fact.trading_date < ?2
                     AND previous_analysis.status = 'complete'
                     AND previous_analysis.summary_zh_cn IS NOT NULL
                 )
                 OR f.trading_date = (
                   SELECT MAX(previous_fact.trading_date)
                   FROM daily_market_facts previous_fact
                   JOIN movement_analyses previous_analysis
                     ON previous_analysis.daily_market_fact_id = previous_fact.id
                   WHERE previous_fact.instrument_id = f.instrument_id
                     AND previous_fact.movement_basis <> 'legacy_migration'
                     AND previous_fact.trading_date < ?2
                     AND previous_analysis.status = 'complete'
                     AND EXISTS (
                       SELECT 1 FROM news_sources previous_source
                       WHERE previous_source.movement_analysis_id = previous_analysis.id
                     )
                 )
               )
             ORDER BY f.instrument_id, f.trading_date`,
          )
          .bind(
            JSON.stringify(instrumentIdsWithFacts),
            input.startDate,
            input.endDate,
          )
          .all<CompleteAnalysisRow>()
      ).results;
      for (const row of completeRows) {
        const rows = completeAnalysesByInstrument.get(row.instrument_id) ?? [];
        rows.push(row);
        completeAnalysesByInstrument.set(row.instrument_id, rows);
      }
      const analysisIds = [
        ...new Set([
          ...analysisRows.map((row) => row.id),
          ...completeRows.map((row) => row.id),
        ]),
      ];
      if (analysisIds.length > 0) {
        const sourceRows = (
          await this.db
            .prepare(
              `SELECT movement_analysis_id, title, publisher, published_at,
                      source_url, cited
               FROM news_sources
               WHERE movement_analysis_id IN (SELECT value FROM json_each(?1))
               ORDER BY movement_analysis_id, source_order`,
            )
            .bind(JSON.stringify(analysisIds))
            .all<SourceRow>()
        ).results;
        for (const row of sourceRows) {
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
      if (fact.movement_basis === "legacy_migration") {
        conflicts.push({
          code: "legacy_movement_basis",
          message:
            "This market fact uses a legacy basis and is awaiting normalized refresh.",
          instrumentId: fact.instrument_id,
          effectiveDate: fact.trading_date,
        });
        const legacyHoldings = holdingsByInstrument.get(fact.instrument_id);
        if (legacyHoldings?.isEligibleForScreening(fact.trading_date)) {
          legacyPendingFacts.push({
            kind: "market_fact",
            instrumentId: fact.instrument_id,
            symbol: fact.symbol,
            date: fact.trading_date,
            status: "legacy_pending",
            message: "Normalized market data refresh is pending.",
          });
        }
        continue;
      }
      if (fact.status !== "valid") {
        conflicts.push({
          code: fact.error_code ?? `market_fact_${fact.status}`,
          message:
            fact.error_message ?? `The daily market fact is ${fact.status}.`,
          instrumentId: fact.instrument_id,
          effectiveDate: fact.trading_date,
        });
      }
      if (safeDecimal(fact.movement_percent_decimal) === null) {
        conflicts.push({
          code: "invalid_movement_decimal",
          message: "The stored movement percentage is not a valid decimal.",
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
      const currentAnalysis = analyses.get(fact.id);
      const fallbackCandidates =
        completeAnalysesByInstrument
          .get(fact.instrument_id)
          ?.filter(
            (candidate) => candidate.trading_date <= fact.trading_date,
          ) ?? [];
      const fallbackSummaryAnalysis = fallbackCandidates
        .filter((candidate) => candidate.summary_zh_cn !== null)
        .at(-1);
      const fallbackSourceAnalysis = fallbackCandidates
        .filter((candidate) => (sources.get(candidate.id)?.length ?? 0) > 0)
        .at(-1);
      const currentSources = currentAnalysis
        ? (sources.get(currentAnalysis.id) ?? [])
        : [];
      const summaryAnalysis =
        currentAnalysis?.summary_zh_cn !== null && currentAnalysis
          ? currentAnalysis
          : (fallbackSummaryAnalysis ?? currentAnalysis);
      const sourceAnalysis =
        currentAnalysis?.status === "complete"
          ? currentAnalysis
          : currentSources.length > 0
            ? currentAnalysis
            : (fallbackSourceAnalysis ??
              currentAnalysis ??
              fallbackSummaryAnalysis);
      const fallbackEvidence =
        fallbackSummaryAnalysis ?? fallbackSourceAnalysis;
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
        summaryZhCn: summaryAnalysis?.summary_zh_cn ?? null,
        analysisStatus: currentAnalysis?.status ?? "unavailable",
        sources: sourceAnalysis ? (sources.get(sourceAnalysis.id) ?? []) : [],
        freshness:
          fact.status !== "valid"
            ? fact.status
            : currentAnalysis?.status === "complete"
              ? "fresh"
              : currentAnalysis
                ? currentAnalysis.status
                : fallbackEvidence
                  ? "stale"
                  : "unavailable",
        conflicts: [
          ...(fact.status !== "valid"
            ? [
                {
                  code: fact.error_code ?? `market_fact_${fact.status}`,
                  message:
                    fact.error_message ??
                    `The market fact is ${fact.status}; values may be stale.`,
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
          ...(currentAnalysis?.status !== "complete"
            ? [
                {
                  code:
                    currentAnalysis?.error_code ??
                    (currentAnalysis
                      ? `movement_analysis_${currentAnalysis.status}`
                      : "movement_analysis_unavailable"),
                  message:
                    currentAnalysis?.error_message ??
                    (currentAnalysis
                      ? `The movement analysis is ${currentAnalysis.status}.`
                      : "No movement analysis is available."),
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
      const normalizedAmount = safeDecimal(event.amount_per_share_decimal);
      dividends.push({
        id: event.id,
        instrumentId: event.instrument_id,
        symbol: event.symbol,
        companyName: event.company_name,
        currency: event.currency,
        exDate: event.ex_date,
        paymentDate: event.payment_date,
        amountPerShareDecimal: normalizedAmount,
        heldQuantityDecimal,
        expectedTotalValueDecimal:
          eligible && normalizedAmount !== null
            ? multiplyDecimal(heldQuantityDecimal, normalizedAmount)
            : null,
        eligible,
        status: event.status,
        sourceUrl: safeSourceUrl(event.source_url),
        provider: event.provider,
      });
      if (event.status !== "active") {
        conflicts.push({
          code: event.error_code ?? `dividend_event_${event.status}`,
          message:
            event.error_message ?? `The dividend event is ${event.status}.`,
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

    const earnings: CalendarEarningsDto[] = [];
    for (const event of earningsResult.results) {
      const holdings = holdingsByInstrument.get(event.instrument_id);
      if (!holdings?.isEligibleForScreening(event.report_date)) continue;
      const estimate = safeDecimal(event.eps_estimate_decimal);
      earnings.push({
        id: event.id,
        instrumentId: event.instrument_id,
        symbol: event.symbol,
        companyName: event.company_name,
        reportDate: event.report_date,
        fiscalDateEnding: event.fiscal_date_ending,
        epsEstimateDecimal: estimate,
        currency: event.currency,
        timeOfDay: event.time_of_day,
        heldQuantityDecimal: holdings.quantityAtStartOfDay(event.report_date),
        status: event.status,
        provider: event.provider,
      });
      if (event.status === "stale") {
        conflicts.push({
          code: "earnings_event_stale",
          message: "The scheduled earnings date may have changed.",
          instrumentId: event.instrument_id,
          effectiveDate: event.report_date,
        });
      }
      if (event.eps_estimate_decimal !== null && estimate === null) {
        conflicts.push({
          code: "invalid_earnings_estimate",
          message: "The stored earnings estimate is not a valid decimal.",
          instrumentId: event.instrument_id,
          effectiveDate: event.report_date,
        });
      }
    }

    const pendingFactRows: CalendarPendingDto[] = [
      ...pendingFacts.results
        .filter(
          (row) =>
            row.instrument_id !== null &&
            row.effective_date !== null &&
            holdingsByInstrument
              .get(row.instrument_id)
              ?.isEligibleForScreening(row.effective_date),
        )
        .map((row) => ({
          kind: "market_fact" as const,
          instrumentId: row.instrument_id as string,
          symbol: row.symbol,
          date: row.effective_date as string,
          status: row.state,
          message: pendingMessage(row.state),
        })),
      ...legacyPendingFacts,
    ].filter(
      (row, index, rows) =>
        rows.findIndex(
          (candidate) =>
            candidate.kind === row.kind &&
            candidate.instrumentId === row.instrumentId &&
            candidate.date === row.date,
        ) === index,
    );
    const pending: CalendarPendingDto[] = [...pendingFactRows];
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
      ...earnings.map((event) => ({
        ...event,
        kind: "earnings" as const,
      })),
    ];
    const { events: selectedEvents, nextCursor } = paginateCalendarEvents({
      events: eventRows,
      ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    const selectedIds = new Set(
      selectedEvents.map((event) => `${event.kind}:${event.id}`),
    );
    const selectedMovers = movers.filter((mover) =>
      selectedIds.has(`mover:${mover.id}`),
    );
    const selectedEarnings = earnings.filter((event) =>
      selectedIds.has(`earnings:${event.id}`),
    );
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
      // Keep the period's complete dividend set available for totals and the
      // breakdown even when the mixed calendar event stream is paginated.
      dividends,
      earnings: selectedEarnings,
      events: selectedEvents,
      pending,
      pendingFacts: pendingFactRows,
      splitReview: splitPending,
      futureDividendStatus,
      earningsCoverageStatus:
        earningsCoverage?.status !== "current"
          ? (earningsCoverage?.status ?? "unavailable")
          : input.endDate < input.asOfDate ||
              (earningsCoverage.coverage_start_date !== null &&
                earningsCoverage.coverage_end_date !== null &&
                earningsCoverage.coverage_start_date <=
                  (input.startDate > input.asOfDate
                    ? input.startDate
                    : input.asOfDate) &&
                earningsCoverage.coverage_end_date >= input.endDate)
            ? "current"
            : "stale",
      conflicts,
      nextCursor,
    };
  }
}
