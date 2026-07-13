import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineJobRepository } from "../../src/db/pipeline-jobs";
import { WorkItemRepository } from "../../src/db/work-items";
import type { SplitEventRange } from "../../src/providers/corporate-actions";
import type { DailySeries } from "../../src/providers/market-data";
import { BackfillPipelineAdapter } from "../../src/services/backfill-pipeline";
import { LedgerService } from "../../src/services/ledger";
import { LegacyFactMigrator } from "../../src/services/legacy-fact-migrator";
import { MarketFactsService } from "../../src/services/market-facts";
import { ReconciliationPlannerService } from "../../src/services/reconciliation-planner";
import { WorkDispatcherService } from "../../src/services/work-dispatcher";
import type { PipelineDispatchMessage } from "../../src/shared/contracts";
import { createApp } from "../../src/worker/app";
import type { Env } from "../../src/worker/env";

const fixtureNow = "2026-07-11T12:00:00.000Z";
const fixtureAsOf = "2025-12-31";
const auth = `Basic ${btoa("owner:password")}`;
const requestHeaders = {
  Authorization: auth,
  Host: "local",
  Origin: "http://local",
  "X-Stock-Tracker-Request": "1",
};

interface Metrics {
  queries: number;
  rowsRead: number;
  rowsWritten: number;
  durationMs: number;
}

interface Probe<T> {
  value: T;
  metrics: Metrics;
  bytes: number;
  wallMs: number;
  headers: Headers;
}

const metrics = (): Metrics => ({
  queries: 0,
  rowsRead: 0,
  rowsWritten: 0,
  durationMs: 0,
});

const resultMeta = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && "meta" in value
    ? (((value as { meta?: unknown }).meta as Record<string, unknown>) ?? null)
    : null;

const addMeta = (target: Metrics, value: unknown, fallbackRows = 0) => {
  const meta = resultMeta(value);
  const rowsRead = Number(meta?.rows_read ?? meta?.rowsRead ?? fallbackRows);
  const rowsWritten = Number(meta?.rows_written ?? meta?.rowsWritten ?? 0);
  const duration = Number(meta?.duration ?? meta?.durationMs ?? 0);
  if (Number.isFinite(rowsRead)) target.rowsRead += rowsRead;
  if (Number.isFinite(rowsWritten)) target.rowsWritten += rowsWritten;
  if (Number.isFinite(duration)) target.durationMs += duration;
};

/**
 * Miniflare exposes D1 statement metadata, but the Worker entrypoint receives
 * a concrete binding. This narrow test proxy records the same metadata while
 * leaving every production query and route untouched.
 */
const traceStatement = (statement: D1PreparedStatement, target: Metrics) =>
  new Proxy(statement, {
    get(source, property, receiver) {
      if (property === "bind") {
        return (...values: unknown[]) =>
          traceStatement(
            Reflect.apply(
              source.bind as (...args: unknown[]) => D1PreparedStatement,
              source,
              values,
            ),
            target,
          );
      }
      if (property === "all" || property === "first" || property === "run") {
        return async (...values: unknown[]) => {
          const method = Reflect.get(source, property) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          const result = await Reflect.apply(method, source, values);
          addMeta(
            target,
            result,
            property === "first" && result !== null ? 1 : 0,
          );
          return result;
        };
      }
      return Reflect.get(source, property, receiver);
    },
  });

const traceDatabase = (database: D1Database, target: Metrics): D1Database =>
  new Proxy(database, {
    get(source, property, receiver) {
      if (property === "prepare") {
        return (query: string) => {
          target.queries += 1;
          return traceStatement(
            Reflect.apply(
              source.prepare as (...args: unknown[]) => D1PreparedStatement,
              source,
              [query],
            ),
            target,
          );
        };
      }
      if (property === "batch") {
        return async (...values: unknown[]) => {
          const method = Reflect.get(source, property) as (
            ...args: unknown[]
          ) => Promise<unknown>;
          const result = await Reflect.apply(method, source, values);
          if (Array.isArray(result)) {
            for (const item of result) addMeta(target, item);
          }
          return result;
        };
      }
      return Reflect.get(source, property, receiver);
    },
  });

