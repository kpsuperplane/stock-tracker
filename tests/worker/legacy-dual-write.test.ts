import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { RunRepository } from "../../src/db/runs";
import { TickerRepository } from "../../src/db/tickers";
import { LegacyDualWriteService } from "../../src/services/legacy-dual-write";

const now = "2026-07-10T22:00:00.000Z";

const insertTicker = async (id: string, symbol: string) => {
  const repository = new TickerRepository(env.DB);
  await repository.insert({
    id,
    symbol,
    companyName: `${symbol} Company`,
    exchange: "NMS",
    currency: "USD",
    now,
  });
  const ticker = await repository.findBySymbol(symbol);
  if (!ticker) throw new Error("ticker_missing");
  return ticker;
};

const prepareRun = async (input: {
  date: string;
  origin?: "scheduled" | "backfill";
  tickers: Awaited<ReturnType<typeof insertTicker>>[];
  repository: RunRepository;
  prices?: Array<{
    previousDate: string;
    previousPrice: number;
    currentPrice: number;
    changeAmount: number;
    changePct: number;
    priceBasis?: "adjusted" | "close";
  } | null>;
  withAnalysis?: boolean;
}) => {
  const run = await input.repository.createRun({
    tradingDate: input.date,
    origin: input.origin ?? "scheduled",
    backfillJobId: null,
    tickers: input.tickers,
    now,
  });
  for (const [index, screeningId] of run.screeningIds.entries()) {
    const price = input.prices?.[index];
    if (price) {
      await input.repository.savePrice(screeningId, {
        ...price,
        priceBasis: price.priceBasis ?? "adjusted",
        qualified: price.changePct >= 5,
      });
      if (input.withAnalysis !== false && price.changePct >= 5) {
        await input.repository.saveScreeningResult(
          screeningId,
          [
            {
              title: "Earnings update",
              publisher: "Example News",
              publishedAt: now,
              url: "https://example.com/earnings",
            },
          ],
          { explanationZhCn: "业绩更新推动股价变化。", model: "test-model" },
          now,
        );
      } else {
        await input.repository.completeWithoutAnalysis(screeningId);
      }
    } else {
      await input.repository.completeWithoutAnalysis(screeningId);
    }
  }
  return run;
};

const enabledService = (beforeAttempt?: () => void | Promise<void>) =>
  new LegacyDualWriteService(env.DB, {
    enabled: true,
    now: () => new Date(now),
    ...(beforeAttempt ? { beforeAttempt: () => beforeAttempt() } : {}),
  });

