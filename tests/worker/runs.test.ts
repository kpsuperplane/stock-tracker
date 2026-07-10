import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { RunRepository } from "../../src/db/runs";
import { TickerRepository } from "../../src/db/tickers";
import type { ScreeningJobMessage } from "../../src/shared/contracts";

const now = "2026-07-09T22:00:00.000Z";

const insertTicker = async (
  id: string,
  symbol: string,
  companyName: string,
) => {
  const tickers = new TickerRepository(env.DB);
  await tickers.insert({
    id,
    symbol,
    companyName,
    exchange: "NMS",
    currency: "USD",
    now,
  });
  const ticker = await tickers.findBySymbol(symbol);
  if (!ticker) throw new Error("ticker_missing");
  return ticker;
};

describe("RunRepository", () => {
  it("returns the active scheduled run instead of a newer backfill run", async () => {
    const repository = new RunRepository(env.DB);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO report_runs (id, trading_date, generation, origin, published, status, created_at) VALUES ('scheduled-current', '2026-07-09', 1, 'scheduled', 0, 'running', '2026-07-09T22:00:00.000Z')",
      ),
      env.DB.prepare(
        "INSERT INTO report_runs (id, trading_date, generation, origin, published, status, created_at) VALUES ('backfill-newer', '2026-07-08', 1, 'backfill', 0, 'running', '2026-07-09T22:01:00.000Z')",
      ),
    ]);

    expect(await repository.currentRun()).toEqual(
      expect.objectContaining({
        id: "scheduled-current",
        tradingDate: "2026-07-09",
      }),
    );
  });

  it("creates one screening per ticker and claims it once", async () => {
    const ticker = await insertTicker("aapl", "AAPL", "Apple Inc.");
    const repository = new RunRepository(env.DB);
    const run = await repository.createRun({
      tradingDate: "2026-07-09",
      origin: "scheduled",
      backfillJobId: null,
      tickers: [ticker],
      now,
    });
    const [screeningId] = run.screeningIds;
    if (!screeningId) throw new Error("screening_missing");
    const screening = await repository.claimScreening(screeningId, now);
    expect(screening?.symbol).toBe("AAPL");
    expect(await repository.claimScreening(screeningId, now)).toBeNull();
  });

  it("keeps an old generation published until replacement completes", async () => {
    const repository = new RunRepository(env.DB);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO report_runs (id, trading_date, generation, origin, published, status, created_at) VALUES ('old', '2026-07-08', 1, 'backfill', 1, 'complete', ?1)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO report_runs (id, trading_date, generation, origin, published, status, created_at) VALUES ('new', '2026-07-08', 2, 'backfill', 0, 'complete', ?1)",
      ).bind(now),
    ]);
    await repository.publishGeneration("new", now);
    const rows = await env.DB.prepare(
      "SELECT id, published FROM report_runs WHERE trading_date = '2026-07-08' ORDER BY generation",
    ).all<{ id: string; published: number }>();
    expect(rows.results).toEqual([
      { id: "old", published: 0 },
      { id: "new", published: 1 },
    ]);
  });

  it("does not publish a date when every ticker lacks a target bar", async () => {
    const ticker = await insertTicker("msft", "MSFT", "Microsoft Corp.");
    const repository = new RunRepository(env.DB);
    const run = await repository.createRun({
      tradingDate: "2026-07-03",
      origin: "scheduled",
      backfillJobId: null,
      tickers: [ticker],
      now,
    });
    const [screeningId] = run.screeningIds;
    if (!screeningId) throw new Error("screening_missing");
    await repository.markNoTradingData(screeningId, "no_trading_data");
    expect(await repository.finalizeRun(run.runId, now)).toBe("no_market_data");
    expect(
      await env.DB.prepare("SELECT published FROM report_runs WHERE id = ?1")
        .bind(run.runId)
        .first(),
    ).toEqual({ published: 0 });
  });

  it("returns expired queue and processing leases to pending", async () => {
    const ticker = await insertTicker("googl", "GOOGL", "Alphabet Inc.");
    const repository = new RunRepository(env.DB);
    const run = await repository.createRun({
      tradingDate: "2026-07-02",
      origin: "scheduled",
      backfillJobId: null,
      tickers: [ticker],
      now,
    });
    await env.DB.prepare(
      "UPDATE screenings SET status = 'queued', queued_at = '2026-07-09T20:00:00.000Z' WHERE id = ?1",
    )
      .bind(run.screeningIds[0])
      .run();
    expect(
      await repository.reconcileStaleLeases("2026-07-09T21:40:00.000Z"),
    ).toBe(1);
    expect(
      await env.DB.prepare("SELECT status FROM screenings WHERE id = ?1")
        .bind(run.screeningIds[0])
        .first(),
    ).toEqual({ status: "pending" });
  });

  it("returns an existing scheduled run for duplicate creation", async () => {
    const ticker = await insertTicker("meta", "META", "Meta Platforms");
    const repository = new RunRepository(env.DB);
    const first = await repository.createRun({
      tradingDate: "2026-07-01",
      origin: "scheduled",
      backfillJobId: null,
      tickers: [ticker],
      now,
    });
    const duplicate = await repository.createRun({
      tradingDate: "2026-07-01",
      origin: "scheduled",
      backfillJobId: null,
      tickers: [ticker],
      now,
    });
    expect(duplicate.runId).toBe(first.runId);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM report_runs WHERE trading_date = '2026-07-01'",
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("persists price, analysis, and cites every supplied source", async () => {
    const ticker = await insertTicker("shop", "SHOP.TO", "Shopify Inc.");
    const repository = new RunRepository(env.DB);
    const run = await repository.createRun({
      tradingDate: "2026-06-30",
      origin: "backfill",
      backfillJobId: null,
      tickers: [ticker],
      now,
    });
    const [screeningId] = run.screeningIds;
    if (!screeningId) throw new Error("screening_missing");
    await repository.savePrice(screeningId, {
      previousDate: "2026-06-29",
      previousPrice: 100,
      currentPrice: 107,
      changeAmount: 7,
      changePct: 7,
      priceBasis: "adjusted",
      qualified: true,
    });
    await repository.saveScreeningResult(
      screeningId,
      [
        {
          title: "Shopify rises",
          publisher: "Reuters",
          publishedAt: now,
          url: "https://news/one",
        },
        {
          title: "Shopify target raised",
          publisher: "BNN",
          publishedAt: now,
          url: "https://news/two",
        },
      ],
      {
        explanationZhCn: "企业客户增长可能推动股价上涨。",
        model: "test",
      },
      now,
    );
    expect(
      await env.DB.prepare(
        "SELECT status, qualified, change_pct FROM screenings WHERE id = ?1",
      )
        .bind(screeningId)
        .first(),
    ).toEqual({ status: "complete", qualified: 1, change_pct: 7 });
    expect(
      (
        await env.DB.prepare(
          "SELECT source_index, cited FROM sources WHERE screening_id = ?1 ORDER BY source_index",
        )
          .bind(screeningId)
          .all()
      ).results,
    ).toEqual([
      { source_index: 0, cited: 1 },
      { source_index: 1, cited: 1 },
    ]);
  });

  it("dispatches pending screenings in an idempotent queued state", async () => {
    const ticker = await insertTicker("tsla", "TSLA", "Tesla Inc.");
    const repository = new RunRepository(env.DB);
    const run = await repository.createRun({
      tradingDate: "2026-06-29",
      origin: "backfill",
      backfillJobId: null,
      tickers: [ticker],
      now,
    });
    const queue = {
      sendBatch: vi.fn(async () => undefined),
    } as unknown as Queue<ScreeningJobMessage>;
    expect(await repository.dispatchPending(queue, 10, now)).toBe(1);
    expect(queue.sendBatch).toHaveBeenCalledOnce();
    expect(queue.sendBatch).toHaveBeenCalledWith([
      {
        body: {
          screeningId: run.screeningIds[0],
          reportRunId: run.runId,
          tickerId: "tsla",
        },
      },
    ]);
    expect(await repository.dispatchPending(queue, 10, now)).toBe(0);
    expect(await repository.countDispatchedSince("2026-07-09T00:00:00Z")).toBe(
      1,
    );
    expect(
      await env.DB.prepare(
        "SELECT status, queued_at FROM screenings WHERE id = ?1",
      )
        .bind(run.screeningIds[0])
        .first(),
    ).toEqual({ status: "queued", queued_at: now });
  });

  it("replaces stale sources when an analysis retry finds none", async () => {
    const ticker = await insertTicker("amd", "AMD", "Advanced Micro Devices");
    const repository = new RunRepository(env.DB);
    const run = await repository.createRun({
      tradingDate: "2026-06-26",
      origin: "backfill",
      backfillJobId: null,
      tickers: [ticker],
      now,
    });
    const [screeningId] = run.screeningIds;
    if (!screeningId) throw new Error("screening_missing");
    await repository.saveSources(screeningId, [
      {
        title: "Old source",
        publisher: "Reuters",
        publishedAt: now,
        url: "https://news/old",
      },
    ]);
    await repository.saveSources(screeningId, []);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM sources WHERE screening_id = ?1",
      )
        .bind(screeningId)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("preserves the published analysis and sources while a retry is queued", async () => {
    const ticker = await insertTicker("retry-meta", "META", "Meta Platforms");
    const repository = new RunRepository(env.DB);
    const run = await repository.createRun({
      tradingDate: "2026-07-01",
      origin: "backfill",
      backfillJobId: null,
      tickers: [ticker],
      now,
    });
    const [screeningId] = run.screeningIds;
    if (!screeningId) throw new Error("screening_missing");
    await repository.savePrice(screeningId, {
      previousDate: "2026-06-30",
      previousPrice: 563.29,
      currentPrice: 612.91,
      changeAmount: 49.62,
      changePct: 8.81,
      priceBasis: "adjusted",
      qualified: true,
    });
    await repository.saveSources(screeningId, [
      {
        title: "Existing source",
        publisher: "Reuters",
        publishedAt: now,
        url: "https://news/existing",
      },
    ]);
    await repository.markFailed(screeningId, "screening_failed", "old error");
    const queue = {
      send: vi.fn(async () => undefined),
    } as unknown as Queue<ScreeningJobMessage>;

    expect(await repository.retryAnalysis(screeningId, queue, now)).toBe(
      "queued",
    );
    expect(
      await env.DB.prepare(
        "SELECT status FROM analyses WHERE screening_id = ?1",
      )
        .bind(screeningId)
        .first(),
    ).toEqual({ status: "unavailable" });
    expect(
      await env.DB.prepare("SELECT title FROM sources WHERE screening_id = ?1")
        .bind(screeningId)
        .first(),
    ).toEqual({ title: "Existing source" });
    expect(
      await env.DB.prepare("SELECT status FROM screenings WHERE id = ?1")
        .bind(screeningId)
        .first(),
    ).toEqual({ status: "queued" });
  });

  it("accounts conservatively when Queue dispatch fails after leasing work", async () => {
    const ticker = await insertTicker("intc", "INTC", "Intel Corporation");
    const repository = new RunRepository(env.DB);
    const run = await repository.createRun({
      tradingDate: "2026-06-25",
      origin: "backfill",
      backfillJobId: null,
      tickers: [ticker],
      now,
    });
    const [screeningId] = run.screeningIds;
    if (!screeningId) throw new Error("screening_missing");
    const queue = {
      sendBatch: vi.fn(async () => {
        throw new Error("queue quota exceeded");
      }),
    } as unknown as Queue<ScreeningJobMessage>;
    await expect(repository.dispatchPending(queue, 10, now)).rejects.toThrow(
      "queue quota exceeded",
    );
    expect(await repository.countDispatchedSince("2026-07-09T00:00:00Z")).toBe(
      1,
    );
    expect(
      await env.DB.prepare("SELECT status FROM screenings WHERE id = ?1")
        .bind(screeningId)
        .first(),
    ).toEqual({ status: "queued" });
  });
});
