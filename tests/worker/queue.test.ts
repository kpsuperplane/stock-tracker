import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { RunRepository } from "../../src/db/runs";
import { TickerRepository } from "../../src/db/tickers";
import { WorkersAiExplanationProvider } from "../../src/providers/explanations";
import { GoogleNewsProvider } from "../../src/providers/google-news";
import { YahooMarketDataProvider } from "../../src/providers/yahoo";
import type { ScreeningJobMessage } from "../../src/shared/contracts";
import { handleQueue } from "../../src/worker/queue";

const createRun = async (symbol: string, id: string, date = "2026-07-09") => {
  const now = "2026-07-09T22:10:00.000Z";
  const tickers = new TickerRepository(env.DB);
  await tickers.insert({
    id,
    symbol,
    companyName: symbol,
    exchange: "NMS",
    currency: "USD",
    now,
  });
  const ticker = await tickers.findBySymbol(symbol);
  if (!ticker) throw new Error("ticker_missing");
  return new RunRepository(env.DB).createRun({
    tradingDate: date,
    origin: "scheduled",
    backfillJobId: null,
    tickers: [ticker],
    now,
  });
};

describe("Queue consumer", () => {
  it("acknowledges and persists a qualifying analysis", async () => {
    const run = await createRun("SHOP.TO", "shop");
    const [screeningId] = run.screeningIds;
    if (!screeningId) throw new Error("screening_missing");
    vi.spyOn(
      YahooMarketDataProvider.prototype,
      "getInstrument",
    ).mockResolvedValue({
      metadata: {
        symbol: "SHOP.TO",
        companyName: "Shopify Inc.",
        exchange: "TOR",
        currency: "CAD",
        instrumentType: "EQUITY",
      },
      bars: [
        { date: "2026-07-08", close: 100, adjustedClose: 100 },
        { date: "2026-07-09", close: 107, adjustedClose: 107 },
      ],
      corporateActionDates: new Set<string>(),
    });
    vi.spyOn(GoogleNewsProvider.prototype, "search").mockResolvedValue([
      {
        title: "Enterprise growth lifts Shopify",
        publisher: "Reuters",
        publishedAt: "2026-07-09T18:00:00.000Z",
        url: "https://news/1",
      },
    ]);
    vi.spyOn(
      WorkersAiExplanationProvider.prototype,
      "explain",
    ).mockResolvedValue({
      explanationZhCn: "企业客户增长可能推动股价上涨。",
      confidence: "high",
      clearCatalyst: true,
      sourceIndexes: [0],
      model: "test",
    });
    const message = {
      body: { screeningId, reportRunId: run.runId, tickerId: "shop" },
      ack: vi.fn(),
      retry: vi.fn(),
    } as unknown as Message<ScreeningJobMessage>;
    await handleQueue(
      { messages: [message] } as unknown as MessageBatch<ScreeningJobMessage>,
      env,
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT status FROM screenings WHERE id = ?1")
        .bind(run.screeningIds[0])
        .first(),
    ).toEqual({ status: "complete" });
    expect(
      await env.DB.prepare(
        "SELECT explanation_zh_cn FROM analyses WHERE screening_id = ?1",
      )
        .bind(run.screeningIds[0])
        .first(),
    ).toEqual({ explanation_zh_cn: "企业客户增长可能推动股价上涨。" });
  });

  it("retries a transient provider failure with backoff", async () => {
    const run = await createRun("AAPL", "retry-aapl", "2026-07-08");
    const [screeningId] = run.screeningIds;
    if (!screeningId) throw new Error("screening_missing");
    vi.spyOn(
      YahooMarketDataProvider.prototype,
      "getInstrument",
    ).mockRejectedValue(new Error("market_http_503"));
    const message = {
      body: {
        screeningId,
        reportRunId: run.runId,
        tickerId: "retry-aapl",
      },
      ack: vi.fn(),
      retry: vi.fn(),
    } as unknown as Message<ScreeningJobMessage>;
    await handleQueue(
      { messages: [message] } as unknown as MessageBatch<ScreeningJobMessage>,
      env,
    );
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
    expect(message.ack).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT status, attempt_count FROM screenings WHERE id = ?1",
      )
        .bind(run.screeningIds[0])
        .first(),
    ).toEqual({ status: "queued", attempt_count: 1 });
  });

  it("records and acknowledges a terminal provider failure", async () => {
    const run = await createRun("AAPL", "bad-aapl", "2026-07-07");
    const [screeningId] = run.screeningIds;
    if (!screeningId) throw new Error("screening_missing");
    vi.spyOn(
      YahooMarketDataProvider.prototype,
      "getInstrument",
    ).mockRejectedValue(new Error("market_schema"));
    const message = {
      body: {
        screeningId,
        reportRunId: run.runId,
        tickerId: "bad-aapl",
      },
      ack: vi.fn(),
      retry: vi.fn(),
    } as unknown as Message<ScreeningJobMessage>;
    await handleQueue(
      { messages: [message] } as unknown as MessageBatch<ScreeningJobMessage>,
      env,
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT status, error_code FROM screenings WHERE id = ?1",
      )
        .bind(run.screeningIds[0])
        .first(),
    ).toEqual({ status: "failed", error_code: "screening_failed" });
  });

  it("exhausts a transient provider retry on the third attempt", async () => {
    const run = await createRun("MSFT", "retry-msft", "2026-07-06");
    const [screeningId] = run.screeningIds;
    if (!screeningId) throw new Error("screening_missing");
    await env.DB.prepare(
      "UPDATE screenings SET attempt_count = 2 WHERE id = ?1",
    )
      .bind(screeningId)
      .run();
    vi.spyOn(
      YahooMarketDataProvider.prototype,
      "getInstrument",
    ).mockRejectedValue(new Error("market_http_503"));
    const message = {
      body: {
        screeningId,
        reportRunId: run.runId,
        tickerId: "retry-msft",
      },
      ack: vi.fn(),
      retry: vi.fn(),
    } as unknown as Message<ScreeningJobMessage>;
    await handleQueue(
      { messages: [message] } as unknown as MessageBatch<ScreeningJobMessage>,
      env,
    );
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT status, attempt_count FROM screenings WHERE id = ?1",
      )
        .bind(screeningId)
        .first(),
    ).toEqual({ status: "failed", attempt_count: 3 });
  });
});
