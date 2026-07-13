import { DecimalValue } from "../domain/decimal";
import { deriveHoldings } from "../domain/holdings";
import type {
  PortfolioConflictDto,
  PortfolioMovementDto,
  PortfolioPositionDto,
  PortfolioReadModelDto,
  ReadModelLocale,
  ReadModelSourceDto,
} from "../shared/contracts";

interface TransactionRow {
  instrument_id: string;
  account_id: string;
  trade_date: string;
  quantity_decimal: string;
  price_decimal: string;
  side: "buy" | "sell";
  id: string;
}

interface InstrumentRow {
  instrument_id: string;
  symbol: string;
  company_name: string;
  exchange: string;
  currency: "USD" | "CAD";
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
  daily_market_fact_id: string;
  summary_zh_cn: string | null;
  status: "pending" | "complete" | "stale" | "error";
  error_code: string | null;
  error_message: string | null;
}

interface CompleteAnalysisRow extends AnalysisRow {
  instrument_id: string;
  trading_date: string;
}

interface SourceRow {
  movement_analysis_id: string;
  title: string;
  publisher: string | null;
  published_at: string | null;
  source_url: string;
  cited: number;
}

interface CoverageRow {
  instrument_id: string;
  provider: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
}

interface ActionRow {
  instrument_id: string;
  effective_date: string;
  status: string;
  conflict_code: string | null;
  conflict_message: string | null;
}

export interface PortfolioReadModelInput {
  today: string;
  locale: ReadModelLocale;
  accountIds: readonly string[];
  limit?: number;
  cursor?: { symbol: string; instrumentId: string } | null;
}

const safeDecimal = (value: string | null): string | null => {
  if (value === null) return null;
  try {
    return DecimalValue.parse(value).toString();
  } catch {
    return null;
  }
};

