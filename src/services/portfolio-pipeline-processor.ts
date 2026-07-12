import type { CorporateActionRecord } from "../db/corporate-actions";
import { CorporateActionRepository } from "../db/corporate-actions";
import type { DispatchBatchRecord } from "../db/dispatch-batches";
import { InstrumentRepository } from "../db/instruments";
import type { DailyMarketFactRecord } from "../db/market-facts";
import type { WorkItemRecord } from "../db/work-items";
import { DecimalValue } from "../domain/decimal";
import type { ExplanationProvider } from "../providers/explanations";
import type { MarketDataProvider } from "../providers/market-data";
import type { NewsProvider } from "../providers/news";
import { YahooMarketDataProvider } from "../providers/yahoo";
import { easternCloseUtc, easternMarketDate } from "../shared/dates";
import type {
  PipelineWorkOutcome,
  PipelineWorkProcessor,
} from "../worker/pipeline-queue";
import {
  AnalysisFactsService,
  MarketFactsPersistenceService,
} from "./fact-persistence";
import { type MarketFactsResult, MarketFactsService } from "./market-facts";

interface FactRow extends DailyMarketFactRecord {
  symbol: string;
  companyName: string;
}

export interface PortfolioPipelineProcessorDependencies {
  db: D1Database;
  marketDataProvider?: MarketDataProvider;
  newsProvider: NewsProvider;
  explanationProvider: ExplanationProvider;
  now?: () => Date;
  newId?: () => string;
}

const transientCode = (value: string): boolean =>
  /(?:429|5\d\d|timeout|timed[_-]?out|network|fetch[ _-]?failed|connection|econn|socket|dns|abort|unavailable|rate[_-]?limit)/i.test(
    value,
  );

const errorCode = (error: unknown, fallback: string): string => {
  const value = error instanceof Error ? error.message : String(error);
  return value.trim().slice(0, 120) || fallback;
};

const isQualified = (value: string | null): boolean => {
  if (!value) return false;
  try {
    const decimal = DecimalValue.parse(value);
    return (
      (decimal.isNegative() ? decimal.multiply("-1") : decimal).compare("5") >=
      0
    );
  } catch {
    return false;
  }
};

const toActiveSplits = (actions: readonly CorporateActionRecord[]) =>
  actions
    .filter((action) => action.status === "active")
    .map((action) => ({
      id: action.id,
      effectiveDate: action.effectiveDate,
      numerator: action.splitNumerator,
      denominator: action.splitDenominator,
    }));

const outcomeForItems = (
  work: readonly WorkItemRecord[],
  byDate: ReadonlyMap<string, { revision: string }>,
  errors: ReadonlyMap<string, { code: string }>,
  rangeError?: { code: string },
  missingErrorCode: (date: string) => string = () => "provider_partial_range",
): PipelineWorkOutcome[] =>
  work.map((item) => {
    const date = item.effectiveDate ?? "";
    const fact = byDate.get(date);
    if (fact) {
      return {
        workItemId: item.id,
        kind: "complete" as const,
        resultRevision: fact.revision,
      };
    }
    const error = errors.get(date) ?? rangeError;
    if (error) {
      return {
        workItemId: item.id,
        kind: transientCode(error.code)
          ? ("retry" as const)
          : ("terminal" as const),
        errorCode: error.code,
        errorMessage: `Market data processing failed for ${date}.`,
      };
    }
    const missingCode = missingErrorCode(date);
    return {
      workItemId: item.id,
      kind:
        missingCode === "provider_partial_range" ||
        missingCode === "market_bar_pending" ||
        transientCode(missingCode)
          ? ("retry" as const)
          : ("terminal" as const),
      errorCode: missingCode,
      errorMessage: `No market bar was returned for ${date}.`,
    };
  });

export class PortfolioPipelineProcessor implements PipelineWorkProcessor {
  private readonly instruments: InstrumentRepository;
  private readonly actions: CorporateActionRepository;
  private readonly market: MarketDataProvider;
  private readonly facts: MarketFactsPersistenceService;
  private readonly analyses: AnalysisFactsService;
  private readonly now: () => Date;

  constructor(
    private readonly dependencies: PortfolioPipelineProcessorDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.instruments = new InstrumentRepository(dependencies.db);
    this.actions = new CorporateActionRepository(dependencies.db);
    this.market =
      dependencies.marketDataProvider ?? new YahooMarketDataProvider();
    this.facts = new MarketFactsPersistenceService(dependencies.db, this.now);
    const analysisDependencies = {
      db: dependencies.db,
      newsProvider: dependencies.newsProvider,
      explanationProvider: dependencies.explanationProvider,
      now: this.now,
      ...(dependencies.newId === undefined
        ? {}
        : { newId: dependencies.newId }),
    };
    this.analyses = new AnalysisFactsService(analysisDependencies);
  }