const probeRequest = async <T>(
  app: ReturnType<typeof createApp>,
  path: string,
  database: D1Database,
  parse: (body: string) => T,
  headers: Record<string, string> = {},
): Promise<Probe<T>> => {
  const statementMetrics = metrics();
  const started = performance.now();
  const response = await app.fetch(
    new Request(`http://local${path}`, {
      headers: { ...requestHeaders, ...headers },
    }),
    {
      ...(env as unknown as Env),
      DB: traceDatabase(database, statementMetrics),
      READ_MODELS_ENABLED: "true",
      PORTFOLIO_HISTORY_ENABLED: "true",
    },
  );
  const body = await response.text();
  const wallMs = performance.now() - started;
  return {
    value: parse(body),
    metrics: statementMetrics,
    bytes: new TextEncoder().encode(body).byteLength,
    wallMs,
    headers: response.headers,
  };
};

const weekdays = (start: string, end: string): string[] => {
  const dates: string[] = [];
  for (
    let cursor = new Date(`${start}T12:00:00.000Z`);
    cursor <= new Date(`${end}T12:00:00.000Z`);
    cursor = new Date(cursor.valueOf() + 86_400_000)
  ) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
};

const insertFixture = async (): Promise<void> => {
  const instruments = Array.from({ length: 100 }, (_value, index) => {
    const suffix = String(index).padStart(3, "0");
    return {
      id: `perf-instrument-${suffix}`,
      symbol: `PERF${suffix}`,
      companyName: `Performance ${suffix}`,
      exchange: index % 2 === 0 ? "NYSE" : "TSX",
      currency: index % 2 === 0 ? "USD" : "CAD",
    };
  });
  const instrumentJson = JSON.stringify(instruments);
  const dates = weekdays("2021-01-01", "2025-12-31");
  // A first fact still needs a completed comparison bar.  The fixture uses a
  // synthetic Friday before the first weekday so every row satisfies the
  // normalized-fact CHECK constraint instead of accidentally creating a
  // partially-populated "first" fact.
  const dateJson = JSON.stringify(
    dates.map((date, index) => ({
      date,
      previous: dates[index - 1] ?? "2020-12-31",
    })),
  );
  const transactionRows = Array.from({ length: 100 }, (_value, index) => ({
    index,
    date: dates[index % dates.length] ?? "2021-01-01",
  }));
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO instruments
         (id, symbol, company_name, exchange, currency, instrument_type,
          provider, provider_symbol, created_at, updated_at)
         SELECT json_extract(value, '$.id'), json_extract(value, '$.symbol'),
                json_extract(value, '$.companyName'), json_extract(value, '$.exchange'),
                json_extract(value, '$.currency'), 'stock', 'fixture',
                json_extract(value, '$.symbol'), ?2, ?2
           FROM json_each(?1)`,
    ).bind(instrumentJson, fixtureNow),
    env.DB.prepare(
      `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
          revision, created_at, updated_at)
         SELECT 'perf-tx:' || instrument.id || ':' || json_extract(value, '$.index'),
                instrument.id, json_extract(value, '$.date'), 'buy', '1', '10',
                1, ?2, ?2
           FROM instruments instrument CROSS JOIN json_each(?1)
          WHERE instrument.id LIKE 'perf-instrument-%'`,
    ).bind(JSON.stringify(transactionRows), fixtureNow),
    env.DB.prepare(
      `INSERT INTO daily_market_facts
         (id, instrument_id, trading_date, previous_trading_date,
          previous_raw_close_decimal, current_raw_close_decimal,
          crossing_split_numerator, crossing_split_denominator,
          split_adjusted_previous_close_decimal, movement_amount_decimal,
          movement_percent_decimal, raw_close_difference_decimal, movement_basis,
          provider, provider_revision, retrieved_at, status, created_at, updated_at)
         SELECT 'perf-fact:' || instrument.id || ':' || json_extract(value, '$.date'),
                instrument.id, json_extract(value, '$.date'),
                json_extract(value, '$.previous'),
                CASE WHEN json_extract(value, '$.previous') IS NULL THEN NULL ELSE '99' END,
                '100', '1', '1',
                CASE WHEN json_extract(value, '$.previous') IS NULL THEN NULL ELSE '99' END,
                CASE WHEN json_extract(value, '$.previous') IS NULL THEN NULL ELSE '1' END,
                CASE WHEN json_extract(value, '$.previous') IS NULL THEN NULL ELSE '6' END,
                CASE WHEN json_extract(value, '$.previous') IS NULL THEN NULL ELSE '1' END,
                'split_adjusted_price_return',
                'fixture', 'fixture-r1', ?2, 'valid', ?2, ?2
           FROM instruments instrument CROSS JOIN json_each(?1)
          WHERE instrument.id LIKE 'perf-instrument-%'`,
    ).bind(dateJson, fixtureNow),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
         VALUES ('latest', 1, ?1), ('2025-11', 1, ?1), ('2025-12', 1, ?1)`,
    ).bind(fixtureNow),
  ]);
};

