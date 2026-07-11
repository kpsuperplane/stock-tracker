import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type {
  DividendEventRange,
  DividendProvider,
} from "../../src/providers/dividends";
import type {
  ExplanationProvider,
  ExplanationResult,
} from "../../src/providers/explanations";
import type { NewsItem, NewsProvider } from "../../src/providers/news";
import {
  AnalysisFactsService,
  DividendFactsService,
  MarketFactsPersistenceService,
} from "../../src/services/fact-persistence";
import type { NormalizedMarketFact } from "../../src/services/market-facts";

const now = "2026-07-10T22:00:00.000Z";

async function insertInstrument(id = "instrument-1"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO instruments
     (id, symbol, company_name, exchange, currency, instrument_type,
      provider, provider_symbol, created_at, updated_at)
     VALUES (?1, ?2, 'Case Corp', 'NYSE', 'USD', 'stock',
             'yahoo', ?2, ?3, ?3)`,
  )
    .bind(id, `CASE-${id}`, now)
    .run();
}

const marketFact = (
  date: string,
  overrides: Partial<NormalizedMarketFact> = {},
): NormalizedMarketFact => ({
  id: `instrument-1:${date}`,
  instrumentId: "instrument-1",
  tradingDate: date,
  previousTradingDate: "2026-07-09",
  previousRawCloseDecimal: "100",
  currentRawCloseDecimal: "110",
  crossingSplitNumerator: "1",
  crossingSplitDenominator: "1",
  splitAdjustedPreviousCloseDecimal: "100",
  movementAmountDecimal: "10",
  movementPercentDecimal: "10",
  rawCloseDifferenceDecimal: "10",
  movementBasis: "split_adjusted_price_return",
  provider: "yahoo-chart-v8",
  providerRevision: "market-r1",
  retrievedAt: now,
  freshness: "fresh",
  status: "valid",
  errorCode: null,
  errorMessage: null,
  ...overrides,
});

const dividendRange = (
  events: DividendEventRange["events"],
  revision = "dividend-r1",
  requestedStartDate = "2026-01-01",
  requestedEndDate = "2026-12-31",
  provider = "alpha-vantage-dividends",
): DividendEventRange => ({
  symbol: "CASE-INSTRUMENT-1",
  range: {
    requestedStartDate,
    requestedEndDate,
    coverageStartDate: null,
    coverageEndDate: null,
    isComplete: false,
    basis: "source-reported",
    provider,
    observedAt: now,
    providerRevision: revision,
  },
  events,
});

const dividendEvent = (
  amount: string,
  revision: string,
  exDate = "2026-08-01",
  declarationDate = "2026-07-01",
  provider = "alpha-vantage-dividends",
) => ({
  type: "dividend" as const,
  symbol: "CASE-INSTRUMENT-1",
  exDate,
  amount,
  currency: "USD",
  provider,
  providerEventId: `${provider}:CASE-INSTRUMENT-1:dividend:${exDate}:${declarationDate}`,
  providerRevision: revision,
});

const newsItem = (url = "https://example.com/news"): NewsItem => ({
  title: "Case Corp reports results",
  publisher: "Example News",
  publishedAt: "2026-07-10T15:00:00.000Z",
  url,
  description: "Quarterly results update",
});

const explanation: ExplanationResult = {
  explanationZhCn: "公司发布了季度业绩更新。",
  model: "test-model",
};

describe("normalized fact persistence", () => {
  it("atomically persists market facts and only bumps affected buckets", async () => {
    await insertInstrument();
    const service = new MarketFactsPersistenceService(
      env.DB,
      () => new Date(now),
    );

    await service.persist({
      facts: [
        marketFact("2026-07-10"),
        marketFact("2026-06-05", {
          id: "instrument-1:2026-06-05",
          tradingDate: "2026-06-05",
          previousTradingDate: null,
          previousRawCloseDecimal: null,
          splitAdjustedPreviousCloseDecimal: null,
          movementAmountDecimal: null,
          movementPercentDecimal: null,
        }),
      ],
      latestTradingDate: "2026-07-10",
    });
    expect(
      await env.DB.prepare(
        "SELECT revision FROM fact_revision_buckets WHERE bucket_key = 'latest'",
      ).first(),
    ).toEqual({ revision: 1 });
    expect(
      await env.DB.prepare(
        "SELECT revision FROM fact_revision_buckets WHERE bucket_key = '2026-06'",
      ).first(),
    ).toEqual({ revision: 1 });
    expect(
      await env.DB.prepare(
        "SELECT revision FROM fact_revision_buckets WHERE bucket_key = '2026-07'",
      ).first(),
    ).toBeNull();

    await service.persist({
      facts: [
        marketFact("2026-06-06", {
          id: "instrument-1:2026-06-06",
          tradingDate: "2026-06-06",
          previousTradingDate: null,
          previousRawCloseDecimal: null,
          splitAdjustedPreviousCloseDecimal: null,
          movementAmountDecimal: null,
          movementPercentDecimal: null,
        }),
      ],
      latestTradingDate: "2026-07-10",
    });
    expect(
      await env.DB.prepare(
        "SELECT revision FROM fact_revision_buckets WHERE bucket_key = 'latest'",
      ).first(),
    ).toEqual({ revision: 1 });
    expect(
      await env.DB.prepare(
        "SELECT revision FROM fact_revision_buckets WHERE bucket_key = '2026-06'",
      ).first(),
    ).toEqual({ revision: 2 });
  });

  it("rolls back fact rows and buckets together when a later fact is invalid", async () => {
    await insertInstrument();
    const service = new MarketFactsPersistenceService(
      env.DB,
      () => new Date(now),
    );
    await expect(
      service.persist({
        facts: [
          marketFact("2026-07-10"),
          marketFact("2026-07-09", {
            id: "instrument-1:2026-07-09",
            tradingDate: "2026-07-09",
            crossingSplitNumerator: "not-an-integer",
          }),
        ],
        latestTradingDate: "2026-07-10",
      }),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM daily_market_facts",
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM fact_revision_buckets",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("marks an existing market fact error while retaining its last valid close on refresh failure", async () => {
    await insertInstrument();
    const service = new MarketFactsPersistenceService(
      env.DB,
      () => new Date(now),
    );
    await service.persist({
      facts: [marketFact("2026-07-10")],
      latestTradingDate: "2026-07-10",
    });
    const result = await service.persistResult({
      facts: [],
      errors: [
        {
          id: "instrument-1:2026-07-10",
          instrumentId: "instrument-1",
          tradingDate: "2026-07-10",
          previousTradingDate: null,
          previousRawCloseDecimal: null,
          currentRawCloseDecimal: null,
          provider: "yahoo-chart-v8",
          providerRevision: "market-r2",
          retrievedAt: now,
          freshness: "fresh",
          status: "error",
          persistable: false,
          errorCode: "provider_http_503",
          errorMessage: "provider unavailable",
        },
      ],
      latestTradingDate: "2026-07-10",
    });
    expect(result.preservedErrors[0]?.preserved).toBe(true);
    expect(
      await env.DB.prepare(
        `SELECT current_raw_close_decimal, status, error_code
         FROM daily_market_facts WHERE id = 'instrument-1:2026-07-10'`,
      ).first(),
    ).toEqual({
      current_raw_close_decimal: "110",
      status: "error",
      error_code: "provider_http_503",
    });
  });

  it("uses Toronto calendar date when an omitted latest date crosses UTC midnight", async () => {
    await insertInstrument();
    const service = new MarketFactsPersistenceService(
      env.DB,
      () => new Date("2026-07-11T02:00:00.000Z"),
    );
    await service.persist({ facts: [marketFact("2026-07-10")] });
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
  });

  it("keeps source-reported future dividends truthful, corrects identities, and preserves rows on failure", async () => {
    await insertInstrument();
    let current: DividendEventRange = dividendRange([
      dividendEvent("0.25", "event-r1"),
    ]);
    const provider: DividendProvider = {
      getDividends: vi.fn(async () => current),
    };
    const service = new DividendFactsService({
      db: env.DB,
      provider,
      now: () => new Date(now),
    });

    const first = await service.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(first).toMatchObject({
      kind: "refreshed",
      incompleteHistoryWarning: true,
      noAnnouncedEventCurrentlyKnown: false,
    });
    expect(
      await env.DB.prepare(
        "SELECT amount_per_share_decimal, status FROM dividend_events",
      ).first(),
    ).toEqual({ amount_per_share_decimal: "0.25", status: "active" });
    expect(
      await env.DB.prepare(
        "SELECT revision FROM fact_revision_buckets WHERE bucket_key = '2026-08'",
      ).first(),
    ).toEqual({ revision: 1 });

    current = dividendRange([dividendEvent("0.30", "event-r2")], "dividend-r2");
    const corrected = await service.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(corrected.kind).toBe("refreshed");
    expect(
      await env.DB.prepare(
        "SELECT amount_per_share_decimal, status FROM dividend_events ORDER BY amount_per_share_decimal",
      ).all(),
    ).toMatchObject({
      results: [
        { amount_per_share_decimal: "0.25", status: "superseded" },
        { amount_per_share_decimal: "0.3", status: "active" },
      ],
    });

    current = dividendRange([]);
    const missing = await service.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(missing).toMatchObject({
      kind: "refreshed",
      noAnnouncedEventCurrentlyKnown: true,
      incompleteHistoryWarning: true,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM dividend_events WHERE status = 'active'",
      ).first(),
    ).toEqual({ count: 1 });

    current = {
      ...current,
      range: { ...current.range, providerRevision: "failed" },
    };
    (provider.getDividends as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("provider_http_429"),
    );
    const failed = await service.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(failed).toEqual({
      kind: "provider_unavailable",
      code: "provider_http_429",
      preserved: true,
    });
    expect(
      await env.DB.prepare(
        `SELECT amount_per_share_decimal, status, error_code
         FROM dividend_events WHERE status = 'error'`,
      ).first(),
    ).toEqual({
      amount_per_share_decimal: "0.3",
      status: "error",
      error_code: "provider_http_429",
    });
  });

  it("quarantines a provider identity correction across ex-date months", async () => {
    await insertInstrument();
    let current: DividendEventRange = dividendRange([
      dividendEvent("0.25", "event-r1", "2026-06-30"),
    ]);
    const provider: DividendProvider = {
      getDividends: vi.fn(async () => current),
    };
    const service = new DividendFactsService({
      db: env.DB,
      provider,
      now: () => new Date(now),
    });
    const first = await service.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(first).toMatchObject({
      kind: "refreshed",
      noAnnouncedEventCurrentlyKnown: true,
    });
    current = dividendRange([dividendEvent("0.25", "event-r2", "2026-08-01")]);
    const corrected = await service.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(corrected).toMatchObject({
      kind: "refreshed",
      correctionConflict: true,
    });
    expect(
      await env.DB.prepare(
        `SELECT ex_date, status, error_code FROM dividend_events
         ORDER BY ex_date`,
      ).all(),
    ).toMatchObject({
      results: [
        { ex_date: "2026-06-30", status: "superseded", error_code: null },
        {
          ex_date: "2026-08-01",
          status: "error",
          error_code: "provider_identity_changed",
        },
      ],
    });
    expect(
      await env.DB.prepare(
        "SELECT bucket_key FROM fact_revision_buckets ORDER BY bucket_key",
      ).all(),
    ).toMatchObject({
      results: [{ bucket_key: "2026-06" }, { bucket_key: "2026-08" }],
    });
    const repeated = await service.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(repeated).toMatchObject({
      kind: "refreshed",
      correctionConflict: true,
    });
    expect(
      await env.DB.prepare(
        "SELECT ex_date, status, error_code FROM dividend_events ORDER BY ex_date",
      ).all(),
    ).toMatchObject({
      results: [
        { ex_date: "2026-06-30", status: "superseded", error_code: null },
        {
          ex_date: "2026-08-01",
          status: "error",
          error_code: "provider_identity_changed",
        },
      ],
    });
    current = dividendRange([
      dividendEvent("0.25", "event-r2", "2026-08-01"),
      dividendEvent("0.4", "event-r3", "2026-08-01", "2026-07-02"),
    ]);
    const legitimateNewIdentity = await service.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(legitimateNewIdentity).toMatchObject({
      kind: "refreshed",
      correctionConflict: true,
    });
    expect(
      await env.DB.prepare(
        "SELECT provider_event_id, status, error_code FROM dividend_events ORDER BY provider_event_id, provider_revision",
      ).all(),
    ).toMatchObject({
      results: [
        {
          provider_event_id:
            "alpha-vantage-dividends:CASE-INSTRUMENT-1:dividend:2026-06-30:2026-07-01",
          status: "superseded",
          error_code: null,
        },
        {
          provider_event_id:
            "alpha-vantage-dividends:CASE-INSTRUMENT-1:dividend:2026-08-01:2026-07-01",
          status: "error",
          error_code: "provider_identity_changed",
        },
        {
          provider_event_id:
            "alpha-vantage-dividends:CASE-INSTRUMENT-1:dividend:2026-08-01:2026-07-02",
          status: "active",
          error_code: null,
        },
      ],
    });
  });

  it("does not infer missing future dividends from a wholly historical range", async () => {
    await insertInstrument();
    const provider: DividendProvider = {
      getDividends: vi.fn(async () =>
        dividendRange([], "historical-r1", "2026-01-01", "2026-06-30"),
      ),
    };
    const service = new DividendFactsService({
      db: env.DB,
      provider,
      now: () => new Date(now),
    });
    const result = await service.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-06-30",
    });
    expect(result).toMatchObject({
      kind: "refreshed",
      noAnnouncedEventCurrentlyKnown: false,
    });
  });

  it("keeps same-ex-date dividends with distinct declaration identities active", async () => {
    await insertInstrument();
    const firstEvent = dividendEvent(
      "0.25",
      "event-a-r1",
      "2026-08-01",
      "2026-07-01",
    );
    let current = dividendRange([firstEvent]);
    const provider: DividendProvider = {
      getDividends: vi.fn(async () => current),
    };
    const service = new DividendFactsService({
      db: env.DB,
      provider,
      now: () => new Date(now),
    });
    await service.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    current = dividendRange([
      firstEvent,
      dividendEvent("0.3", "event-b-r1", "2026-08-01", "2026-07-02"),
    ]);
    const result = await service.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(result).toMatchObject({
      kind: "refreshed",
      correctionConflict: false,
    });
    expect(
      await env.DB.prepare(
        "SELECT provider_event_id, status FROM dividend_events ORDER BY provider_event_id",
      ).all(),
    ).toMatchObject({
      results: [
        {
          provider_event_id:
            "alpha-vantage-dividends:CASE-INSTRUMENT-1:dividend:2026-08-01:2026-07-01",
          status: "active",
        },
        {
          provider_event_id:
            "alpha-vantage-dividends:CASE-INSTRUMENT-1:dividend:2026-08-01:2026-07-02",
          status: "active",
        },
      ],
    });
  });

  it("marks affected rows on an invalid provider snapshot without touching another provider", async () => {
    await insertInstrument();
    let alphaCurrent = dividendRange([
      dividendEvent("0.25", "alpha-r1", "2026-06-30"),
    ]);
    const alphaProvider: DividendProvider = {
      getDividends: vi.fn(async () => alphaCurrent),
    };
    const alphaService = new DividendFactsService({
      db: env.DB,
      provider: alphaProvider,
      now: () => new Date(now),
    });
    await alphaService.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    const betaProvider: DividendProvider = {
      getDividends: vi.fn(async () =>
        dividendRange(
          [
            dividendEvent(
              "0.2",
              "beta-r1",
              "2026-07-20",
              "2026-07-01",
              "beta-dividends",
            ),
          ],
          "beta-r1",
          "2026-01-01",
          "2026-12-31",
          "beta-dividends",
        ),
      ),
    };
    const betaService = new DividendFactsService({
      db: env.DB,
      provider: betaProvider,
      now: () => new Date(now),
    });
    await betaService.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });

    alphaCurrent = dividendRange(
      [dividendEvent("0.25", "alpha-r1", "2026-06-30")],
      "alpha-invalid",
      "2026-01-01",
      "2026-06-30",
    );
    const invalid = await alphaService.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(invalid).toEqual({
      kind: "provider_invalid",
      code: "provider_snapshot_mismatch",
      preserved: true,
    });
    expect(
      await env.DB.prepare(
        "SELECT provider, status, error_code FROM dividend_events ORDER BY provider",
      ).all(),
    ).toMatchObject({
      results: [
        {
          provider: "alpha-vantage-dividends",
          status: "error",
          error_code: "provider_snapshot_mismatch",
        },
        { provider: "beta-dividends", status: "active", error_code: null },
      ],
    });
    expect(
      await env.DB.prepare(
        "SELECT bucket_key, revision FROM fact_revision_buckets ORDER BY bucket_key",
      ).all(),
    ).toMatchObject({
      results: [
        { bucket_key: "2026-06", revision: 2 },
        { bucket_key: "2026-07", revision: 1 },
      ],
    });
  });

  it("does not quarantine unmatched future dividends from an incomplete source range", async () => {
    await insertInstrument();
    let current = dividendRange([
      dividendEvent("0.25", "future-r1", "2026-08-01", "2026-07-01"),
    ]);
    const provider: DividendProvider = {
      getDividends: vi.fn(async () => current),
    };
    const service = new DividendFactsService({
      db: env.DB,
      provider,
      now: () => new Date(now),
    });
    await service.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    current = dividendRange([
      dividendEvent("0.3", "future-r2", "2026-09-01", "2026-08-01"),
    ]);
    const result = await service.refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(result).toMatchObject({
      kind: "refreshed",
      correctionConflict: false,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM dividend_events WHERE status = 'active'",
      ).first(),
    ).toEqual({ count: 2 });
  });

  it("does not mark every provider when a refresh fails before provider identity is known", async () => {
    await insertInstrument();
    const seed = async (
      provider: string,
      eventDate: string,
      eventRevision: string,
    ) => {
      const event = dividendEvent(
        "0.25",
        eventRevision,
        eventDate,
        "2026-07-01",
        provider,
      );
      const seededProvider: DividendProvider = {
        getDividends: vi.fn(async () =>
          dividendRange(
            [event],
            `${provider}-range-r1`,
            "2026-01-01",
            "2026-12-31",
            provider,
          ),
        ),
      };
      await new DividendFactsService({
        db: env.DB,
        provider: seededProvider,
        now: () => new Date(now),
      }).refresh({
        instrumentId: "instrument-1",
        symbol: "CASE-INSTRUMENT-1",
        startDate: "2026-01-01",
        endDate: "2026-12-31",
      });
    };
    await seed("alpha-vantage-dividends", "2026-06-30", "alpha-r1");
    await seed("beta-dividends", "2026-07-20", "beta-r1");

    const failingProvider: DividendProvider = {
      getDividends: vi.fn(async () => {
        throw new Error("provider_http_503");
      }),
    };
    const result = await new DividendFactsService({
      db: env.DB,
      provider: failingProvider,
      now: () => new Date(now),
    }).refresh({
      instrumentId: "instrument-1",
      symbol: "CASE-INSTRUMENT-1",
      startDate: "2026-01-01",
      endDate: "2026-12-31",
    });
    expect(result).toEqual({
      kind: "provider_unavailable",
      code: "provider_http_503",
      preserved: true,
    });
    expect(
      await env.DB.prepare(
        "SELECT provider, status, error_code FROM dividend_events ORDER BY provider",
      ).all(),
    ).toMatchObject({
      results: [
        {
          provider: "alpha-vantage-dividends",
          status: "active",
          error_code: null,
        },
        { provider: "beta-dividends", status: "active", error_code: null },
      ],
    });
  });

  it("reuses analyses for unchanged dependencies, invalidates on movement changes, and preserves last valid summaries on failure", async () => {
    await insertInstrument();
    const marketService = new MarketFactsPersistenceService(
      env.DB,
      () => new Date(now),
    );
    const fact = marketFact("2026-07-10");
    await marketService.persist({
      facts: [fact],
      latestTradingDate: "2026-07-10",
    });
    const newsProvider: NewsProvider = {
      search: vi.fn(async () => [
        {
          ...newsItem(" HTTPS://EXAMPLE.COM:443/news "),
          title: "  Case Corp reports results  ",
          publisher: " Example News ",
        },
      ]),
    };
    const explanationProvider: ExplanationProvider = {
      explain: vi.fn(async () => explanation),
    };
    const service = new AnalysisFactsService({
      db: env.DB,
      newsProvider,
      explanationProvider,
      now: () => new Date(now),
    });

    const first = await service.refresh({
      fact,
      symbol: "CASE-INSTRUMENT-1",
      companyName: "Case Corp",
      publishedAfter: "2026-07-09T00:00:00.000Z",
      publishedBefore: now,
    });
    expect(first.kind).toBe("refreshed");
    expect(explanationProvider.explain).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        "SELECT title, publisher, source_url FROM news_sources",
      ).first(),
    ).toEqual({
      title: "Case Corp reports results",
      publisher: "Example News",
      source_url: "https://example.com/news",
    });

    const historicalFact = marketFact("2026-06-05", {
      id: "instrument-1:2026-06-05",
      tradingDate: "2026-06-05",
      previousTradingDate: null,
      previousRawCloseDecimal: null,
      splitAdjustedPreviousCloseDecimal: null,
      movementAmountDecimal: null,
      movementPercentDecimal: null,
    });
    await marketService.persist({
      facts: [historicalFact],
      latestTradingDate: "2026-07-10",
    });
    const historical = await service.refresh({
      fact: historicalFact,
      symbol: "CASE-INSTRUMENT-1",
      companyName: "Case Corp",
      publishedAfter: "2026-06-04T00:00:00.000Z",
      publishedBefore: "2026-06-06T00:00:00.000Z",
      latestTradingDate: "2026-07-10",
    });
    expect(historical.kind).toBe("refreshed");
    expect(
      await env.DB.prepare(
        "SELECT revision FROM fact_revision_buckets WHERE bucket_key = 'latest'",
      ).first(),
    ).toEqual({ revision: 2 });
    expect(
      await env.DB.prepare(
        "SELECT revision FROM fact_revision_buckets WHERE bucket_key = '2026-06'",
      ).first(),
    ).toEqual({ revision: 2 });

    const reused = await service.refresh({
      fact,
      symbol: "CASE-INSTRUMENT-1",
      companyName: "Case Corp",
      publishedAfter: "2026-07-09T00:00:00.000Z",
      publishedBefore: now,
    });
    expect(reused.kind).toBe("reused");
    expect(explanationProvider.explain).toHaveBeenCalledTimes(2);

    const changedFact = marketFact("2026-07-10", {
      providerRevision: "market-r2",
      movementPercentDecimal: "12",
    });
    const changed = await service.refresh({
      fact: changedFact,
      symbol: "CASE-INSTRUMENT-1",
      companyName: "Case Corp",
      publishedAfter: "2026-07-09T00:00:00.000Z",
      publishedBefore: now,
    });
    expect(changed.kind).toBe("refreshed");
    expect(explanationProvider.explain).toHaveBeenCalledTimes(3);

    (
      explanationProvider.explain as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("ai_unavailable"));
    const failed = await service.refresh({
      fact: { ...changedFact, providerRevision: "market-r3" },
      symbol: "CASE-INSTRUMENT-1",
      companyName: "Case Corp",
      publishedAfter: "2026-07-09T00:00:00.000Z",
      publishedBefore: now,
    });
    expect(failed).toMatchObject({ kind: "error", preserved: true });
    expect(
      await env.DB.prepare(
        "SELECT status, summary_zh_cn, error_code FROM movement_analyses",
      ).first(),
    ).toEqual({
      status: "error",
      summary_zh_cn: explanation.explanationZhCn,
      error_code: "ai_unavailable",
    });
    (newsProvider.search as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      newsItem("javascript:alert(1)"),
    ]);
    expect(
      await service.refresh({
        fact: changedFact,
        symbol: "CASE-INSTRUMENT-1",
        companyName: "Case Corp",
        publishedAfter: "2026-07-09T00:00:00.000Z",
        publishedBefore: now,
      }),
    ).toMatchObject({
      kind: "error",
      code: "unsafe_source_url",
      preserved: true,
    });
  });
});