  /**
   * Historical backfills must invalidate their month bucket without making
   * that historical date look like today's latest close. The batch only
   * carries its requested range, so preserve the newest valid fact already in
   * D1 and advance it only when this batch returns a newer valid fact.
   */
  private async latestTradingDateFor(
    candidateDates: readonly string[],
  ): Promise<string | undefined> {
    const row = await this.dependencies.db
      .prepare(
        `SELECT MAX(trading_date) AS latestTradingDate
           FROM daily_market_facts
          WHERE status = 'valid'`,
      )
      .first<{ latestTradingDate: string | null }>();
    const dates = [row?.latestTradingDate, ...candidateDates].filter(
      (date): date is string => date !== null && date !== undefined,
    );
    return dates.sort().at(-1);
  }

  async process(input: {
    batch: DispatchBatchRecord;
    work: readonly WorkItemRecord[];
  }): Promise<readonly PipelineWorkOutcome[]> {
    const groups = new Map<string, WorkItemRecord[]>();
    for (const item of input.work) {
      const list = groups.get(item.workType) ?? [];
      list.push(item);
      groups.set(item.workType, list);
    }
    const outcomes: PipelineWorkOutcome[] = [];
    for (const [workType, work] of groups) {
      if (workType === "market_fact") {
        outcomes.push(...(await this.processMarketFact({ ...input, work })));
      } else if (workType === "analysis") {
        outcomes.push(...(await this.processAnalysis({ ...input, work })));
      } else {
        outcomes.push(
          ...work.map((item) => ({
            workItemId: item.id,
            kind: "terminal" as const,
            errorCode: "unsupported_work_type",
            errorMessage: `No processor is configured for ${workType}.`,
          })),
        );
      }
    }
    return outcomes;
  }

  async processMarketFact(input: {
    batch: DispatchBatchRecord;
    work: readonly WorkItemRecord[];
  }): Promise<readonly PipelineWorkOutcome[]> {
    const instrumentId = input.batch.instrumentId;
    const instrument = await this.instruments.findById(instrumentId);
    if (!instrument) {
      return input.work.map((item) => ({
        workItemId: item.id,
        kind: "terminal" as const,
        errorCode: "instrument_not_found",
        errorMessage: "The normalized instrument no longer exists.",
      }));
    }
    const actions = await this.actions.listForInstrument(instrumentId);
    const timestamp = this.now().toISOString();
    const providerRevision = `yahoo:${input.batch.createdAt}`;
    let result: MarketFactsResult;
    try {
      result = await new MarketFactsService(
        this.market,
        this.now,
      ).normalizeResult({
        instrumentId,
        symbol: instrument.providerSymbol,
        startDate: input.batch.requestedStartDate,
        endDate: input.batch.requestedEndDate,
        provider: "yahoo",
        providerRevision,
        activeSplits: toActiveSplits(actions),
        retrievedAt: timestamp,
      });
    } catch (error) {
      const code = errorCode(error, "market_provider_unavailable");
      return input.work.map((item) => ({
        workItemId: item.id,
        kind: transientCode(code) ? ("retry" as const) : ("terminal" as const),
        errorCode: code,
        errorMessage: "The market provider did not return a usable range.",
      }));
    }
    try {
      const latestTradingDate = await this.latestTradingDateFor(
        result.facts.map((fact) => fact.tradingDate),
      );
      await this.facts.persistResult({
        facts: result.facts,
        // A range-level provider error has no safe trading-date scope. Do
        // not let one failed fetch rewrite every previously valid fact for
        // this instrument; the outcome below carries the retry/terminal
        // decision while existing rows remain readable.
        errors: result.errors.filter((error) => error.tradingDate !== null),
        ...(latestTradingDate === undefined ? {} : { latestTradingDate }),
      });
    } catch (error) {
      const code = errorCode(error, "fact_persistence_error");
      return input.work.map((item) => ({
        workItemId: item.id,
        kind: "retry" as const,
        errorCode: code,
        errorMessage: "Normalized market facts could not be persisted.",
      }));
    }
    const facts = new Map(
      result.facts.map((fact) => [
        fact.tradingDate,
        { revision: fact.providerRevision },
      ]),
    );
    const errors = new Map(
      result.errors
        .filter((error) => error.tradingDate !== null)
        .map((error) => [
          error.tradingDate as string,
          { code: error.errorCode },
        ]),
    );
    const rangeError = result.errors.find(
      (error) => error.tradingDate === null,
    );
    const currentDate = easternMarketDate(this.now());
    return outcomeForItems(
      input.work,
      facts,
      errors,
      rangeError ? { code: rangeError.errorCode } : undefined,
      (date) =>
        date === input.batch.requestedEndDate && date === currentDate
          ? "market_bar_pending"
          : "market_bar_missing",
    );
  }

