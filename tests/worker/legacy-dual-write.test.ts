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
        priceBasis: "adjusted",
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

const enabledService = (beforeAttempt?: () => void) =>
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
                provider_revision FROM daily_market_facts`,
      ).first(),
    ).toEqual({
      instrument_id: "legacy-ticker:legacy-aapl",
      trading_date: "2026-07-10",
      current_raw_close_decimal: "110",
      previous_raw_close_decimal: "100",
      movement_basis: "legacy_migration",
      provider: "legacy-report",
      provider_revision: `legacy-report:${run.runId}:1:${run.screeningIds[0]}`,
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
    await repository.finalizeRun(run.runId, now);
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
});
