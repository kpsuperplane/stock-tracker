import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type { DispatchBatchRecord } from "../../src/db/dispatch-batches";
import type { WorkItemRecord } from "../../src/db/work-items";
import type { ExplanationProvider } from "../../src/providers/explanations";
import type { MarketDataProvider } from "../../src/providers/market-data";
import type { NewsProvider } from "../../src/providers/news";
import { PortfolioPipelineProcessor } from "../../src/services/portfolio-pipeline-processor";

const now = "2026-07-10T22:00:00.000Z";

interface D1Usage {
  rowsRead: number;
  rowsWritten: number;
}

const addUsage = (usage: D1Usage, result: unknown): void => {
  if (!result || typeof result !== "object" || !("meta" in result)) return;
  const meta = (result as { meta?: D1Result["meta"] }).meta;
  usage.rowsRead += meta?.rows_read ?? 0;
  usage.rowsWritten += meta?.rows_written ?? 0;
};

const traceStatement = (
  statement: D1PreparedStatement,
  usage: D1Usage,
): D1PreparedStatement =>
  new Proxy(statement, {
    get(source, property, receiver) {
      if (property === "bind") {
        return (...values: unknown[]) =>
          traceStatement(source.bind(...values), usage);
      }
      if (property === "all" || property === "first" || property === "run") {
        return async (...values: unknown[]) => {
          const method = Reflect.get(source, property) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          const result = await Reflect.apply(method, source, values);
          addUsage(usage, result);
          return result;
        };
      }
      return Reflect.get(source, property, receiver);
    },
  });

const traceDatabase = (database: D1Database, usage: D1Usage): D1Database =>
  new Proxy(database, {
    get(source, property, receiver) {
      if (property === "prepare") {
        return (query: string) => traceStatement(source.prepare(query), usage);
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await source.batch(statements);
          for (const result of results) addUsage(usage, result);
          return results;
        };
      }
      return Reflect.get(source, property, receiver);
    },
  });