const multiplyDecimal = (
  left: string | null,
  right: string | null,
): string | null => {
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

const qualifies = (value: string | null): boolean | null => {
  const normalized = safeDecimal(value);
  if (normalized === null) return null;
  try {
    const value = DecimalValue.parse(normalized);
    return (
      (value.isNegative() ? value.multiply("-1") : value).compare("5") >= 0
    );
  } catch {
    return null;
  }
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

const idChunks = (ids: readonly string[], size = 99): string[][] => {
  const chunks: string[][] = [];
  for (let index = 0; index < ids.length; index += size)
    chunks.push(ids.slice(index, index + size));
  return chunks;
};

const collectIdChunks = async <T>(
  ids: readonly string[],
  read: (chunk: string[]) => Promise<readonly T[]>,
  size = 99,
): Promise<T[]> => {
  const rows: T[] = [];
  for (const chunk of idChunks(ids, size)) rows.push(...(await read(chunk)));
  return rows;
};

const conflictForAction = (row: ActionRow): PortfolioConflictDto => ({
  code: row.conflict_code ?? `split_${row.status}`,
  message: row.conflict_message ?? `Corporate action is ${row.status}.`,
  instrumentId: row.instrument_id,
  effectiveDate: row.effective_date,
});

const conflictForCoverage = (row: CoverageRow): PortfolioConflictDto => ({
  code: row.error_code ?? `split_coverage_${row.status}`,
  message: row.error_message ?? `Split coverage is ${row.status}.`,
  instrumentId: row.instrument_id,
});

export class PortfolioReadModelService {
  constructor(private readonly db: D1Database) {}

  private latestFactsQuery(
    asOfDate: string,
    accountIds: readonly string[],
    validOnly: boolean,
  ): Promise<D1Result<FactRow>> {
    const candidateFilter = validOnly
      ? "AND candidate.status = 'valid' AND candidate.movement_basis <> 'legacy_migration'"
      : "";
    return this.db
      .prepare(
        `WITH scoped_transactions AS (
           SELECT t.* FROM transactions t
            WHERE t.account_id IN (SELECT value FROM json_each(?1))
         ),
         held_instruments AS (
           SELECT DISTINCT instrument_id FROM scoped_transactions
         ),
         latest_dates AS (
           SELECT held.instrument_id,
                  (
                    SELECT candidate.trading_date
                      FROM daily_market_facts candidate
                     WHERE candidate.instrument_id = held.instrument_id
                       AND candidate.trading_date <= ?2
                       ${candidateFilter}
                     ORDER BY candidate.trading_date DESC
                     LIMIT 1
                  ) AS trading_date
             FROM held_instruments held
         )
         SELECT f.id, f.instrument_id, f.trading_date, f.previous_trading_date,
                f.previous_raw_close_decimal, f.current_raw_close_decimal,
                f.split_adjusted_previous_close_decimal,
                f.movement_amount_decimal, f.movement_percent_decimal,
                f.raw_close_difference_decimal, f.movement_basis, f.status,
                f.error_code, f.error_message
           FROM latest_dates latest
           JOIN daily_market_facts f
             ON f.instrument_id = latest.instrument_id
            AND f.trading_date = latest.trading_date
         ORDER BY f.instrument_id`,
      )
      .bind(JSON.stringify(accountIds), asOfDate)
      .all<FactRow>();
  }

  async read(input: PortfolioReadModelInput): Promise<PortfolioReadModelDto> {
    const [
      transactionResult,
      instrumentResult,
      splitResult,
      latestFactResult,
      validFactResult,
    ] = await Promise.all([
      this.db
        .prepare(
          `SELECT id, instrument_id, trade_date, side,
                    quantity_decimal, price_decimal, account_id
             FROM transactions
            WHERE account_id IN (SELECT value FROM json_each(?1))
             ORDER BY instrument_id, trade_date, id`,
        )
        .bind(JSON.stringify(input.accountIds))
        .all<TransactionRow>(),
      this.db
        .prepare(
          `SELECT DISTINCT i.id AS instrument_id, i.symbol, i.company_name,
                    i.exchange, i.currency
             FROM instruments i JOIN transactions t ON t.instrument_id = i.id
            WHERE t.account_id IN (SELECT value FROM json_each(?1))
             ORDER BY i.symbol, i.id`,
        )
        .bind(JSON.stringify(input.accountIds))
        .all<InstrumentRow>(),
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
      this.latestFactsQuery(input.today, input.accountIds, false),
      this.latestFactsQuery(input.today, input.accountIds, true),
    ]);

    const transactionsByInstrument = new Map<string, TransactionRow[]>();
    for (const row of transactionResult.results) {
      const rows = transactionsByInstrument.get(row.instrument_id) ?? [];
      rows.push(row);
      transactionsByInstrument.set(row.instrument_id, rows);
    }
    const splitsByInstrument = new Map<string, SplitRow[]>();
    for (const row of splitResult.results) {
      const rows = splitsByInstrument.get(row.instrument_id) ?? [];
      rows.push(row);
      splitsByInstrument.set(row.instrument_id, rows);
    }

    const latestFacts = new Map(
      latestFactResult.results.map((row) => [row.instrument_id, row]),
    );
    const validFacts = new Map(
      validFactResult.results.map((row) => [row.instrument_id, row]),
    );
    const usableFacts = new Map<string, FactRow>();
    for (const [instrumentId, latest] of latestFacts) {
      if (latest.movement_basis === "legacy_migration") {
        continue;
      }
      if (latest.status === "valid") {
        usableFacts.set(instrumentId, latest);
      } else {
        const valid = validFacts.get(instrumentId);
        if (valid) {
          usableFacts.set(instrumentId, valid);
        } else {
          usableFacts.set(instrumentId, latest);
        }
      }
    }
    const factIds = [
      ...new Set(
        [...latestFacts.values(), ...usableFacts.values()].map(
          (fact) => fact.id,
        ),
      ),
    ];
    const analyses = new Map<string, AnalysisRow>();
    const completeAnalysesByInstrument = new Map<
      string,
      CompleteAnalysisRow[]
    >();
    const sources = new Map<string, ReadModelSourceDto[]>();
    if (factIds.length > 0) {
      const analysisRows = await collectIdChunks(
        factIds,
        async (chunk) =>
          (
            await this.db
              .prepare(
                `SELECT daily_market_fact_id, summary_zh_cn, status,
                      error_code, error_message
               FROM movement_analyses
               WHERE daily_market_fact_id IN (${chunk.map((_id, index) => `?${index + 1}`).join(", ")})`,
              )
              .bind(...chunk)
              .all<AnalysisRow>()
          ).results,
      );
      for (const row of analysisRows)
        analyses.set(row.daily_market_fact_id, row);
      const instrumentIdsWithFacts = [...usableFacts.keys()];
      const completeRows = (
        await this.db
          .prepare(
            `SELECT f.instrument_id, f.trading_date, a.daily_market_fact_id,
                    a.summary_zh_cn, a.status, a.error_code, a.error_message
             FROM movement_analyses a
             JOIN daily_market_facts f ON f.id = a.daily_market_fact_id
             WHERE a.status = 'complete'
               AND f.instrument_id IN (SELECT value FROM json_each(?1))
               AND f.movement_basis <> 'legacy_migration'
               AND f.trading_date <= ?2
               AND (
                 f.trading_date = (
                   SELECT MAX(previous_fact.trading_date)
                   FROM daily_market_facts previous_fact
                   JOIN movement_analyses previous_analysis
                     ON previous_analysis.daily_market_fact_id = previous_fact.id
                   WHERE previous_fact.instrument_id = f.instrument_id
                     AND previous_fact.movement_basis <> 'legacy_migration'
                     AND previous_fact.trading_date <= ?2
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
                     AND previous_fact.trading_date <= ?2
                     AND previous_analysis.status = 'complete'
                     AND EXISTS (
                       SELECT 1 FROM news_sources previous_source
                       WHERE previous_source.movement_analysis_id = previous_analysis.id
                     )
                 )
               )
             ORDER BY f.instrument_id, f.trading_date`,
          )
          .bind(JSON.stringify(instrumentIdsWithFacts), input.today)
          .all<CompleteAnalysisRow>()
      ).results;
      for (const row of completeRows) {
        const rows = completeAnalysesByInstrument.get(row.instrument_id) ?? [];
        rows.push(row);
        completeAnalysesByInstrument.set(row.instrument_id, rows);
      }
      const analysisIds = [
        ...new Set([
          ...analysisRows.map((row) => row.daily_market_fact_id),
          ...completeRows.map((row) => row.daily_market_fact_id),
        ]),
      ];
      if (analysisIds.length > 0) {
        const sourceRows = await collectIdChunks(
          analysisIds,
          async (chunk) =>
            (
              await this.db
                .prepare(
                  `SELECT a.daily_market_fact_id AS movement_analysis_id,
                        s.title, s.publisher, s.published_at, s.source_url, s.cited
                 FROM movement_analyses a JOIN news_sources s
                   ON s.movement_analysis_id = a.id
                 WHERE a.daily_market_fact_id IN (${chunk.map((_id, index) => `?${index + 1}`).join(", ")})
                 ORDER BY a.daily_market_fact_id, s.source_order`,
                )
                .bind(...chunk)
                .all<SourceRow>()
            ).results,
        );
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

    const instrumentIds = instrumentResult.results.map(
      (row) => row.instrument_id,
    );
    const coverageRows = await collectIdChunks(
      instrumentIds,
      async (chunk) =>
        (
          await this.db
            .prepare(
              `SELECT instrument_id, provider, status, error_code, error_message
             FROM corporate_action_coverage
             WHERE instrument_id IN (${chunk.map((_id, index) => `?${index + 1}`).join(", ")})
               AND status <> 'confirmed'`,
            )
            .bind(...chunk)
            .all<CoverageRow>()
        ).results,
    );
    const actionRows = await collectIdChunks(
      instrumentIds,
      async (chunk) =>
        (
          await this.db
            .prepare(
              `SELECT instrument_id, effective_date, status,
                    conflict_code, conflict_message
             FROM corporate_actions
             WHERE instrument_id IN (${chunk.map((_id, index) => `?${index + 1}`).join(", ")})
               AND status IN ('candidate', 'quarantined')`,
            )
            .bind(...chunk)
            .all<ActionRow>()
        ).results,
    );
    const conflictsByInstrument = new Map<string, PortfolioConflictDto[]>();
    for (const row of coverageRows) {
      const list = conflictsByInstrument.get(row.instrument_id) ?? [];
      list.push(conflictForCoverage(row));
      conflictsByInstrument.set(row.instrument_id, list);
    }
    for (const row of actionRows) {
      const list = conflictsByInstrument.get(row.instrument_id) ?? [];
      list.push(conflictForAction(row));
      conflictsByInstrument.set(row.instrument_id, list);
    }

    const positions: PortfolioPositionDto[] = [];
    const orphanConflicts: PortfolioConflictDto[] = [];
    for (const instrument of instrumentResult.results) {
      const transactions =
        transactionsByInstrument.get(instrument.instrument_id) ?? [];
      const splits = splitsByInstrument.get(instrument.instrument_id) ?? [];
      const conflicts = [
        ...(conflictsByInstrument.get(instrument.instrument_id) ?? []),
      ];
      let quantityDecimal: string;
      try {
        quantityDecimal = deriveHoldings({
          today: input.today,
          transactions: transactions.map((row) => ({
            id: row.id,
            tradeDate: row.trade_date,
            side: row.side,
            quantityDecimal: row.quantity_decimal,
          })),
          activeSplits: splits.map((row) => ({
            id: row.id,
            effectiveDate: row.effective_date,
            numerator: row.split_numerator,
            denominator: row.split_denominator,
          })),
        }).currentQuantity();
      } catch (error) {
        quantityDecimal = "0";
        const conflict = {
          code: "holding_derivation_error",
          message: String(error).slice(0, 200),
          instrumentId: instrument.instrument_id,
        } satisfies PortfolioConflictDto;
        conflicts.push(conflict);
        orphanConflicts.push(conflict);
      }
      if (safeDecimal(quantityDecimal) === "0") continue;
      const latestFact = latestFacts.get(instrument.instrument_id);
      const fact = usableFacts.get(instrument.instrument_id);
      const currentAnalysis = latestFact
        ? analyses.get(latestFact.id)
        : undefined;
      const fallbackCandidates =
        completeAnalysesByInstrument.get(instrument.instrument_id) ?? [];
      const fallbackSummaryAnalysis = fallbackCandidates
        .filter((candidate) => candidate.summary_zh_cn !== null)
        .at(-1);
      const fallbackSourceAnalysis = fallbackCandidates
        .filter(
          (candidate) =>
            (sources.get(candidate.daily_market_fact_id)?.length ?? 0) > 0,
        )
        .at(-1);
      const currentSources = currentAnalysis
        ? (sources.get(currentAnalysis.daily_market_fact_id) ?? [])
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
      const analysisStatus = currentAnalysis?.status
        ? currentAnalysis.status
        : fact
          ? "unavailable"
          : null;
      const movementPercent = fact
        ? safeDecimal(fact.movement_percent_decimal)
        : null;
      const qualified = fact ? qualifies(movementPercent) : null;
      const movement: PortfolioMovementDto | null = fact
        ? {
            tradingDate: fact.trading_date,
            previousTradingDate: fact.previous_trading_date,
            previousRawCloseDecimal: safeDecimal(
              fact.previous_raw_close_decimal,
            ),
            currentRawCloseDecimal: safeDecimal(fact.current_raw_close_decimal),
            movementAmountDecimal: safeDecimal(fact.movement_amount_decimal),
            movementPercentDecimal: movementPercent,
            rawCloseDifferenceDecimal: safeDecimal(
              fact.raw_close_difference_decimal,
            ),
            basis: fact.movement_basis,
            qualified,
          }
        : null;
      if (latestFact && latestFact.status !== "valid") {
        conflicts.push({
          code: latestFact.error_code ?? `market_fact_${latestFact.status}`,
          message:
            latestFact.error_message ??
            "The latest market fact is not valid; showing the last valid value.",
          instrumentId: instrument.instrument_id,
          effectiveDate: latestFact.trading_date,
        });
      }
      if (
        latestFact &&
        latestFact.status === "valid" &&
        movementPercent === null
      ) {
        conflicts.push({
          code: "invalid_movement_decimal",
          message: "The stored movement percentage is not a valid decimal.",
          instrumentId: instrument.instrument_id,
          effectiveDate: latestFact.trading_date,
        });
      }
      if (
        latestFact &&
        safeDecimal(latestFact.current_raw_close_decimal) === null
      ) {
        conflicts.push({
          code: "invalid_close_decimal",
          message: "The stored close is not a valid decimal.",
          instrumentId: instrument.instrument_id,
          effectiveDate: latestFact.trading_date,
        });
      }
      if (latestFact?.movement_basis === "legacy_migration") {
        conflicts.push({
          code: "legacy_movement_basis",
          message:
            "The latest market fact uses a legacy basis and is awaiting normalized refresh.",
          instrumentId: instrument.instrument_id,
          effectiveDate: latestFact.trading_date,
        });
      }
      if (
        fact &&
        qualified === true &&
        currentAnalysis?.status !== "complete"
      ) {
        conflicts.push({
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
          instrumentId: instrument.instrument_id,
          effectiveDate: fact.trading_date,
        });
      }
      const summary =
        fact && qualified === true
          ? (summaryAnalysis?.summary_zh_cn ?? null)
          : null;
      const valuation =
        fact && fact.movement_basis !== "legacy_migration"
          ? multiplyDecimal(quantityDecimal, fact.current_raw_close_decimal)
          : null;
      const marketFreshness = latestFact
        ? latestFact.status === "valid"
          ? "fresh"
          : latestFact.status
        : "unavailable";
      const freshness =
        latestFact?.movement_basis === "legacy_migration"
          ? "pending"
          : marketFreshness === "fresh" && qualified === true
            ? currentAnalysis?.status === "complete"
              ? "fresh"
              : currentAnalysis
                ? currentAnalysis.status
                : fallbackEvidence
                  ? "stale"
                  : "unavailable"
            : marketFreshness;
      const position: PortfolioPositionDto = {
        instrumentId: instrument.instrument_id,
        symbol: instrument.symbol,
        companyName: instrument.company_name,
        exchange: instrument.exchange,
        currency: instrument.currency,
        quantityDecimal,
        valuationDecimal: valuation,
        latestTradingDate: latestFact?.trading_date ?? null,
        currentRawCloseDecimal:
          fact && fact.movement_basis !== "legacy_migration"
            ? safeDecimal(fact.current_raw_close_decimal)
            : null,
        movement,
        summaryZhCn: summary,
        analysisStatus,
        sources:
          fact && qualified === true && sourceAnalysis
            ? (sources.get(sourceAnalysis.daily_market_fact_id) ?? [])
            : [],
        freshness,
        conflicts,
      };
      positions.push(position);
    }
    positions.sort(
      (left, right) =>
        left.symbol.localeCompare(right.symbol) ||
        left.instrumentId.localeCompare(right.instrumentId),
    );
    const cursor = input.cursor;
    const startIndex = cursor
      ? positions.findIndex(
          (position) =>
            position.symbol > cursor.symbol ||
            (position.symbol === cursor.symbol &&
              position.instrumentId > cursor.instrumentId),
        )
      : 0;
    const offset = startIndex < 0 ? positions.length : startIndex;
    const limit = Math.min(Math.max(input.limit ?? 100, 1), 100);
    const selected = positions.slice(offset, offset + limit);
    const last = selected.at(-1);
    const nextCursor =
      last && offset + selected.length < positions.length
        ? btoa(
            JSON.stringify({
              symbol: last.symbol,
              instrumentId: last.instrumentId,
            }),
          )
        : null;
    const totals: Record<"USD" | "CAD", string> = { USD: "0", CAD: "0" };
    for (const position of positions) {
      if (position.valuationDecimal !== null) {
        totals[position.currency] = DecimalValue.parse(
          totals[position.currency],
        )
          .add(position.valuationDecimal)
          .toString();
      }
    }
    const allConflicts = [
      ...orphanConflicts,
      ...positions.flatMap((position) => position.conflicts),
    ];
    const actualTradingDates = [
      ...new Set(latestFactResult.results.map((row) => row.trading_date)),
    ].sort();
    const freshness = positions.some(
      (position) => position.freshness === "error",
    )
      ? "error"
      : positions.some((position) => position.freshness === "stale")
        ? "stale"
        : positions.some((position) => position.freshness === "pending")
          ? "pending"
          : positions.some((position) => position.freshness === "unavailable")
            ? "unavailable"
            : "fresh";
    return {
      asOfDate: input.today,
      actualTradingDates,
      latestTradingDate:
        positions
          .map((position) => position.latestTradingDate)
          .filter((date): date is string => date !== null)
          .sort()
          .at(-1) ?? null,
      locale: input.locale,
      positions: selected,
      totals,
      conflicts: allConflicts,
      freshness,
      nextCursor,
    };
  }
}