  async processAnalysis(input: {
    batch: DispatchBatchRecord;
    work: readonly WorkItemRecord[];
  }): Promise<readonly PipelineWorkOutcome[]> {
    const instrument = await this.instruments.findById(
      input.batch.instrumentId,
    );
    if (!instrument) {
      return input.work.map((item) => ({
        workItemId: item.id,
        kind: "terminal" as const,
        errorCode: "instrument_not_found",
        errorMessage: "The normalized instrument no longer exists.",
      }));
    }
    const dates = input.work
      .map((item) => item.effectiveDate)
      .filter((date): date is string => date !== null);
    if (dates.length === 0) return [];
    const placeholders = dates
      .map((_date, index) => `?${index + 2}`)
      .join(", ");
    const rows = await this.dependencies.db
      .prepare(
        `SELECT f.id, f.instrument_id AS instrumentId,
                f.trading_date AS tradingDate,
                f.previous_trading_date AS previousTradingDate,
                f.previous_raw_close_decimal AS previousRawCloseDecimal,
                f.current_raw_close_decimal AS currentRawCloseDecimal,
                f.crossing_split_numerator AS crossingSplitNumerator,
                f.crossing_split_denominator AS crossingSplitDenominator,
                f.split_adjusted_previous_close_decimal AS splitAdjustedPreviousCloseDecimal,
                f.movement_amount_decimal AS movementAmountDecimal,
                f.movement_percent_decimal AS movementPercentDecimal,
                f.raw_close_difference_decimal AS rawCloseDifferenceDecimal,
                f.movement_basis AS movementBasis,
                f.provider, f.provider_revision AS providerRevision,
                f.retrieved_at AS retrievedAt, f.status,
                f.error_code AS errorCode, f.error_message AS errorMessage,
                f.created_at AS createdAt, f.updated_at AS updatedAt,
                i.symbol, i.company_name AS companyName
           FROM daily_market_facts f
           JOIN instruments i ON i.id = f.instrument_id
          WHERE f.instrument_id = ?1 AND f.trading_date IN (${placeholders})`,
      )
      .bind(input.batch.instrumentId, ...dates)
      .all<FactRow>();
    const byDate = new Map(rows.results.map((row) => [row.tradingDate, row]));
    const latestTradingDate = await this.latestTradingDateFor(
      rows.results.map((row) => row.tradingDate),
    );
    const outcomes: PipelineWorkOutcome[] = [];
    for (const item of input.work) {
      const date = item.effectiveDate ?? "";
      const fact = byDate.get(date);
      if (!fact) {
        outcomes.push({
          workItemId: item.id,
          kind: "retry",
          errorCode: "market_fact_missing",
          errorMessage: `The market fact for ${date} is not persisted yet.`,
        });
        continue;
      }
      if (fact.status !== "valid") {
        outcomes.push({
          workItemId: item.id,
          kind: "retry",
          errorCode: "market_fact_not_ready",
          errorMessage: `The market fact for ${date} is not valid yet.`,
        });
        continue;
      }
      if (!isQualified(fact.movementPercentDecimal)) {
        outcomes.push({ workItemId: item.id, kind: "complete" });
        continue;
      }
      if (fact.movementBasis !== "split_adjusted_price_return") {
        outcomes.push({ workItemId: item.id, kind: "complete" });
        continue;
      }
      const refresh = await this.analyses.refresh({
        fact: {
          ...fact,
          movementBasis: "split_adjusted_price_return",
          freshness: "fresh",
          status: "valid",
          errorCode: null,
          errorMessage: null,
        },
        symbol: fact.symbol,
        companyName: fact.companyName,
        publishedAfter: easternCloseUtc(fact.previousTradingDate ?? date),
        publishedBefore: new Date(
          Date.parse(easternCloseUtc(date)) + 2 * 3_600_000,
        ).toISOString(),
        ...(latestTradingDate === undefined ? {} : { latestTradingDate }),
      });
      if (refresh.kind === "refreshed" || refresh.kind === "reused") {
        outcomes.push({
          workItemId: item.id,
          kind: "complete",
          resultRevision: refresh.analysis.dependencyFingerprint,
        });
      } else {
        outcomes.push({
          workItemId: item.id,
          kind: transientCode(refresh.code)
            ? ("retry" as const)
            : ("terminal" as const),
          errorCode: refresh.code,
          errorMessage: "The movement analysis could not be refreshed.",
        });
      }
    }
    return outcomes;
  }
}