const json = <T>(body: string): T => JSON.parse(body) as T;

const noSplitRange = (
  symbol: string,
  startDate: string,
  endDate: string,
): SplitEventRange => ({
  symbol,
  range: {
    requestedStartDate: startDate,
    requestedEndDate: endDate,
    coverageStartDate: null,
    coverageEndDate: null,
    isComplete: false,
    basis: "unverified" as const,
    provider: "fixture",
    observedAt: fixtureNow,
    providerRevision: "fixture-r1",
  },
  events: [],
});

const marketSeries = (
  symbol: string,
  startDate: string,
  endDate: string,
): DailySeries => ({
  metadata: {
    symbol,
    companyName: "Performance Fixture",
    exchange: "NMS",
    currency: "USD",
    instrumentType: "EQUITY",
  },
  bars: [
    {
      date: new Date(Date.parse(`${startDate}T12:00:00.000Z`) - 86_400_000)
        .toISOString()
        .slice(0, 10),
      close: 100,
      adjustedClose: 100,
    },
    { date: startDate, close: 106, adjustedClose: 106 },
    ...(endDate === startDate
      ? []
      : [{ date: endDate, close: 107, adjustedClose: 107 }]),
  ],
  corporateActionDates: new Set<string>(),
});

const createPlannerJob = async (id: string, instrumentId: string) => {
  const now = fixtureNow;
  const jobs = new PipelineJobRepository(env.DB);
  const work = new WorkItemRepository(env.DB);
  const plannerId = `${id}-planner`;
  await env.DB.batch([
    jobs.createStatement({
      id,
      triggerType: "ledger_reconciliation",
      requestedStartDate: "2025-11-01",
      requestedEndDate: "2025-11-30",
      affectedInstrumentsJson: JSON.stringify([instrumentId]),
      eligibilityIntervalsJson: JSON.stringify([
        {
          instrumentId,
          startDate: "2025-11-03",
          endDate: "2025-11-28",
        },
      ]),
      priority: 100,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      plannerCursor: null,
      plannerDividendCursor: null,
      plannerLeaseUntil: null,
    }),
    work.createPlanningStatement({
      id: plannerId,
      pipelineJobId: id,
      workType: "ledger_reconciliation_plan",
      deterministicKey: WorkItemRepository.planningKey(
        id,
        "ledger_reconciliation_plan",
      ),
      priority: 100,
      maxAttempts: 3,
      createdAt: now,
      updatedAt: now,
    }),
    work.linkToJobStatement({
      pipelineJobId: id,
      workItemId: plannerId,
      relationship: "required",
      createdAt: now,
    }),
  ]);
};

