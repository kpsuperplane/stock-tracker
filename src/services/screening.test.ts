import { describe, expect, it, vi } from "vitest";
import { ScreeningService } from "./screening";

const work = {
  id: "screen-1",
  reportRunId: "run-1",
  symbol: "SHOP.TO",
  companyName: "Shopify Inc.",
  exchange: "TOR",
  currency: "CAD",
  targetDate: "2026-07-09",
  attemptCount: 1,
  previousDate: null,
  previousPrice: null,
  currentPrice: null,
  changeAmount: null,
  changePct: null,
  priceBasis: null,
  qualified: null,
};

const repository = () => ({
  claimScreening: vi.fn(async () => work),
  savePrice: vi.fn(),
  saveSources: vi.fn(),
  saveAnalysis: vi.fn(),
  saveScreeningResult: vi.fn(),
  completeWithoutAnalysis: vi.fn(),
  markNoTradingData: vi.fn(),
  markFailed: vi.fn(),
});

const series = (currentPrice = 107) => ({
  metadata: {
    symbol: "SHOP.TO",
    companyName: "Shopify Inc.",
    exchange: "TOR",
    currency: "CAD",
    instrumentType: "EQUITY" as const,
  },
  bars: [
    { date: "2026-07-08", close: 100, adjustedClose: 100 },
    {
      date: "2026-07-09",
      close: currentPrice,
      adjustedClose: currentPrice,
    },
  ],
  corporateActionDates: new Set<string>(),
});

describe("ScreeningService", () => {
  it("stores a qualifying movement, exact news window, sources, and Chinese analysis", async () => {
    const repo = repository();
    const market = { getInstrument: vi.fn(async () => series()) };
    const sources = [
      {
        title: "Enterprise growth lifts Shopify",
        publisher: "Reuters",
        publishedAt: "2026-07-09T18:00:00.000Z",
        url: "https://news/1",
      },
    ];
    const news = { search: vi.fn(async () => sources) };
    const result = {
      explanationZhCn: "企业客户增长可能推动股价上涨。",
      model: "test",
    };
    const explanation = { explain: vi.fn(async () => result) };
    await new ScreeningService(repo, market, news, explanation).process(
      "screen-1",
      "2026-07-09T22:10:00.000Z",
    );
    expect(repo.savePrice).toHaveBeenCalledWith(
      "screen-1",
      expect.objectContaining({ qualified: true }),
    );
    expect(repo.savePrice.mock.calls[0]?.[1]?.changePct).toBeCloseTo(7, 12);
    expect(news.search).toHaveBeenCalledWith(
      expect.objectContaining({
        publishedAfter: "2026-07-08T20:00:00.000Z",
        publishedBefore: "2026-07-09T22:00:00.000Z",
      }),
    );
    expect(repo.saveScreeningResult).toHaveBeenCalledWith(
      "screen-1",
      sources,
      result,
      "2026-07-09T22:10:00.000Z",
    );
    expect(repo.saveSources).not.toHaveBeenCalled();
    expect(repo.saveAnalysis).not.toHaveBeenCalled();
  });

  it("records no trading data without calling news", async () => {
    const repo = repository();
    const market = {
      getInstrument: vi.fn(async () => ({ ...series(), bars: [] })),
    };
    const news = { search: vi.fn() };
    const explanation = { explain: vi.fn() };
    await new ScreeningService(repo, market, news, explanation).process(
      "screen-1",
      "2026-07-09T22:10:00.000Z",
    );
    expect(repo.markNoTradingData).toHaveBeenCalledWith(
      "screen-1",
      "no_trading_data",
    );
    expect(news.search).not.toHaveBeenCalled();
  });

  it("completes a non-qualifying move without news or AI", async () => {
    const repo = repository();
    const news = { search: vi.fn() };
    const explanation = { explain: vi.fn() };
    await new ScreeningService(
      repo,
      { getInstrument: vi.fn(async () => series(104.99)) },
      news,
      explanation,
    ).process("screen-1", "2026-07-09T22:10:00.000Z");
    expect(repo.completeWithoutAnalysis).toHaveBeenCalledWith("screen-1");
    expect(news.search).not.toHaveBeenCalled();
    expect(explanation.explain).not.toHaveBeenCalled();
  });

  it("ignores a duplicate delivery that cannot claim work", async () => {
    const repo = { ...repository(), claimScreening: vi.fn(async () => null) };
    const market = { getInstrument: vi.fn() };
    const result = await new ScreeningService(
      repo,
      market,
      { search: vi.fn() },
      { explain: vi.fn() },
    ).process("screen-1", "2026-07-09T22:10:00.000Z");
    expect(result).toBeNull();
    expect(market.getInstrument).not.toHaveBeenCalled();
  });

  it("retries only news and analysis when a qualifying price result is stored", async () => {
    const repo = {
      ...repository(),
      claimScreening: vi.fn(async () => ({
        ...work,
        previousDate: "2026-07-08",
        previousPrice: 100,
        currentPrice: 107,
        changeAmount: 7,
        changePct: 7,
        priceBasis: "adjusted" as const,
        qualified: true,
      })),
    };
    const market = { getInstrument: vi.fn() };
    const news = { search: vi.fn(async () => []) };
    const explanation = {
      explain: vi.fn(async () => ({
        explanationZhCn: "未找到相关新闻，因此无法确定明确催化因素。",
        model: "deterministic-no-sources",
      })),
    };
    await new ScreeningService(repo, market, news, explanation).process(
      "screen-1",
      "2026-07-10T22:10:00.000Z",
    );
    expect(market.getInstrument).not.toHaveBeenCalled();
    expect(repo.savePrice).not.toHaveBeenCalled();
    expect(repo.saveScreeningResult).toHaveBeenCalledOnce();
  });

  it("keeps persisted sources untouched when explanation generation fails", async () => {
    const repo = {
      ...repository(),
      claimScreening: vi.fn(async () => ({
        ...work,
        previousDate: "2026-07-08",
        previousPrice: 100,
        currentPrice: 107,
        changeAmount: 7,
        changePct: 7,
        priceBasis: "adjusted" as const,
        qualified: true,
      })),
    };
    const news = {
      search: vi.fn(async () => [
        {
          title: "New source",
          publisher: "Reuters",
          publishedAt: "2026-07-09T18:00:00.000Z",
          url: "https://news/new",
        },
      ]),
    };
    const explanation = {
      explain: vi.fn(async () => {
        throw new Error("ai_unavailable");
      }),
    };

    await expect(
      new ScreeningService(
        repo,
        { getInstrument: vi.fn() },
        news,
        explanation,
      ).process("screen-1", "2026-07-10T22:10:00.000Z"),
    ).rejects.toThrow("ai_unavailable");

    expect(repo.saveSources).not.toHaveBeenCalled();
    expect(repo.saveScreeningResult).not.toHaveBeenCalled();
  });
});