const insertInstrument = async (id = "instrument-1"): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO instruments
     (id, symbol, company_name, exchange, currency, instrument_type,
      provider, provider_symbol, created_at, updated_at)
     VALUES (?1, ?2, 'Processor Corp', 'NYSE', 'USD', 'stock',
             'yahoo', ?2, ?3, ?3)`,
  )
    .bind(id, `PROC-${id}`, now)
    .run();
};

const batch = (
  overrides: Partial<DispatchBatchRecord> = {},
): DispatchBatchRecord => ({
  id: "batch-1",
  workType: "market_fact",
  instrumentId: "instrument-1",
  requestedStartDate: "2026-07-09",
  requestedEndDate: "2026-07-10",
  state: "processing",
  dispatchLeaseUntil: null,
  processingLeaseUntil: "2026-07-10T22:10:00.000Z",
  attemptCount: 1,
  maxAttempts: 3,
  terminalErrorCode: null,
  terminalErrorMessage: null,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
  retentionUntil: null,
  ...overrides,
});

const work = (
  id: string,
  workType: WorkItemRecord["workType"],
  effectiveDate: string,
  overrides: Partial<WorkItemRecord> = {},
): WorkItemRecord => ({
  id,
  scope: "global_fact",
  pipelineJobId: null,
  workType,
  instrumentId: "instrument-1",
  effectiveDate,
  dependencyRevision: "market-r1",
  forcedRefreshGeneration: null,
  deterministicKey: JSON.stringify([
    "fact",
    workType,
    "instrument-1",
    effectiveDate,
    "market-r1",
    0,
  ]),
  state: "processing",
  priority: 100,
  attemptCount: 1,
  maxAttempts: 3,
  dispatchLeaseUntil: null,
  processingLeaseUntil: "2026-07-10T22:10:00.000Z",
  resultRevision: null,
  terminalErrorCode: null,
  terminalErrorMessage: null,
  availableAt: now,
  retentionUntil: null,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
  ...overrides,
});

const marketProvider = (
  calls: Array<[string, string, string]>,
): MarketDataProvider => ({
  getInstrument: vi.fn(async (symbol, startDate, endDate) => {
    calls.push([symbol, startDate, endDate]);
    return {
      metadata: {
        symbol,
        companyName: "Processor Corp",
        exchange: "NYSE",
        currency: "USD",
        instrumentType: "EQUITY" as const,
      },
      bars: [
        { date: "2026-07-08", close: 100, adjustedClose: 100 },
        { date: "2026-07-09", close: 102, adjustedClose: 102 },
        { date: "2026-07-10", close: 112.2, adjustedClose: 112.2 },
      ],
      corporateActionDates: new Set<string>(),
    };
  }),
});

const newsProvider = (search: NewsProvider["search"]): NewsProvider => ({
  search: vi.fn(search),
});

const explanationProvider = (
  explain: ExplanationProvider["explain"],
): ExplanationProvider => ({ explain: vi.fn(explain) });

const weekdays = (start: string, end: string): string[] => {
  const dates: string[] = [];
  for (
    let cursor = new Date(`${start}T12:00:00.000Z`);
    cursor <= new Date(`${end}T12:00:00.000Z`);
    cursor = new Date(cursor.valueOf() + 86_400_000)
  ) {
    if (![0, 6].includes(cursor.getUTCDay())) {
      dates.push(cursor.toISOString().slice(0, 10));
    }
  }
  return dates;
};

describe("normalized portfolio pipeline processor", () => {
  it("fetches one lookback range and persists normalized facts for each work item", async () => {
    await insertInstrument();
    const calls: Array<[string, string, string]> = [];
    const usage: D1Usage = { rowsRead: 0, rowsWritten: 0 };
    const processor = new PortfolioPipelineProcessor({
      db: traceDatabase(env.DB, usage),
      marketDataProvider: marketProvider(calls),
      newsProvider: newsProvider(async () => []),
      explanationProvider: explanationProvider(async () => ({
        explanationZhCn: "不会被调用。",
        model: "test",
      })),
      now: () => new Date(now),
      newId: () => "unused",
    });

    const outcomes = await processor.processMarketFact({
      batch: batch(),
      work: [
        work("fact-2026-07-09", "market_fact", "2026-07-09"),
        work("fact-2026-07-10", "market_fact", "2026-07-10"),
      ],
    });

    expect(calls).toEqual([["PROC-instrument-1", "2026-07-02", "2026-07-10"]]);
    expect(usage.rowsRead).toBeLessThanOrEqual(10_000);
    expect(usage.rowsWritten).toBeLessThanOrEqual(250);
    expect(outcomes).toEqual([
      {
        workItemId: "fact-2026-07-09",
        kind: "complete",
        resultRevision: "yahoo:2026-07-10T22:00:00.000Z",
      },
      {
        workItemId: "fact-2026-07-10",
        kind: "complete",
        resultRevision: "yahoo:2026-07-10T22:00:00.000Z",
      },
    ]);
    const facts = await env.DB.prepare(
      `SELECT instrument_id, trading_date, previous_trading_date,
              current_raw_close_decimal, movement_percent_decimal, status
         FROM daily_market_facts ORDER BY trading_date`,
    ).all();
    expect(facts.results).toEqual([
      {
        instrument_id: "instrument-1",
        trading_date: "2026-07-09",
        previous_trading_date: "2026-07-08",
        current_raw_close_decimal: "102",
        movement_percent_decimal: "2",
        status: "valid",
      },
      {
        instrument_id: "instrument-1",
        trading_date: "2026-07-10",
        previous_trading_date: "2026-07-09",
        current_raw_close_decimal: "112.2",
        movement_percent_decimal: "10",
        status: "valid",
      },
    ]);
  });

  it("refreshes qualified analysis in Chinese, persists sources, and reuses it on redelivery", async () => {
    await insertInstrument();
    const calls: Array<[string, string, string]> = [];
    const usage: D1Usage = { rowsRead: 0, rowsWritten: 0 };
    const search = vi.fn(async () => [
      {
        title: "Processor Corp expands enterprise sales",
        publisher: "Example News",
        publishedAt: "2026-07-10T16:00:00.000Z",
        url: "https://example.com/processor-news",
        description: "A supplied source description.",
      },
    ]);
    const explain = vi.fn(async () => ({
      explanationZhCn: "企业销售增长可能是本次上涨的催化因素。",
      model: "test-model",
    }));
    const processor = new PortfolioPipelineProcessor({
      db: traceDatabase(env.DB, usage),
      marketDataProvider: marketProvider(calls),
      newsProvider: newsProvider(search),
      explanationProvider: explanationProvider(explain),
      now: () => new Date(now),
      newId: (() => {
        let index = 0;
        return () => `generated-${++index}`;
      })(),
    });
    await processor.processMarketFact({
      batch: batch(),
      work: [work("fact-2026-07-10", "market_fact", "2026-07-10")],
    });
    usage.rowsRead = 0;
    usage.rowsWritten = 0;

    const analysisWork = work("analysis-2026-07-10", "analysis", "2026-07-10");
    const analysisBatch = batch({ workType: "analysis" });
    const first = await processor.processAnalysis({
      batch: analysisBatch,
      work: [analysisWork],
    });
    expect(usage.rowsRead).toBeLessThanOrEqual(5_000);
    expect(usage.rowsWritten).toBeLessThanOrEqual(1_000);
    const second = await processor.processAnalysis({
      batch: analysisBatch,
      work: [analysisWork],
    });

    expect(first).toEqual([
      {
        workItemId: "analysis-2026-07-10",
        kind: "complete",
        resultRevision: expect.any(String),
      },
    ]);
    expect(second).toEqual(first);
    expect(search).toHaveBeenCalledTimes(2);
    expect(explain).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        `SELECT summary_zh_cn, model, status
           FROM movement_analyses
          WHERE daily_market_fact_id = 'instrument-1:2026-07-10'`,
      ).first(),
    ).toEqual({
      summary_zh_cn: "企业销售增长可能是本次上涨的催化因素。",
      model: "test-model",
      status: "complete",
    });
    expect(
      await env.DB.prepare(
        `SELECT title, source_url, cited
           FROM news_sources
          WHERE movement_analysis_id = (SELECT id FROM movement_analyses
                                         WHERE daily_market_fact_id = 'instrument-1:2026-07-10')`,
      ).first(),
    ).toEqual({
      title: "Processor Corp expands enterprise sales",
      source_url: "https://example.com/processor-news",
      cited: 1,
    });
  });

  it("keeps a 90-day history slice inside its reserved D1 envelope", async () => {
    await insertInstrument();
    const dates = weekdays("2026-04-12", "2026-07-10");
    const usage: D1Usage = { rowsRead: 0, rowsWritten: 0 };
    const processor = new PortfolioPipelineProcessor({
      db: traceDatabase(env.DB, usage),
      marketDataProvider: {
        getInstrument: vi.fn(async (symbol) => ({
          metadata: {
            symbol,
            companyName: "Processor Corp",
            exchange: "NYSE",
            currency: "USD",
            instrumentType: "EQUITY" as const,
          },
          bars: [
            { date: "2026-04-10", close: 100, adjustedClose: 100 },
            ...dates.map((date, index) => ({
              date,
              close: 101 + index,
              adjustedClose: 101 + index,
            })),
          ],
          corporateActionDates: new Set<string>(),
        })),
      },
      newsProvider: newsProvider(async () => []),
      explanationProvider: explanationProvider(async () => ({
        explanationZhCn: "不会被调用。",
        model: "test",
      })),
      now: () => new Date(now),
    });

    const outcomes = await processor.processMarketFact({
      batch: batch({
        requestedStartDate: "2026-04-12",
        requestedEndDate: "2026-07-10",
      }),
      work: dates.map((date) => work(`history-${date}`, "market_fact", date)),
    });

    expect(outcomes).toHaveLength(dates.length);
    expect(outcomes.every((outcome) => outcome.kind === "complete")).toBe(true);
    expect(usage.rowsRead).toBeLessThanOrEqual(10_000);
    expect(usage.rowsWritten).toBeLessThanOrEqual(3_000);
  });

  it("terminalizes a non-transient range validation failure instead of retrying forever", async () => {
    await insertInstrument();
    const validProcessor = new PortfolioPipelineProcessor({
      db: env.DB,
      marketDataProvider: marketProvider([]),
      newsProvider: newsProvider(async () => []),
      explanationProvider: explanationProvider(async () => ({
        explanationZhCn: "不会被调用。",
        model: "test",
      })),
      now: () => new Date(now),
    });
    await validProcessor.processMarketFact({
      batch: batch(),
      work: [work("fact-existing", "market_fact", "2026-07-10")],
    });
    const invalidProvider: MarketDataProvider = {
      getInstrument: vi.fn(async () => ({
        metadata: {
          symbol: "WRONG-SYMBOL",
          companyName: "Processor Corp",
          exchange: "NYSE",
          currency: "USD",
          instrumentType: "EQUITY" as const,
        },
        bars: [],
        corporateActionDates: new Set<string>(),
      })),
    };
    const processor = new PortfolioPipelineProcessor({
      db: env.DB,
      marketDataProvider: invalidProvider,
      newsProvider: newsProvider(async () => []),
      explanationProvider: explanationProvider(async () => ({
        explanationZhCn: "不会被调用。",
        model: "test",
      })),
      now: () => new Date(now),
    });

    await expect(
      processor.processMarketFact({
        batch: batch(),
        work: [work("fact-invalid", "market_fact", "2026-07-10")],
      }),
    ).resolves.toEqual([
      {
        workItemId: "fact-invalid",
        kind: "terminal",
        errorCode: "market_symbol_mismatch",
        errorMessage: "Market data processing failed for 2026-07-10.",
      },
    ]);
    expect(
      await env.DB.prepare(
        `SELECT status, current_raw_close_decimal
           FROM daily_market_facts
          WHERE id = 'instrument-1:2026-07-10'`,
      ).first(),
    ).toEqual({ status: "valid", current_raw_close_decimal: "112.2" });
  });

  it("marks absent current and historical closes as retryable provider states", async () => {
    await insertInstrument();
    const delayedProvider: MarketDataProvider = {
      getInstrument: vi.fn(async (symbol) => ({
        metadata: {
          symbol,
          companyName: "Processor Corp",
          exchange: "NYSE",
          currency: "USD",
          instrumentType: "EQUITY" as const,
        },
        bars: [
          { date: "2026-07-08", close: 100, adjustedClose: 100 },
          { date: "2026-07-09", close: 102, adjustedClose: 102 },
        ],
        corporateActionDates: new Set<string>(),
      })),
    };
    const delayedProcessor = new PortfolioPipelineProcessor({
      db: env.DB,
      marketDataProvider: delayedProvider,
      newsProvider: newsProvider(async () => []),
      explanationProvider: explanationProvider(async () => ({
        explanationZhCn: "不会被调用。",
        model: "test",
      })),
      now: () => new Date(now),
    });
    await expect(
      delayedProcessor.processMarketFact({
        batch: batch(),
        work: [work("fact-delayed", "market_fact", "2026-07-10")],
      }),
    ).resolves.toEqual([
      {
        workItemId: "fact-delayed",
        kind: "retry",
        errorCode: "market_bar_pending",
        errorMessage: "No market bar was returned for 2026-07-10.",
      },
    ]);
    expect(
      await env.DB.prepare(
        "SELECT revision FROM fact_revision_buckets WHERE bucket_key = 'latest'",
      ).first(),
    ).toEqual({ revision: 1 });
    expect(
      await env.DB.prepare(
        "SELECT revision FROM fact_revision_buckets WHERE bucket_key = '2026-07'",
      ).first(),
    ).toBeNull();

    const historicalProcessor = new PortfolioPipelineProcessor({
      db: env.DB,
      marketDataProvider: delayedProvider,
      newsProvider: newsProvider(async () => []),
      explanationProvider: explanationProvider(async () => ({
        explanationZhCn: "不会被调用。",
        model: "test",
      })),
      now: () => new Date("2026-07-11T22:00:00.000Z"),
    });
    await expect(
      historicalProcessor.processMarketFact({
        batch: batch(),
        work: [work("fact-historical-gap", "market_fact", "2026-07-10")],
      }),
    ).resolves.toEqual([
      {
        workItemId: "fact-historical-gap",
        kind: "retry",
        errorCode: "market_bar_missing",
        errorMessage: "No market bar was returned for 2026-07-10.",
        retryDelaySeconds: 900,
      },
    ]);
  });

  it("returns retry outcomes for transient news failures and keeps the fact intact", async () => {
    await insertInstrument();
    const processor = new PortfolioPipelineProcessor({
      db: env.DB,
      marketDataProvider: marketProvider([]),
      newsProvider: newsProvider(async () => {
        throw new Error("http_503");
      }),
      explanationProvider: explanationProvider(async () => ({
        explanationZhCn: "不会被调用。",
        model: "test",
      })),
      now: () => new Date(now),
      newId: () => "error-analysis",
    });
    await processor.processMarketFact({
      batch: batch(),
      work: [work("fact-2026-07-10", "market_fact", "2026-07-10")],
    });
    const outcomes = await processor.processAnalysis({
      batch: batch({ workType: "analysis" }),
      work: [work("analysis-2026-07-10", "analysis", "2026-07-10")],
    });

    expect(outcomes).toEqual([
      {
        workItemId: "analysis-2026-07-10",
        kind: "retry",
        errorCode: "http_503",
        errorMessage: "The movement analysis could not be refreshed.",
      },
    ]);
    expect(
      await env.DB.prepare(
        `SELECT status, current_raw_close_decimal
           FROM daily_market_facts
          WHERE id = 'instrument-1:2026-07-10'`,
      ).first(),
    ).toEqual({ status: "valid", current_raw_close_decimal: "112.2" });
  });
});