describe("portfolio performance budgets", () => {
  const app = createApp();

  beforeEach(insertFixture);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the 100-instrument/10k-transaction/five-year fixture bounded", async () => {
    const portfolio = await probeRequest<{
      portfolio: { positions: unknown[] };
    }>(
      app,
      `/api/portfolio?today=${fixtureAsOf}&locale=en&limit=100`,
      env.DB,
      json,
    );
    expect(portfolio.value.portfolio.positions).toHaveLength(100);
    expect(portfolio.metrics.queries).toBeLessThanOrEqual(30);
    expect(portfolio.metrics.rowsRead).toBeLessThanOrEqual(250_000);
    expect(portfolio.metrics.durationMs).toBeLessThanOrEqual(1_000);
    expect(portfolio.bytes).toBeLessThanOrEqual(500_000);
    expect(portfolio.wallMs).toBeLessThan(10_000);

    const history = await probeRequest<{
      history: {
        currencies: Array<{ points: unknown[]; positions: unknown[] }>;
      };
    }>(app, "/api/portfolio/history?range=all&locale=en", env.DB, json);
    expect(history.value.history.currencies).toHaveLength(2);
    expect(
      history.value.history.currencies.every(
        (currency) => currency.points.length <= 600,
      ),
    ).toBe(true);
    expect(
      history.value.history.currencies.reduce(
        (total, currency) => total + currency.positions.length,
        0,
      ),
    ).toBe(100);
    expect(history.metrics.rowsRead).toBeLessThanOrEqual(250_000);
    expect(history.metrics.durationMs).toBeLessThanOrEqual(1_000);
    expect(history.bytes).toBeLessThanOrEqual(500_000);
    expect(history.wallMs).toBeLessThan(10_000);

    const historyTag = history.headers.get("ETag");
    const unchangedHistory = await probeRequest(
      app,
      "/api/portfolio/history?range=all&locale=en",
      env.DB,
      (body) => body,
      { "If-None-Match": historyTag ?? "" },
    );
    expect(unchangedHistory.value).toBe("");
    expect(unchangedHistory.metrics.rowsRead).toBeLessThanOrEqual(20_000);
    expect(unchangedHistory.metrics.durationMs).toBeLessThanOrEqual(1_000);
    expect(unchangedHistory.bytes).toBe(0);

    const calendarMonth = await probeRequest<{
      calendar: { events: unknown[] };
    }>(
      app,
      "/api/calendar?startDate=2025-12-01&endDate=2025-12-31&asOfDate=2025-12-31&view=month&limit=500",
      env.DB,
      json,
    );
    expect(calendarMonth.value.calendar.events.length).toBe(500);
    expect(calendarMonth.metrics.queries).toBeLessThanOrEqual(35);
    expect(calendarMonth.metrics.rowsRead).toBeLessThanOrEqual(250_000);
    expect(calendarMonth.metrics.durationMs).toBeLessThanOrEqual(1_000);
    expect(calendarMonth.bytes).toBeLessThanOrEqual(1_000_000);
    expect(calendarMonth.wallMs).toBeLessThan(10_000);

    const calendarWeek = await probeRequest<{
      calendar: { events: unknown[] };
    }>(
      app,
      "/api/calendar?startDate=2025-12-01&endDate=2025-12-07&asOfDate=2025-12-31&view=week&limit=500",
      env.DB,
      json,
    );
    expect(calendarWeek.value.calendar.events.length).toBeGreaterThan(100);
    expect(calendarWeek.metrics.queries).toBeLessThanOrEqual(35);
    expect(calendarWeek.metrics.rowsRead).toBeLessThanOrEqual(150_000);
    expect(calendarWeek.metrics.durationMs).toBeLessThanOrEqual(1_000);

    const etag = portfolio.headers.get("ETag");
    expect(etag).toBeTruthy();
    const unchanged = await probeRequest(
      app,
      `/api/portfolio?today=${fixtureAsOf}&locale=en&limit=100`,
      env.DB,
      (body) => body,
      { "If-None-Match": etag ?? "" },
    );
    expect(unchanged.value).toBe("");
    expect(unchanged.metrics.rowsRead).toBeLessThanOrEqual(10);
    expect(unchanged.metrics.durationMs).toBeLessThanOrEqual(1_000);
    expect(unchanged.bytes).toBe(0);

    const november = await app.fetch(
      new Request(
        "http://local/api/calendar?startDate=2025-11-01&endDate=2025-11-30&asOfDate=2025-12-31&view=month",
        {
          headers: requestHeaders,
        },
      ),
      { ...(env as unknown as Env), DB: env.DB, READ_MODELS_ENABLED: "true" },
    );
    const novemberTag = november.headers.get("ETag");
    const december = await probeRequest(
      app,
      "/api/calendar?startDate=2025-12-01&endDate=2025-12-31&asOfDate=2025-12-31&view=month",
      env.DB,
      (body) => body,
    );
    const decemberTag = december.headers.get("ETag");
    await env.DB.prepare(
      "UPDATE fact_revision_buckets SET revision = revision + 1, updated_at = ?1 WHERE bucket_key = '2025-11'",
    )
      .bind(fixtureNow)
      .run();
    const affected = await app.fetch(
      new Request(
        "http://local/api/calendar?startDate=2025-11-01&endDate=2025-11-30&asOfDate=2025-12-31&view=month",
        {
          headers: {
            ...requestHeaders,
            "If-None-Match": novemberTag ?? "",
          },
        },
      ),
      { ...(env as unknown as Env), DB: env.DB, READ_MODELS_ENABLED: "true" },
    );
    const unrelated = await app.fetch(
      new Request(
        "http://local/api/calendar?startDate=2025-12-01&endDate=2025-12-31&asOfDate=2025-12-31&view=month",
        {
          headers: {
            ...requestHeaders,
            "If-None-Match": decemberTag ?? "",
          },
        },
      ),
      { ...(env as unknown as Env), DB: env.DB, READ_MODELS_ENABLED: "true" },
    );
    expect(affected.status).toBe(200);
    expect(unrelated.status).toBe(304);
    const unchangedCalendar = await probeRequest(
      app,
      "/api/calendar?startDate=2025-12-01&endDate=2025-12-31&asOfDate=2025-12-31&view=month",
      env.DB,
      (body) => body,
      { "If-None-Match": decemberTag ?? "" },
    );
    expect(unchangedCalendar.value).toBe("");
    expect(unchangedCalendar.metrics.rowsRead).toBeLessThanOrEqual(10);
    expect(unchangedCalendar.metrics.durationMs).toBeLessThanOrEqual(1_000);
    expect(unchangedCalendar.bytes).toBe(0);

    const portfolioAfterHistoricalUpdate = await probeRequest(
      app,
      `/api/portfolio?today=${fixtureAsOf}&locale=en&limit=100`,
      env.DB,
      (body) => body,
      { "If-None-Match": etag ?? "" },
    );
    expect(portfolioAfterHistoricalUpdate.value).toBe("");
    expect(portfolioAfterHistoricalUpdate.headers.get("ETag")).toBe(etag);
  });

  it("keeps mutation, reconciliation, backfill, and migration probes bounded", async () => {
    const instrumentId = "perf-instrument-000";

    const marketCalls = vi.fn<
      (
        symbol: string,
        startDate: string,
        endDate: string,
      ) => Promise<DailySeries>
    >(async (symbol, startDate, endDate) =>
      marketSeries(symbol, startDate, endDate),
    );
    const marketStarted = performance.now();
    const marketFacts = await new MarketFactsService({
      getInstrument: marketCalls,
    }).normalizeResult({
      instrumentId,
      symbol: "PERF000",
      startDate: "2025-12-01",
      endDate: "2025-12-31",
      provider: "fixture",
      providerRevision: "fixture-r1",
      activeSplits: [],
      retrievedAt: fixtureNow,
    });
    expect(marketFacts.facts.length).toBeGreaterThanOrEqual(1);
    expect(marketCalls).toHaveBeenCalledTimes(1);
    expect(performance.now() - marketStarted).toBeLessThan(5_000);

    const splitCalls = vi.fn(
      async (symbol: string, startDate: string, endDate: string) =>
        noSplitRange(symbol, startDate, endDate),
    );
    const mutationMetrics = metrics();
    let mutationId = 0;
    const positionRevision =
      (
        await env.DB.prepare(
          "SELECT revision FROM position_basis_state WHERE id = 1",
        ).first<{ revision: number }>()
      )?.revision ?? 0;
    const mutationStarted = performance.now();
    const mutation = await new LedgerService({
      db: traceDatabase(env.DB, mutationMetrics),
      corporateActionProvider: { getSplits: splitCalls },
      now: () => new Date(fixtureNow),
      newId: () => `perf-ledger-${++mutationId}`,
    }).apply({
      expectedPositionBasisRevision: positionRevision,
      proposal: {
        kind: "create",
        instrumentId,
        tradeDate: "2025-12-30",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "100",
      },
    });
    expect(mutation.kind).toBe("committed");
    expect(splitCalls).toHaveBeenCalledTimes(1);
    // The guarded ledger mutation intentionally rechecks every current
    // position; this fixture records the 100-position read ceiling rather
    // than hiding that cost behind an uninstrumented provider call.
    expect(mutationMetrics.queries).toBeLessThanOrEqual(250);
    expect(mutationMetrics.rowsWritten).toBeGreaterThan(0);
    expect(mutationMetrics.durationMs).toBeLessThanOrEqual(1_000);
    expect(performance.now() - mutationStarted).toBeLessThan(5_000);

    await createPlannerJob("perf-reconcile", instrumentId);
    const plannerMetrics = metrics();
    const plannerStarted = performance.now();
    const planner = await new ReconciliationPlannerService({
      db: traceDatabase(env.DB, plannerMetrics),
      now: () => new Date(fixtureNow),
      newId: (() => {
        let id = 0;
        return () => `perf-planner-work-${++id}`;
      })(),
    }).planPage({
      pipelineJobId: "perf-reconcile",
      pageSize: 25,
      latestCompletedTradingDate: fixtureAsOf,
      previousCompletedTradingDate: "2025-12-30",
    });
    expect(planner.complete || planner.createdCount > 0).toBe(true);
    expect(plannerMetrics.queries).toBeLessThanOrEqual(250);
    expect(plannerMetrics.durationMs).toBeLessThanOrEqual(1_000);
    expect(performance.now() - plannerStarted).toBeLessThan(5_000);

    const backfillMetrics = metrics();
    const backfillStarted = performance.now();
    const backfillId = await new BackfillPipelineAdapter({
      db: traceDatabase(env.DB, backfillMetrics),
      listActiveSymbols: async () => ["PERF000", "PERF001"],
    }).start({
      startDate: "2025-12-01",
      endDate: "2025-12-02",
      reprocessExisting: false,
      now: fixtureNow,
    });
    expect(backfillId).toMatch(/[0-9a-f-]{8,}/i);
    const backfillStatus = await new BackfillPipelineAdapter({
      db: env.DB,
      listActiveSymbols: async () => ["PERF000", "PERF001"],
    }).getStatus(backfillId);
    expect(backfillStatus).toEqual(
      expect.objectContaining({ pipeline_job_id: backfillId }),
    );
    expect(backfillMetrics.queries).toBeLessThanOrEqual(180);
    expect(backfillMetrics.durationMs).toBeLessThanOrEqual(1_000);
    expect(performance.now() - backfillStarted).toBeLessThan(5_000);

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO tickers
         (id, symbol, company_name, exchange, currency, active, created_at, updated_at)
         SELECT 'perf-legacy-ticker-' || value,
                'PERFLEGACY' || value,
                'Performance Legacy ' || value,
                'NMS', 'USD', 1, ?1, ?1
           FROM (WITH RECURSIVE numbers(value) AS (
                   SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 50
                 ) SELECT value FROM numbers)`,
      ).bind(fixtureNow),
      env.DB.prepare(
        `INSERT INTO report_runs
         (id, trading_date, generation, origin, published, status,
          tickers_total, tickers_processed, tickers_qualified, created_at)
         SELECT 'perf-legacy-run-' || value,
                date('2025-10-01', '+' || (value - 1) || ' day'),
                1, 'scheduled', 1, 'complete', 1, 1, 1, ?1
           FROM (WITH RECURSIVE numbers(value) AS (
                   SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 50
                 ) SELECT value FROM numbers)`,
      ).bind(fixtureNow),
      env.DB.prepare(
        `INSERT INTO screenings
         (id, report_run_id, ticker_id, symbol, company_name, exchange,
          currency, target_date, previous_bar_date, previous_price,
          current_price, change_amount, change_pct, price_basis, qualified,
          status)
         SELECT 'perf-legacy-screening-' || value,
                'perf-legacy-run-' || value,
                'perf-legacy-ticker-' || value,
                'PERFLEGACY' || value,
                'Performance Legacy ' || value,
                'NMS', 'USD',
                date('2025-10-01', '+' || (value - 1) || ' day'),
                date('2025-10-01', '+' || (value - 2) || ' day'),
                99, 100, 1, 1, 'close', 1, 'complete'
           FROM (WITH RECURSIVE numbers(value) AS (
                   SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 50
                 ) SELECT value FROM numbers)`,
      ),
    ]);
    const migrationMetrics = metrics();
    const migrationStarted = performance.now();
    const migration = await new LegacyFactMigrator(
      traceDatabase(env.DB, migrationMetrics),
      { enabled: true, now: () => new Date(fixtureNow) },
    ).runPage({ owner: "perf-migrator", pageSize: 50, now: fixtureNow });
    expect(["complete", "running"]).toContain(migration.status);
    expect(migration.examined).toBe(50);
    expect(migration.inserted).toBe(50);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM daily_market_facts WHERE movement_basis = 'legacy_migration'",
      ).first(),
    ).toEqual({ count: 50 });
    // A 50-row catch-up currently performs several provenance/audit writes per
    // row; keep the measured ceiling explicit until that path is folded.
    expect(migrationMetrics.queries).toBeLessThanOrEqual(800);
    expect(migrationMetrics.durationMs).toBeLessThanOrEqual(1_000);
    expect(performance.now() - migrationStarted).toBeLessThan(5_000);

    const work = new WorkItemRepository(env.DB);
    const addWork = async (id: string, date: string, priority: number) =>
      work.ensureGlobal({
        id,
        workType: "market_fact",
        instrumentId,
        effectiveDate: date,
        dependencyRevision: "fixture-r1",
        forcedRefreshGeneration: null,
        deterministicKey: WorkItemRepository.globalFactKey({
          workType: "market_fact",
          instrumentId,
          effectiveDate: date,
          dependencyRevision: "fixture-r1",
          forcedRefreshGeneration: null,
        }),
        priority,
        maxAttempts: 3,
        availableAt: fixtureNow,
        retentionUntil: null,
        createdAt: fixtureNow,
        updatedAt: fixtureNow,
      });
    await addWork("perf-current", fixtureAsOf, 300);
    await addWork("perf-history-a", "2021-01-04", 200);
    await addWork("perf-history-b", "2021-01-05", 200);
    const sent: PipelineDispatchMessage[] = [];
    const queue = {
      send: vi.fn(async (message: PipelineDispatchMessage) => {
        sent.push(message);
      }),
    } as unknown as Queue<PipelineDispatchMessage>;
    const dispatcher = new WorkDispatcherService({
      db: env.DB,
      queue,
      now: () => new Date(fixtureNow),
      dailyCeiling: 1,
      newId: () => "perf-batch",
    });
    const started = performance.now();
    const result = await dispatcher.dispatch();
    const wallMs = performance.now() - started;
    expect(result.dispatchedWorkItems).toBe(1);
    expect(result.ceilingRemaining).toBe(0);
    expect(sent).toEqual([{ dispatchBatchId: "perf-batch" }]);
    expect(wallMs).toBeLessThan(5_000);
    const workStates = await env.DB.prepare(
      "SELECT id, state FROM work_items WHERE id IN ('perf-current', 'perf-history-a', 'perf-history-b') ORDER BY id",
    ).all<{ id: string; state: string }>();
    expect(workStates.results).toEqual([
      { id: "perf-current", state: "queued" },
      { id: "perf-history-a", state: "pending" },
      { id: "perf-history-b", state: "pending" },
    ]);
  });
});