describe("legacy compatibility dual-write", () => {
  it("maps one published winner with provenance, analysis, sources, and repair state", async () => {
    const ticker = await insertTicker("legacy-aapl", "AAPL");
    const dualWrite = enabledService();
    const repository = new RunRepository(env.DB, dualWrite);
    const run = await prepareRun({
      date: "2026-07-10",
      tickers: [ticker],
      repository,
      prices: [
        {
          previousDate: "2026-07-09",
          previousPrice: 100,
          currentPrice: 110,
          changeAmount: 10,
          changePct: 10,
        },
      ],
    });

    expect(await repository.finalizeRun(run.runId, now)).toBe("complete");
    expect(
      await env.DB.prepare("SELECT published FROM report_runs WHERE id = ?1")
        .bind(run.runId)
        .first(),
    ).toEqual({ published: 1 });
    expect(
      await env.DB.prepare(
        `SELECT instrument_id, trading_date, current_raw_close_decimal,
                previous_raw_close_decimal, movement_basis, provider,
                provider_revision, raw_close_difference_decimal
           FROM daily_market_facts`,
      ).first(),
    ).toEqual({
      instrument_id: "legacy-ticker:legacy-aapl",
      trading_date: "2026-07-10",
      current_raw_close_decimal: "110",
      previous_raw_close_decimal: "100",
      movement_basis: "legacy_migration",
      provider: "legacy-report",
      provider_revision: `legacy-report:${run.runId}:1:${run.screeningIds[0]}`,
      raw_close_difference_decimal: null,
    });
    expect(
      await env.DB.prepare(
        "SELECT summary_zh_cn, status FROM movement_analyses",
      ).first(),
    ).toEqual({ summary_zh_cn: "业绩更新推动股价变化。", status: "complete" });
    expect(
      await env.DB.prepare("SELECT source_url FROM news_sources").first(),
    ).toEqual({ source_url: "https://example.com/earnings" });
    expect(
      await env.DB.prepare(
        `SELECT legacy_run_id, legacy_screening_id, legacy_generation,
                state, failure_code, attempt_count, resolved_at
           FROM legacy_dual_write_repairs`,
      ).first(),
    ).toEqual({
      legacy_run_id: run.runId,
      legacy_screening_id: run.screeningIds[0],
      legacy_generation: 1,
      state: "resolved",
      failure_code: null,
      attempt_count: 1,
      resolved_at: now,
    });
  });

  it("uses close-only raw differences and preserves pre-existing normalized IDs and source metadata", async () => {
    const ticker = await insertTicker("legacy-existing", "EXIST");
    await env.DB.prepare(
      `INSERT INTO instruments
       (id, symbol, company_name, exchange, currency, instrument_type,
        provider, provider_symbol, created_at, updated_at)
       VALUES ('normalized-instrument', 'EXIST', 'Existing Corp', 'NMS', 'USD',
               'stock', 'yahoo', 'EXIST', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO daily_market_facts
       (id, instrument_id, trading_date, previous_trading_date,
        previous_raw_close_decimal, current_raw_close_decimal,
        crossing_split_numerator, crossing_split_denominator,
        split_adjusted_previous_close_decimal, movement_amount_decimal,
        movement_percent_decimal, raw_close_difference_decimal, movement_basis,
        provider, provider_revision, retrieved_at, status, created_at, updated_at)
       VALUES ('normalized-fact-existing', 'normalized-instrument', '2026-07-09',
               '2026-07-08', '100', '101', '1', '1', '100', '1', '1', '1',
               'split_adjusted_price_return', 'yahoo', 'normalized-r1', ?1,
               'valid', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO movement_analyses
       (id, daily_market_fact_id, dependency_fingerprint, summary_zh_cn,
        model, status, created_at, updated_at)
       VALUES ('normalized-analysis-existing', 'normalized-fact-existing',
               'old-fingerprint', '旧摘要', 'old-model', 'complete', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO news_sources
       (id, movement_analysis_id, source_order, title, publisher, published_at,
        source_url, cited, created_at)
       VALUES ('normalized-source-existing', 'normalized-analysis-existing', 0,
               'Old source', 'Old Publisher', ?1, 'https://example.com/old', 0, ?1)`,
    )
      .bind(now)
      .run();

    const repository = new RunRepository(env.DB, enabledService());
    const run = await prepareRun({
      date: "2026-07-09",
      tickers: [ticker],
      repository,
      prices: [
        {
          previousDate: "2026-07-08",
          previousPrice: 100,
          currentPrice: 110,
          changeAmount: 10,
          changePct: 10,
          priceBasis: "close",
        },
      ],
    });
    await env.DB.prepare("UPDATE sources SET cited = 0 WHERE screening_id = ?1")
      .bind(run.screeningIds[0])
      .run();
    await repository.finalizeRun(run.runId, now);

    expect(
      await env.DB.prepare(
        `SELECT id, raw_close_difference_decimal, provider_revision
           FROM daily_market_facts`,
      ).first(),
    ).toEqual({
      id: "normalized-fact-existing",
      raw_close_difference_decimal: "10",
      provider_revision: `legacy-report:${run.runId}:1:${run.screeningIds[0]}`,
    });
    expect(
      await env.DB.prepare(
        `SELECT id, daily_market_fact_id, summary_zh_cn
           FROM movement_analyses`,
      ).first(),
    ).toEqual({
      id: "normalized-analysis-existing",
      daily_market_fact_id: "normalized-fact-existing",
      summary_zh_cn: "业绩更新推动股价变化。",
    });
    expect(
      await env.DB.prepare(
        `SELECT movement_analysis_id, cited, source_url FROM news_sources`,
      ).first(),
    ).toEqual({
      movement_analysis_id: "normalized-analysis-existing",
      cited: 0,
      source_url: "https://example.com/earnings",
    });
  });

  it("does nothing when the strict dual-write flag is off", async () => {
    const ticker = await insertTicker("legacy-off", "OFF");
    const repository = new RunRepository(
      env.DB,
      new LegacyDualWriteService(env.DB, {
        enabled: false,
        now: () => new Date(now),
      }),
    );
    const run = await prepareRun({
      date: "2026-07-09",
      tickers: [ticker],
      repository,
      prices: [
        {
          previousDate: "2026-07-08",
          previousPrice: 100,
          currentPrice: 90,
          changeAmount: -10,
          changePct: -10,
        },
      ],
    });
    await repository.finalizeRun(run.runId, now);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM daily_market_facts",
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM legacy_dual_write_repairs",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("repairs a published screening whose marker was never created", async () => {
    const ticker = await insertTicker("legacy-marker-missing", "NOMARK");
    const repository = new RunRepository(env.DB);
    const run = await prepareRun({
      date: "2026-07-09",
      tickers: [ticker],
      repository,
      prices: [
        {
          previousDate: "2026-07-08",
          previousPrice: 100,
          currentPrice: 110,
          changeAmount: 10,
          changePct: 10,
        },
      ],
    });
    await repository.finalizeRun(run.runId, now);
    const dualWrite = enabledService();
    await dualWrite.onPublishedRun(run.runId, now);
    expect(
      await env.DB.prepare(
        "SELECT state FROM legacy_dual_write_repairs WHERE legacy_screening_id = ?1",
      )
        .bind(run.screeningIds[0])
        .first(),
    ).toEqual({ state: "resolved" });
  });

  it("does not migrate an old published run that has no seeded repair marker", async () => {
    const ticker = await insertTicker("legacy-old-unseeded", "OLDMARK");
    const repository = new RunRepository(env.DB);
    const run = await prepareRun({
      date: "2026-07-01",
      tickers: [ticker],
      repository,
      prices: [
        {
          previousDate: "2026-06-30",
          previousPrice: 100,
          currentPrice: 110,
          changeAmount: 10,
          changePct: 10,
        },
      ],
    });
    await repository.finalizeRun(run.runId, now);
    const dualWrite = enabledService();
    expect(await dualWrite.retryPending(now)).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM legacy_dual_write_repairs",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("keeps duplicate finalization idempotent", async () => {
    const ticker = await insertTicker("legacy-duplicate", "DUP");
    const repository = new RunRepository(env.DB, enabledService());
    const run = await prepareRun({
      date: "2026-07-09",
      tickers: [ticker],
      repository,
      prices: [
        {
          previousDate: "2026-07-08",
          previousPrice: 100,
          currentPrice: 108,
          changeAmount: 8,
          changePct: 8,
        },
      ],
    });
    await repository.finalizeRun(run.runId, now);
    await repository.finalizeRun(run.runId, now);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM daily_market_facts",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM movement_analyses",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM news_sources",
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("refreshes normalized source metadata when a legacy source changes", async () => {
    const ticker = await insertTicker("legacy-source-refresh", "SRC");
    const dualWrite = enabledService();
    const repository = new RunRepository(env.DB, dualWrite);
    const run = await prepareRun({
      date: "2026-07-08",
      tickers: [ticker],
      repository,
      prices: [
        {
          previousDate: "2026-07-07",
          previousPrice: 100,
          currentPrice: 110,
          changeAmount: 10,
          changePct: 10,
        },
      ],
    });
    await repository.finalizeRun(run.runId, now);
    await env.DB.prepare(
      `UPDATE sources SET publisher = 'Updated Publisher', published_at = ?1
         WHERE screening_id = ?2`,
    )
      .bind("2026-07-10T23:00:00.000Z", run.screeningIds[0])
      .run();
    await env.DB.prepare(
      `UPDATE legacy_dual_write_repairs
          SET state = 'failed', failure_code = 'test_retry',
              failure_message = 'retry source metadata', resolved_at = NULL
        WHERE legacy_screening_id = ?1`,
    )
      .bind(run.screeningIds[0])
      .run();
    await dualWrite.onPublishedRun(run.runId, now);
    expect(
      await env.DB.prepare(
        "SELECT publisher, published_at FROM news_sources",
      ).first(),
    ).toEqual({
      publisher: "Updated Publisher",
      published_at: "2026-07-10T23:00:00.000Z",
    });
  });

  it("updates only the currently published replacement and ignores an unpublished generation", async () => {
    const ticker = await insertTicker("legacy-replace", "REPL");
    const dualWrite = enabledService();
    const repository = new RunRepository(env.DB, dualWrite);
    const oldRun = await prepareRun({
      date: "2026-07-08",
      tickers: [ticker],
      repository,
      prices: [
        {
          previousDate: "2026-07-07",
          previousPrice: 100,
          currentPrice: 101,
          changeAmount: 1,
          changePct: 1,
        },
      ],
      withAnalysis: false,
    });
    await repository.finalizeRun(oldRun.runId, now);
    const replacement = await prepareRun({
      date: "2026-07-08",
      origin: "backfill",
      tickers: [ticker],
      repository,
      prices: [
        {
          previousDate: "2026-07-07",
          previousPrice: 100,
          currentPrice: 120,
          changeAmount: 20,
          changePct: 20,
        },
      ],
    });
    await repository.finalizeRun(replacement.runId, now);
    expect(
      await env.DB.prepare(
        "SELECT current_raw_close_decimal, provider_revision FROM daily_market_facts",
      ).first(),
    ).toEqual({
      current_raw_close_decimal: "120",
      provider_revision: `legacy-report:${replacement.runId}:2:${replacement.screeningIds[0]}`,
    });
    await repository.finalizeRun(oldRun.runId, now);
    const generations = await env.DB.prepare(
      "SELECT id, published FROM report_runs WHERE trading_date = '2026-07-08' ORDER BY generation",
    ).all<{ id: string; published: number }>();
    expect(generations.results).toEqual([
      { id: oldRun.runId, published: 0 },
      { id: replacement.runId, published: 1 },
    ]);
    const unpublished = await prepareRun({
      date: "2026-07-07",
      tickers: [ticker],
      repository,
      prices: [
        {
          previousDate: "2026-07-06",
          previousPrice: 100,
          currentPrice: 130,
          changeAmount: 30,
          changePct: 30,
        },
      ],
    });
    await dualWrite.onPublishedRun(unpublished.runId, now);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM legacy_dual_write_repairs WHERE legacy_run_id = ?1",
      )
        .bind(unpublished.runId)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("keeps missing prices observable and carries partial analysis as pending", async () => {
    const priced = await insertTicker("legacy-priced", "PRICE");
    const missing = await insertTicker("legacy-missing", "MISS");
    const repository = new RunRepository(env.DB, enabledService());
    const run = await prepareRun({
      date: "2026-07-06",
      tickers: [priced, missing],
      repository,
      prices: [
        {
          previousDate: "2026-07-03",
          previousPrice: 100,
          currentPrice: 101,
          changeAmount: 1,
          changePct: 1,
        },
        null,
      ],
      withAnalysis: false,
    });
    await repository.finalizeRun(run.runId, now);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM daily_market_facts",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT status FROM movement_analyses WHERE status = 'pending'",
      ).first(),
    ).toEqual({ status: "pending" });
    expect(
      await env.DB.prepare(
        `SELECT legacy_screening_id, state, failure_code
           FROM legacy_dual_write_repairs WHERE state = 'skipped'`,
      ).first(),
    ).toEqual({
      legacy_screening_id: run.screeningIds[1],
      state: "skipped",
      failure_code: "legacy_missing_price",
    });
  });

  it("resolves a soft-deleted ticker identity and retries after a compatibility failure", async () => {
    const ticker = await insertTicker("legacy-deleted", "DEAD");
    await new TickerRepository(env.DB).softDelete(ticker.id, now);
    let fail = true;
    const dualWrite = enabledService(() => {
      if (fail) throw new Error("temporary compatibility outage");
    });
    const repository = new RunRepository(env.DB, dualWrite);
    const run = await prepareRun({
      date: "2026-07-03",
      tickers: [ticker],
      repository,
      prices: [
        {
          previousDate: "2026-07-02",
          previousPrice: 100,
          currentPrice: 110,
          changeAmount: 10,
          changePct: 10,
        },
      ],
    });
    await repository.finalizeRun(run.runId, now);
    expect(
      await env.DB.prepare(
        "SELECT state, failure_code, failure_message, attempt_count FROM legacy_dual_write_repairs",
      ).first(),
    ).toMatchObject({
      state: "failed",
      failure_code: "legacy_dual_write_failed",
      failure_message: "temporary compatibility outage",
      attempt_count: 1,
    });
    expect(
      await env.DB.prepare("SELECT published FROM report_runs WHERE id = ?1")
        .bind(run.runId)
        .first(),
    ).toEqual({ published: 1 });
    fail = false;
    expect(await dualWrite.retryPending(now)).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT state, attempt_count, instrument_id FROM legacy_dual_write_repairs",
      ).first(),
    ).toEqual({
      state: "resolved",
      attempt_count: 2,
      instrument_id: "legacy-ticker:legacy-deleted",
    });
    expect(
      await env.DB.prepare("SELECT symbol FROM instruments").first(),
    ).toEqual({ symbol: "DEAD" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM daily_market_facts",
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("does not let a stale compatibility hook overwrite a newer published generation", async () => {
    const ticker = await insertTicker("legacy-race", "RACE");
    let releaseOld!: () => void;
    let markOldStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });
    const oldRelease = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const oldService = enabledService(async () => {
      markOldStarted();
      await oldRelease;
    });
    const oldRepository = new RunRepository(env.DB, oldService);
    const oldRun = await prepareRun({
      date: "2026-07-02",
      tickers: [ticker],
      repository: oldRepository,
      prices: [
        {
          previousDate: "2026-07-01",
          previousPrice: 100,
          currentPrice: 101,
          changeAmount: 1,
          changePct: 1,
        },
      ],
      withAnalysis: false,
    });
    const oldFinalization = oldRepository.finalizeRun(oldRun.runId, now);
    await oldStarted;

    const replacementService = enabledService();
    const replacementRepository = new RunRepository(env.DB, replacementService);
    const replacement = await prepareRun({
      date: "2026-07-02",
      origin: "backfill",
      tickers: [ticker],
      repository: replacementRepository,
      prices: [
        {
          previousDate: "2026-07-01",
          previousPrice: 100,
          currentPrice: 120,
          changeAmount: 20,
          changePct: 20,
        },
      ],
    });
    await replacementRepository.finalizeRun(replacement.runId, now);
    releaseOld();
    await oldFinalization;

    expect(
      await env.DB.prepare(
        `SELECT current_raw_close_decimal, provider_revision
           FROM daily_market_facts`,
      ).first(),
    ).toEqual({
      current_raw_close_decimal: "120",
      provider_revision: `legacy-report:${replacement.runId}:2:${replacement.screeningIds[0]}`,
    });
    expect(
      await env.DB.prepare(
        `SELECT state, failure_code FROM legacy_dual_write_repairs
           WHERE legacy_screening_id = ?1`,
      )
        .bind(oldRun.screeningIds[0])
        .first(),
    ).toEqual({ state: "skipped", failure_code: "legacy_stale_generation" });
    expect(
      await env.DB.prepare(
        `SELECT state FROM legacy_dual_write_repairs
           WHERE legacy_screening_id = ?1`,
      )
        .bind(replacement.screeningIds[0])
        .first(),
    ).toEqual({ state: "resolved" });
  });
});
