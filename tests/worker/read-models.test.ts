import { env, exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AccountRepository } from "../../src/db/accounts";
import { WorkItemRepository } from "../../src/db/work-items";
import type { Env } from "../../src/worker/env";

const now = "2026-07-10T12:00:00.000Z";
const authorization = `Basic ${btoa("owner:password")}`;

const insertInstrument = async (input: {
  id: string;
  symbol: string;
  currency: "CAD" | "USD";
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO instruments
     (id, symbol, company_name, exchange, currency, instrument_type,
      provider, provider_symbol, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'stock', 'yahoo', ?2, ?6, ?6)`,
  )
    .bind(
      input.id,
      input.symbol,
      `${input.symbol} Corp`,
      input.currency === "CAD" ? "TSX" : "NYSE",
      input.currency,
      now,
    )
    .run();
};

const insertTransaction = async (input: {
  id: string;
  instrumentId: string;
  accountId?: string;
  date?: string;
  quantity: string;
  price?: string;
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO transactions
     (id, instrument_id, account_id, trade_date, side, quantity_decimal,
      price_decimal, revision, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'buy', ?5, ?6, 1, ?7, ?7)`,
  )
    .bind(
      input.id,
      input.instrumentId,
      input.accountId ?? "account-default",
      input.date ?? "2026-01-02",
      input.quantity,
      input.price ?? "10",
      now,
    )
    .run();
};

const insertFact = async (input: {
  id: string;
  instrumentId: string;
  date: string;
  previous: string;
  current: string;
  pct: string;
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO daily_market_facts
     (id, instrument_id, trading_date, previous_trading_date,
      previous_raw_close_decimal, current_raw_close_decimal,
      crossing_split_numerator, crossing_split_denominator,
      split_adjusted_previous_close_decimal, movement_amount_decimal,
      movement_percent_decimal, raw_close_difference_decimal, movement_basis,
      provider, provider_revision, retrieved_at, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, date(?3, '-1 day'), ?4, ?5, '1', '1', ?4,
             (?5 - ?4), ?6, (?5 - ?4), 'split_adjusted_price_return',
             'yahoo', 'r1', ?7, 'valid', ?7, ?7)`,
  )
    .bind(
      input.id,
      input.instrumentId,
      input.date,
      input.previous,
      input.current,
      input.pct,
      now,
    )
    .run();
};

describe("portfolio and calendar read models", () => {
  beforeEach(() => {
    (env as unknown as Env).READ_MODELS_ENABLED = "true";
  });

  afterEach(() => {
    delete (env as unknown as Record<string, unknown>).READ_MODELS_ENABLED;
  });

  it("keeps new read models disabled until explicitly enabled", async () => {
    delete (env as unknown as Record<string, unknown>).READ_MODELS_ENABLED;
    const response = await exports.default.fetch(
      new Request("http://local/api/portfolio", {
        headers: { Authorization: authorization },
      }),
    );
    expect(response.status).toBe(404);
    expect(
      (await response.json<{ error: { code: string } }>()).error.code,
    ).toBe("read_model_disabled");
  });

  it("uses the staged read flag when legacy preview aliases are absent", async () => {
    const mutable = env as unknown as Record<string, unknown>;
    delete mutable.READ_MODELS_ENABLED;
    mutable.PORTFOLIO_NEW_READS_ENABLED = "true";
    const response = await exports.default.fetch(
      new Request("http://local/api/portfolio", {
        headers: { Authorization: authorization },
      }),
    );
    expect(response.status).toBe(200);
    mutable.PORTFOLIO_NEW_READS_ENABLED = "false";
  });

  it("installs date-leading range indexes for calendar reads", async () => {
    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "daily_market_facts_date_instrument_idx",
        "dividend_events_ex_date_instrument_idx",
        "earnings_events_report_date_instrument_idx",
        "work_items_fact_date_idx",
      ]),
    );
  });

  it("scopes portfolio and calendar representations to an account", async () => {
    const accounts = new AccountRepository(env.DB);
    await accounts.insertCategory({
      id: "scope-category",
      name: "Scope Category",
      sortOrder: 1,
      now,
    });
    await accounts.insertAccount({
      id: "scope-account-one",
      categoryId: "scope-category",
      name: "Account One",
      owner: "Kevin",
      sortOrder: 0,
      now,
    });
    await accounts.insertAccount({
      id: "scope-account-two",
      categoryId: "scope-category",
      name: "Account Two",
      owner: "kevin",
      sortOrder: 1,
      now,
    });
    await insertInstrument({
      id: "scope-instrument-one",
      symbol: "SCOPE.ONE",
      currency: "CAD",
    });
    await insertInstrument({
      id: "scope-instrument-two",
      symbol: "SCOPE.TWO",
      currency: "CAD",
    });
    await insertTransaction({
      id: "scope-buy-one",
      instrumentId: "scope-instrument-one",
      accountId: "scope-account-one",
      quantity: "10",
    });
    await insertTransaction({
      id: "scope-buy-two",
      instrumentId: "scope-instrument-two",
      accountId: "scope-account-two",
      quantity: "20",
    });
    await insertFact({
      id: "scope-fact-one",
      instrumentId: "scope-instrument-one",
      date: "2026-07-09",
      previous: "10",
      current: "11",
      pct: "10",
    });
    await insertFact({
      id: "scope-fact-two",
      instrumentId: "scope-instrument-two",
      date: "2026-07-09",
      previous: "20",
      current: "21",
      pct: "5",
    });

    const accountPortfolio = await exports.default.fetch(
      new Request(
        "http://local/api/portfolio?today=2026-07-10&scopeType=account&scopeId=scope-account-one",
        { headers: { Authorization: authorization } },
      ),
    );
    expect(accountPortfolio.status).toBe(200);
    const portfolioPayload = await accountPortfolio.json<{
      portfolio: {
        positions: Array<{ symbol: string; quantityDecimal: string }>;
      };
    }>();
    expect(portfolioPayload.portfolio.positions).toEqual([
      expect.objectContaining({ symbol: "SCOPE.ONE", quantityDecimal: "10" }),
    ]);

    const ownerPortfolio = await exports.default.fetch(
      new Request(
        "http://local/api/portfolio?today=2026-07-10&scopeType=owner&scopeId=Kevin",
        { headers: { Authorization: authorization } },
      ),
    );
    expect(ownerPortfolio.status).toBe(200);
    expect(
      (
        await ownerPortfolio.json<{
          portfolio: { positions: Array<{ symbol: string }> };
        }>()
      ).portfolio.positions.map(({ symbol }) => symbol),
    ).toEqual(["SCOPE.ONE"]);

    const categoryCalendar = await exports.default.fetch(
      new Request(
        "http://local/api/calendar?startDate=2026-07-01&endDate=2026-07-31&asOfDate=2026-07-10&scopeType=category&scopeId=scope-category",
        { headers: { Authorization: authorization } },
      ),
    );
    expect(categoryCalendar.status).toBe(200);
    const calendarPayload = await categoryCalendar.json<{
      calendar: { movers: Array<{ symbol: string }> };
    }>();
    expect(calendarPayload.calendar.movers.map(({ symbol }) => symbol)).toEqual(
      expect.arrayContaining(["SCOPE.ONE", "SCOPE.TWO"]),
    );

    const events = await exports.default.fetch(
      new Request(
        "http://local/api/events?scopeType=account&scopeId=scope-account-two",
        { headers: { Authorization: authorization } },
      ),
    );
    expect(events.status).toBe(200);
    const eventPayload = await events.json<{
      events: Array<{ type: string; symbol: string; accountId?: string }>;
    }>();
    expect(eventPayload.events).toEqual([
      expect.objectContaining({
        type: "transaction",
        symbol: "SCOPE.TWO",
        accountId: "scope-account-two",
      }),
    ]);

    const ownerEvents = await exports.default.fetch(
      new Request("http://local/api/events?scopeType=owner&scopeId=Kevin", {
        headers: { Authorization: authorization },
      }),
    );
    expect(ownerEvents.status).toBe(200);
    expect(
      (
        await ownerEvents.json<{
          events: Array<{ symbol: string; accountId?: string }>;
        }>()
      ).events,
    ).toEqual([
      expect.objectContaining({
        symbol: "SCOPE.ONE",
        accountId: "scope-account-one",
      }),
    ]);
  });

  it("drives latest fact lookups from held instruments", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN
         WITH held_instruments AS (
           SELECT DISTINCT instrument_id FROM transactions
         ),
         latest_dates AS (
           SELECT held.instrument_id,
                  (SELECT candidate.trading_date
                     FROM daily_market_facts candidate
                    WHERE candidate.instrument_id = held.instrument_id
                      AND candidate.trading_date <= ?1
                    ORDER BY candidate.trading_date DESC
                    LIMIT 1) AS trading_date
             FROM held_instruments held
         )
         SELECT f.id
           FROM latest_dates latest
           JOIN daily_market_facts f
             ON f.instrument_id = latest.instrument_id
            AND f.trading_date = latest.trading_date`,
    )
      .bind("2026-07-10")
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail.toLowerCase());
    expect(details.some((detail) => detail.includes("search candidate"))).toBe(
      true,
    );
    expect(details.some((detail) => detail.includes("scan candidate"))).toBe(
      false,
    );
  });

  it("chunks read-model queries when more than one hundred instruments are held", async () => {
    const statements: D1PreparedStatement[] = [];
    const flush = async () => {
      if (statements.length === 0) return;
      await env.DB.batch(statements.splice(0, statements.length));
    };
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const instrumentId = `bulk-${suffix}`;
      const symbol = `BULK${suffix}`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO instruments
           (id, symbol, company_name, exchange, currency, instrument_type,
            provider, provider_symbol, created_at, updated_at)
           VALUES (?1, ?2, ?3, 'NYSE', 'USD', 'stock', 'yahoo', ?2, ?4, ?4)`,
        ).bind(instrumentId, symbol, `${symbol} Corp`, now),
        env.DB.prepare(
          `INSERT INTO transactions
           (id, instrument_id, trade_date, side, quantity_decimal,
            price_decimal, revision, created_at, updated_at)
           VALUES (?1, ?2, '2026-01-02', 'buy', '1', '10', 1, ?3, ?3)`,
        ).bind(`bulk-buy-${suffix}`, instrumentId, now),
        env.DB.prepare(
          `INSERT INTO daily_market_facts
           (id, instrument_id, trading_date, previous_trading_date,
            previous_raw_close_decimal, current_raw_close_decimal,
            crossing_split_numerator, crossing_split_denominator,
            split_adjusted_previous_close_decimal, movement_amount_decimal,
            movement_percent_decimal, raw_close_difference_decimal,
            movement_basis, provider, provider_revision, retrieved_at, status,
            created_at, updated_at)
           VALUES (?1, ?2, '2026-07-09', '2026-07-08', '10', '11', '1', '1',
                   '10', '1', '10', '1', 'split_adjusted_price_return',
                   'yahoo', 'r1', ?3, 'valid', ?3, ?3)`,
        ).bind(`bulk-fact-${suffix}`, instrumentId, now),
      );
      if (statements.length >= 60) await flush();
    }
    await flush();

    const portfolioResponse = await exports.default.fetch(
      new Request("http://local/api/portfolio?today=2026-07-10&limit=100", {
        headers: { Authorization: authorization },
      }),
    );
    expect(portfolioResponse.status).toBe(200);
    const portfolioPayload = await portfolioResponse.json<{
      portfolio: {
        positions: Array<Record<string, unknown>>;
        nextCursor: string | null;
      };
    }>();
    expect(portfolioPayload.portfolio.positions).toHaveLength(100);
    expect(portfolioPayload.portfolio.nextCursor).not.toBeNull();

    const calendarResponse = await exports.default.fetch(
      new Request(
        "http://local/api/calendar?startDate=2026-07-01&endDate=2026-07-31&asOfDate=2026-07-10&limit=100",
        { headers: { Authorization: authorization } },
      ),
    );
    expect(calendarResponse.status).toBe(200);
    const calendarPayload = await calendarResponse.json<{
      calendar: {
        movers: Array<Record<string, unknown>>;
        nextCursor: string | null;
      };
    }>();
    expect(calendarPayload.calendar.movers).toHaveLength(100);
    expect(calendarPayload.calendar.nextCursor).not.toBeNull();
  });

  it("uses the Toronto market date for latest invalidation at a UTC boundary", async () => {
    await insertInstrument({
      id: "timezone-state",
      symbol: "TIMEZONE.STATE",
      currency: "CAD",
    });
    await insertFact({
      id: "timezone-fact",
      instrumentId: "timezone-state",
      date: "2030-07-10",
      previous: "10",
      current: "11",
      pct: "10",
    });
    const boundaryTimestamp = "2030-07-11T03:30:00.000Z";
    await env.DB.prepare(
      `INSERT INTO work_items
       (id, scope, work_type, instrument_id, effective_date,
        dependency_revision, deterministic_key, state, priority, max_attempts,
        created_at, updated_at)
       VALUES ('timezone-work', 'global_fact', 'market_fact', 'timezone-state',
               '2030-07-10', 'r1', 'timezone-work', 'queued', 1, 3, ?1, ?1)`,
    )
      .bind(boundaryTimestamp)
      .run();
    const transitioned = await new WorkItemRepository(env.DB).transition({
      id: "timezone-work",
      from: "queued",
      to: "pending",
      now: boundaryTimestamp,
    });
    expect(transitioned).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT revision FROM fact_revision_buckets WHERE bucket_key = 'latest'",
      ).first<{ revision: number }>(),
    ).toEqual({ revision: 1 });
  });

  it("isolates read-model ETags to the buckets each representation reads", async () => {
    const portfolioResponse = await exports.default.fetch(
      new Request("http://local/api/portfolio?today=2026-07-10", {
        headers: { Authorization: authorization },
      }),
    );
    const portfolioTag = portfolioResponse.headers.get("ETag") ?? "";
    await env.DB.prepare(
      `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
       VALUES ('2026-01', 1, ?1)`,
    )
      .bind(now)
      .run();
    const portfolioUnrelated = await exports.default.fetch(
      new Request("http://local/api/portfolio?today=2026-07-10", {
        headers: {
          Authorization: authorization,
          "If-None-Match": portfolioTag,
        },
      }),
    );
    expect(portfolioUnrelated.status).toBe(304);
    await env.DB.prepare(
      `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
       VALUES ('latest', 1, ?1)
       ON CONFLICT(bucket_key) DO UPDATE SET revision = revision + 1`,
    )
      .bind(now)
      .run();
    const portfolioLatest = await exports.default.fetch(
      new Request("http://local/api/portfolio?today=2026-07-10", {
        headers: {
          Authorization: authorization,
          "If-None-Match": portfolioTag,
        },
      }),
    );
    expect(portfolioLatest.status).toBe(200);

    const historicalPortfolio = await exports.default.fetch(
      new Request("http://local/api/portfolio?today=2026-01-10", {
        headers: { Authorization: authorization },
      }),
    );
    const historicalPortfolioTag =
      historicalPortfolio.headers.get("ETag") ?? "";
    await env.DB.prepare(
      `UPDATE fact_revision_buckets
       SET revision = revision + 1, updated_at = ?1
       WHERE bucket_key = 'latest'`,
    )
      .bind(now)
      .run();
    const historicalUnrelated = await exports.default.fetch(
      new Request("http://local/api/portfolio?today=2026-01-10", {
        headers: {
          Authorization: authorization,
          "If-None-Match": historicalPortfolioTag,
        },
      }),
    );
    expect(historicalUnrelated.status).toBe(304);

    const futurePortfolio = await exports.default.fetch(
      new Request("http://local/api/portfolio?today=2026-08-10", {
        headers: { Authorization: authorization },
      }),
    );
    const futurePortfolioTag = futurePortfolio.headers.get("ETag") ?? "";
    await env.DB.prepare(
      `UPDATE fact_revision_buckets
       SET revision = revision + 1, updated_at = ?1
       WHERE bucket_key = 'latest'`,
    )
      .bind(now)
      .run();
    const futureLatest = await exports.default.fetch(
      new Request("http://local/api/portfolio?today=2026-08-10", {
        headers: {
          Authorization: authorization,
          "If-None-Match": futurePortfolioTag,
        },
      }),
    );
    expect(futureLatest.status).toBe(200);

    const calendarResponse = await exports.default.fetch(
      new Request(
        "http://local/api/calendar?startDate=2026-07-01&endDate=2026-07-31&asOfDate=2026-07-10",
        { headers: { Authorization: authorization } },
      ),
    );
    const calendarTag = calendarResponse.headers.get("ETag") ?? "";
    await env.DB.prepare(
      `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
       VALUES ('2026-06', 1, ?1)`,
    )
      .bind(now)
      .run();
    const calendarUnrelated = await exports.default.fetch(
      new Request(
        "http://local/api/calendar?startDate=2026-07-01&endDate=2026-07-31&asOfDate=2026-07-10",
        {
          headers: {
            Authorization: authorization,
            "If-None-Match": calendarTag,
          },
        },
      ),
    );
    expect(calendarUnrelated.status).toBe(304);
    await env.DB.prepare(
      `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
       VALUES ('latest', 1, ?1)
       ON CONFLICT(bucket_key) DO UPDATE SET revision = revision + 1`,
    )
      .bind(now)
      .run();
    const calendarLatest = await exports.default.fetch(
      new Request(
        "http://local/api/calendar?startDate=2026-07-01&endDate=2026-07-31&asOfDate=2026-07-10",
        {
          headers: {
            Authorization: authorization,
            "If-None-Match": calendarTag,
          },
        },
      ),
    );
    expect(calendarLatest.status).toBe(200);

    await insertInstrument({
      id: "etag-state-1",
      symbol: "ETAG.STATE",
      currency: "CAD",
    });
    await env.DB.prepare(
      `INSERT INTO work_items
       (id, scope, work_type, instrument_id, effective_date,
        dependency_revision, deterministic_key, state, priority, max_attempts,
        created_at, updated_at)
       VALUES ('etag-june', 'global_fact', 'market_fact', 'etag-state-1',
               '2026-06-10', 'r1', 'etag-june', 'queued', 1, 3, ?1, ?1),
              ('etag-july', 'global_fact', 'market_fact', 'etag-state-1',
               '2026-07-10', 'r1', 'etag-july', 'queued', 1, 3, ?1, ?1)`,
    )
      .bind(now)
      .run();
    const isolatedCalendar = await exports.default.fetch(
      new Request(
        "http://local/api/calendar?startDate=2026-07-01&endDate=2026-07-31&asOfDate=2026-07-10",
        { headers: { Authorization: authorization } },
      ),
    );
    const isolatedTag = isolatedCalendar.headers.get("ETag") ?? "";
    const workItems = new WorkItemRepository(env.DB);
    expect(
      await workItems.transition({
        id: "etag-june",
        from: "queued",
        to: "pending",
        now,
      }),
    ).toBe(true);
    const unrelatedState = await exports.default.fetch(
      new Request(
        "http://local/api/calendar?startDate=2026-07-01&endDate=2026-07-31&asOfDate=2026-07-10",
        {
          headers: {
            Authorization: authorization,
            "If-None-Match": isolatedTag,
          },
        },
      ),
    );
    expect(unrelatedState.status).toBe(304);
    expect(
      await workItems.transition({
        id: "etag-july",
        from: "queued",
        to: "pending",
        now,
      }),
    ).toBe(true);
    const relatedState = await exports.default.fetch(
      new Request(
        "http://local/api/calendar?startDate=2026-07-01&endDate=2026-07-31&asOfDate=2026-07-10",
        {
          headers: {
            Authorization: authorization,
            "If-None-Match": isolatedTag,
          },
        },
      ),
    );
    expect(relatedState.status).toBe(200);
  });

  it("derives quantities, raw-close valuation, movement, Chinese summary, and native totals", async () => {
    await insertInstrument({ id: "cad-1", symbol: "CAD.ONE", currency: "CAD" });
    await insertInstrument({ id: "usd-1", symbol: "USD.ONE", currency: "USD" });
    await insertTransaction({
      id: "cad-buy",
      instrumentId: "cad-1",
      quantity: "10",
    });
    await insertTransaction({
      id: "usd-buy",
      instrumentId: "usd-1",
      quantity: "2",
    });
    await env.DB.prepare(
      `INSERT INTO corporate_actions
       (id, instrument_id, action_type, effective_date, split_numerator,
        split_denominator, provider, provider_event_id, provider_revision,
        retrieved_at, revision, status, created_at, updated_at)
       VALUES ('split-1', 'cad-1', 'split', '2026-07-01', '2', '1',
               'yahoo', 'split-1', 'r1', ?1, 1, 'active', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await insertFact({
      id: "cad-fact",
      instrumentId: "cad-1",
      date: "2026-07-09",
      previous: "9",
      current: "10.8",
      pct: "20",
    });
    await insertFact({
      id: "usd-fact",
      instrumentId: "usd-1",
      date: "2026-07-09",
      previous: "98",
      current: "100",
      pct: "2.0408163265",
    });
    await env.DB.prepare(
      `INSERT INTO movement_analyses
       (id, daily_market_fact_id, dependency_fingerprint, summary_zh_cn,
        model, status, created_at, updated_at)
       VALUES ('analysis-1', 'cad-fact', 'fp', '公司发布了新的业务指引。',
               'test', 'complete', ?1, ?1)`,
    )
      .bind(now)
      .run();
    const response = await exports.default.fetch(
      new Request("http://local/api/portfolio?today=2026-07-10&locale=cn", {
        headers: { Authorization: authorization },
      }),
    );
    expect(response.status).toBe(200);
    const payload = await response.json<{
      portfolio: {
        positions: Array<Record<string, unknown>>;
        totals: { CAD: string; USD: string };
      };
    }>();
    const cad = payload.portfolio.positions.find(
      (row) => row.symbol === "CAD.ONE",
    );
    const usd = payload.portfolio.positions.find(
      (row) => row.symbol === "USD.ONE",
    );
    expect(cad).toEqual(
      expect.objectContaining({
        quantityDecimal: "20",
        valuationDecimal: "216",
        summaryZhCn: "公司发布了新的业务指引。",
      }),
    );
    expect(usd).toEqual(
      expect.objectContaining({
        quantityDecimal: "2",
        valuationDecimal: "200",
      }),
    );
    expect(payload.portfolio.totals).toEqual({ CAD: "216", USD: "200" });
    const second = await exports.default.fetch(
      new Request("http://local/api/portfolio?today=2026-07-10&locale=cn", {
        headers: {
          Authorization: authorization,
          "If-None-Match": response.headers.get("ETag") ?? "",
        },
      }),
    );
    expect(second.status).toBe(304);
  });

  it("shows last-valid values for stale facts and blocks legacy-basis values", async () => {
    await insertInstrument({
      id: "stale-1",
      symbol: "STALE.ONE",
      currency: "CAD",
    });
    await insertInstrument({
      id: "legacy-1",
      symbol: "LEGACY.ONE",
      currency: "CAD",
    });
    await insertTransaction({
      id: "stale-buy",
      instrumentId: "stale-1",
      quantity: "10",
    });
    await insertTransaction({
      id: "legacy-buy",
      instrumentId: "legacy-1",
      quantity: "10",
    });
    await insertFact({
      id: "stale-valid",
      instrumentId: "stale-1",
      date: "2026-07-08",
      previous: "9",
      current: "10",
      pct: "11.1111111111",
    });
    await insertFact({
      id: "stale-latest",
      instrumentId: "stale-1",
      date: "2026-07-09",
      previous: "10",
      current: "99",
      pct: "890",
    });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE daily_market_facts SET status = 'stale' WHERE id = 'stale-latest'",
      ),
      env.DB.prepare(
        `INSERT INTO daily_market_facts
         (id, instrument_id, trading_date, previous_trading_date,
          previous_raw_close_decimal, current_raw_close_decimal,
          crossing_split_numerator, crossing_split_denominator,
          split_adjusted_previous_close_decimal, movement_amount_decimal,
          movement_percent_decimal, raw_close_difference_decimal, movement_basis,
          provider, provider_revision, retrieved_at, status, created_at, updated_at)
         VALUES ('legacy-latest', 'legacy-1', '2026-07-09', '2026-07-08',
                 '10', '20', '1', '1', '10', '10', '100', '10',
                 'legacy_migration', 'yahoo', 'legacy-r1', ?1, 'valid', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO movement_analyses
         (id, daily_market_fact_id, dependency_fingerprint, summary_zh_cn,
          model, status, created_at, updated_at)
         VALUES ('stale-analysis-valid', 'stale-valid', 'fp', '旧摘要',
                 'test', 'complete', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO movement_analyses
         (id, daily_market_fact_id, dependency_fingerprint, summary_zh_cn,
          model, status,
          error_code, error_message, created_at, updated_at)
         VALUES ('stale-analysis-error', 'stale-latest', 'fp', '当前摘要',
                 'test', 'error', 'analysis_bad', 'Analysis refresh failed', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO news_sources
         (id, movement_analysis_id, source_order, title, publisher,
          published_at, source_url, cited, created_at)
         VALUES ('stale-source', 'stale-analysis-valid', 0, 'Old story',
                 'Example', ?1, 'https://example.com/old-story', 1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO news_sources
         (id, movement_analysis_id, source_order, title, publisher,
          published_at, source_url, cited, created_at)
         VALUES ('stale-current-source', 'stale-analysis-error', 0,
                 'Current story', 'Example', ?1,
                 'https://example.com/current-story', 1, ?1)`,
      ).bind(now),
    ]);
    const response = await exports.default.fetch(
      new Request("http://local/api/portfolio?today=2026-07-10", {
        headers: { Authorization: authorization },
      }),
    );
    expect(response.status).toBe(200);
    const payload = await response.json<{
      portfolio: {
        positions: Array<Record<string, unknown>>;
      };
    }>();
    const stale = payload.portfolio.positions.find(
      (row) => row.symbol === "STALE.ONE",
    );
    expect(stale).toEqual(
      expect.objectContaining({
        valuationDecimal: "100",
        latestTradingDate: "2026-07-09",
        freshness: "stale",
        summaryZhCn: "当前摘要",
        analysisStatus: "error",
      }),
    );
    expect(stale?.movement).toEqual(
      expect.objectContaining({ tradingDate: "2026-07-08" }),
    );
    expect(stale?.sources).toEqual([
      expect.objectContaining({ title: "Current story" }),
    ]);
    expect(stale?.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "analysis_bad" }),
      ]),
    );
    const legacy = payload.portfolio.positions.find(
      (row) => row.symbol === "LEGACY.ONE",
    );
    expect(legacy).toEqual(
      expect.objectContaining({
        valuationDecimal: null,
        movement: null,
        freshness: "pending",
      }),
    );
    expect(legacy?.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "legacy_movement_basis" }),
      ]),
    );
  });

  it("shows held movers, ex-dividend value, actual trading dates, and pending state", async () => {
    await insertInstrument({
      id: "calendar-1",
      symbol: "CAL.ONE",
      currency: "CAD",
    });
    await insertTransaction({
      id: "calendar-buy",
      instrumentId: "calendar-1",
      quantity: "10",
    });
    await insertFact({
      id: "calendar-fact",
      instrumentId: "calendar-1",
      date: "2026-07-09",
      previous: "10",
      current: "11",
      pct: "10",
    });
    await insertFact({
      id: "calendar-stale-fact",
      instrumentId: "calendar-1",
      date: "2026-07-10",
      previous: "11",
      current: "12",
      pct: "9.0909090909",
    });
    await insertFact({
      id: "calendar-legacy-fact",
      instrumentId: "calendar-1",
      date: "2026-07-07",
      previous: "10",
      current: "12",
      pct: "20",
    });
    await insertFact({
      id: "calendar-future-fact",
      instrumentId: "calendar-1",
      date: "2026-07-11",
      previous: "12",
      current: "14",
      pct: "16.6666666667",
    });
    await env.DB.prepare(
      `INSERT INTO dividend_events
       (id, instrument_id, ex_date, payment_date, amount_per_share_decimal,
        currency, provider, provider_event_id, provider_revision, source_url,
        retrieved_at, status, created_at, updated_at)
       VALUES ('div-1', 'calendar-1', '2026-07-09', '2026-07-30', '1.5',
               'CAD', 'yahoo', 'div-1', 'r1', 'https://example.com/div',
               ?1, 'active', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE daily_market_facts SET status = 'stale' WHERE id = 'calendar-stale-fact'",
      ),
      env.DB.prepare(
        "UPDATE daily_market_facts SET movement_basis = 'legacy_migration' WHERE id = 'calendar-legacy-fact'",
      ),
      env.DB.prepare(
        `INSERT INTO movement_analyses
         (id, daily_market_fact_id, dependency_fingerprint, summary_zh_cn,
          model, status, created_at, updated_at)
         VALUES ('calendar-future-analysis', 'calendar-future-fact', 'fp',
                 '未来摘要', 'test', 'complete', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO movement_analyses
         (id, daily_market_fact_id, dependency_fingerprint, summary_zh_cn,
          model, status, created_at, updated_at)
         VALUES ('calendar-analysis', 'calendar-fact', 'fp', '历史摘要',
                 'test', 'complete', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO movement_analyses
         (id, daily_market_fact_id, dependency_fingerprint, model, status,
          error_code, error_message, created_at, updated_at)
         VALUES ('calendar-stale-analysis', 'calendar-stale-fact', 'fp',
                 'test', 'error', 'calendar_analysis_bad', 'Refresh failed', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO news_sources
         (id, movement_analysis_id, source_order, title, publisher,
          published_at, source_url, cited, created_at)
         VALUES ('calendar-source', 'calendar-analysis', 0, 'Calendar story',
                 'Example', ?1, 'https://example.com/calendar-story', 1, ?1)`,
      ).bind(now),
    ]);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO dividend_events
         (id, instrument_id, ex_date, payment_date, amount_per_share_decimal,
          currency, provider, provider_event_id, provider_revision, source_url,
          retrieved_at, status, created_at, updated_at)
         VALUES ('div-superseded', 'calendar-1', '2026-07-09', '2026-07-30', '9',
                 'CAD', 'yahoo', 'div-1-old', 'r0', 'https://example.com/old',
                 ?1, 'superseded', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO dividend_events
         (id, instrument_id, ex_date, payment_date, amount_per_share_decimal,
          currency, provider, provider_event_id, provider_revision, source_url,
          retrieved_at, status, created_at, updated_at)
         VALUES ('div-stale', 'calendar-1', '2026-07-15', '2026-07-30', '0.25',
                 'CAD', 'yahoo', 'div-stale', 'r1', 'https://example.com/stale',
                 ?1, 'stale', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO dividend_events
         (id, instrument_id, ex_date, payment_date, amount_per_share_decimal,
          currency, provider, provider_event_id, provider_revision, source_url,
          retrieved_at, status, error_code, error_message, created_at, updated_at)
         VALUES ('div-error', 'calendar-1', '2026-07-16', '2026-07-30', 'not-decimal',
                 'CAD', 'yahoo', 'div-error', 'r1', 'https://example.com/error',
                 ?1, 'error', 'div_bad', 'Provider returned an invalid amount', ?1, ?1)`,
      ).bind(now),
    ]);
    await env.DB.prepare(
      `INSERT INTO work_items
       (id, scope, work_type, instrument_id, effective_date, dependency_revision,
        deterministic_key, state, priority, max_attempts, created_at, updated_at)
       VALUES ('pending-fact', 'global_fact', 'market_fact', 'calendar-1',
               '2026-07-08', 'r1', 'pending-calendar', 'queued', 1, 3, ?1, ?1)`,
    )
      .bind(now)
      .run();
    const response = await exports.default.fetch(
      new Request(
        "http://local/api/calendar?startDate=2026-07-01&endDate=2026-07-31&asOfDate=2026-07-10&view=month",
        { headers: { Authorization: authorization } },
      ),
    );
    expect(response.status).toBe(200);
    const payload = await response.json<{
      calendar: {
        actualTradingDates: string[];
        movers: Array<Record<string, unknown>>;
        dividends: Array<Record<string, unknown>>;
        pendingFacts: Array<Record<string, unknown>>;
        conflicts: Array<Record<string, unknown>>;
      };
    }>();
    expect(payload.calendar.actualTradingDates).toEqual([
      "2026-07-07",
      "2026-07-09",
      "2026-07-10",
      "2026-07-11",
    ]);
    expect(payload.calendar.movers[0]).toEqual(
      expect.objectContaining({
        symbol: "CAL.ONE",
        heldQuantityDecimal: "10",
      }),
    );
    expect(
      payload.calendar.movers.find((row) => row.id === "calendar-stale-fact"),
    ).toEqual(
      expect.objectContaining({
        freshness: "stale",
        summaryZhCn: "历史摘要",
        analysisStatus: "error",
      }),
    );
    expect(
      payload.calendar.movers.find((row) => row.id === "calendar-stale-fact")
        ?.sources,
    ).toEqual([expect.objectContaining({ title: "Calendar story" })]);
    expect(
      payload.calendar.movers.find((row) => row.id === "calendar-legacy-fact"),
    ).toBeUndefined();
    expect(
      payload.calendar.movers.find((row) => row.id === "calendar-future-fact"),
    ).toEqual(expect.objectContaining({ summaryZhCn: "未来摘要" }));
    expect(payload.calendar.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "legacy_movement_basis",
          effectiveDate: "2026-07-07",
        }),
      ]),
    );
    expect(payload.calendar.dividends[0]).toEqual(
      expect.objectContaining({
        expectedTotalValueDecimal: "15",
        eligible: true,
      }),
    );
    expect(payload.calendar.dividends).toHaveLength(3);
    expect(
      payload.calendar.dividends.find((row) => row.id === "div-superseded"),
    ).toBeUndefined();
    expect(
      payload.calendar.dividends.find((row) => row.id === "div-stale"),
    ).toEqual(expect.objectContaining({ status: "stale" }));
    expect(
      payload.calendar.dividends.find((row) => row.id === "div-error"),
    ).toEqual(
      expect.objectContaining({
        status: "error",
        amountPerShareDecimal: null,
        expectedTotalValueDecimal: null,
      }),
    );
    expect(payload.calendar.conflicts).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "div_bad" })]),
    );
    expect(payload.calendar.pendingFacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: "2026-07-08", status: "queued" }),
        expect.objectContaining({
          date: "2026-07-07",
          status: "legacy_pending",
        }),
      ]),
    );
    const workItems = new WorkItemRepository(env.DB);
    await workItems.transition({
      id: "pending-fact",
      from: "queued",
      to: "pending",
      now,
    });
    const transitioned = await workItems.transition({
      id: "pending-fact",
      from: "pending",
      to: "complete",
      now,
    });
    expect(transitioned).toBe(true);
    const pendingChanged = await exports.default.fetch(
      new Request(
        "http://local/api/calendar?startDate=2026-07-01&endDate=2026-07-31&asOfDate=2026-07-10&view=month",
        {
          headers: {
            Authorization: authorization,
            "If-None-Match": response.headers.get("ETag") ?? "",
          },
        },
      ),
    );
    expect(pendingChanged.status).toBe(200);
    const changedPayload = await pendingChanged.json<{
      calendar: { pendingFacts: Array<Record<string, unknown>> };
    }>();
    expect(changedPayload.calendar.pendingFacts).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ date: "2026-07-08", status: "queued" }),
      ]),
    );
  });

  it("shows earnings only when the scoped account held shares on the report date", async () => {
    await insertInstrument({
      id: "earnings-calendar",
      symbol: "EARN",
      currency: "USD",
    });
    await insertTransaction({
      id: "earnings-calendar-buy",
      instrumentId: "earnings-calendar",
      date: "2026-01-02",
      quantity: "4",
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, account_id, trade_date, side, quantity_decimal,
          price_decimal, revision, created_at, updated_at)
         VALUES ('earnings-calendar-sell', 'earnings-calendar',
                 'account-default', '2026-07-25', 'sell', '4', '100', 1, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO earnings_events
         (id, instrument_id, report_date, fiscal_date_ending,
          eps_estimate_decimal, currency, time_of_day, provider,
          provider_event_id, provider_revision, retrieved_at, status,
          created_at, updated_at)
         VALUES ('earnings-held', 'earnings-calendar', '2026-07-22',
                 '2026-06-30', '1.25', 'USD', 'post-market',
                 'alpha-vantage-earnings', 'earnings-held', 'r1', ?1,
                 'active', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO earnings_events
         (id, instrument_id, report_date, fiscal_date_ending,
          eps_estimate_decimal, currency, time_of_day, provider,
          provider_event_id, provider_revision, retrieved_at, status,
          created_at, updated_at)
         VALUES ('earnings-sold', 'earnings-calendar', '2026-07-30',
                 '2026-09-30', '1.4', 'USD', 'pre-market',
                 'alpha-vantage-earnings', 'earnings-sold', 'r1', ?1,
                 'active', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO earnings_calendar_coverage
         (provider, coverage_start_date, coverage_end_date, horizon,
          provider_revision, observed_at, status, updated_at)
         VALUES ('alpha-vantage-earnings', '2026-07-10', '2026-10-10',
                 '3month', 'coverage-r1', ?1, 'current', ?1)`,
      ).bind(now),
    ]);

    const response = await exports.default.fetch(
      new Request(
        "http://local/api/calendar?startDate=2026-07-01&endDate=2026-07-31&asOfDate=2026-07-31&view=month",
        { headers: { Authorization: authorization } },
      ),
    );
    expect(response.status).toBe(200);
    const payload = await response.json<{
      calendar: {
        earnings: Array<Record<string, unknown>>;
        events: Array<Record<string, unknown>>;
        earningsCoverageStatus: string;
      };
    }>();
    expect(payload.calendar.earnings).toEqual([
      expect.objectContaining({
        id: "earnings-held",
        reportDate: "2026-07-22",
        fiscalDateEnding: "2026-06-30",
        epsEstimateDecimal: "1.25",
        heldQuantityDecimal: "4",
        timeOfDay: "post-market",
      }),
    ]);
    expect(payload.calendar.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "earnings-held", kind: "earnings" }),
      ]),
    );
    expect(payload.calendar.earningsCoverageStatus).toBe("current");
  });

  it("returns job progress and bounded-range/cursor errors", async () => {
    await env.DB.prepare(
      `INSERT INTO pipeline_jobs
       (id, trigger_type, requested_start_date, requested_end_date,
        priority, status, work_total, work_processed, created_at, updated_at)
       VALUES ('read-job', 'backfill', '2026-07-01', '2026-07-02', 1,
               'running', 2, 1, ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO work_items
         (id, scope, work_type, effective_date, dependency_revision,
          deterministic_key, state, priority, max_attempts, created_at, updated_at)
         VALUES ('job-work-a', 'global_fact', 'market_fact', '2026-07-01', 'r1',
                 'job-work-a', 'complete', 1, 3, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO work_items
         (id, scope, work_type, effective_date, dependency_revision,
          deterministic_key, state, priority, max_attempts, created_at, updated_at)
         VALUES ('job-work-b', 'global_fact', 'market_fact', '2026-07-02', 'r1',
                 'job-work-b', 'terminal', 1, 3, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO work_items
         (id, scope, work_type, effective_date, dependency_revision,
          deterministic_key, state, priority, max_attempts, created_at, updated_at)
         VALUES ('job-work-c', 'global_fact', 'market_fact', '2026-07-03', 'r1',
                 'job-work-c', 'complete', 1, 3, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO job_work_items
         (pipeline_job_id, work_item_id, relationship, outcome, created_at)
         VALUES ('read-job', 'job-work-a', 'required', 'processed', ?1),
                ('read-job', 'job-work-b', 'required', 'failed', ?1),
                ('read-job', 'job-work-c', 'required', 'processed', ?1)`,
      ).bind(now),
    ]);
    const response = await exports.default.fetch(
      new Request("http://local/api/pipeline-jobs/read-job?limit=2", {
        headers: { Authorization: authorization },
      }),
    );
    expect(response.status).toBe(200);
    const jobPayload = await response.json<{
      job: {
        progress: { workTotal: number };
        work: Array<{ id: string }>;
        nextCursor: string | null;
      };
    }>();
    expect(jobPayload.job.progress.workTotal).toBe(2);
    expect(jobPayload.job.work).toHaveLength(2);
    expect(jobPayload.job.nextCursor).not.toBeNull();
    const nextJobResponse = await exports.default.fetch(
      new Request(
        `http://local/api/pipeline-jobs/read-job?limit=2&cursor=${encodeURIComponent(jobPayload.job.nextCursor ?? "")}`,
        { headers: { Authorization: authorization } },
      ),
    );
    expect(nextJobResponse.status).toBe(200);
    const nextJobPayload = await nextJobResponse.json<{
      job: { work: Array<{ id: string }> };
    }>();
    expect(nextJobPayload.job.work).toHaveLength(1);
    const invalidCursor = await exports.default.fetch(
      new Request("http://local/api/portfolio?cursor=bad", {
        headers: { Authorization: authorization },
      }),
    );
    expect(invalidCursor.status).toBe(422);
    expect(
      (await invalidCursor.json<{ error: { code: string } }>()).error.code,
    ).toBe("cursor");
    const tooWide = await exports.default.fetch(
      new Request(
        "http://local/api/calendar?startDate=2026-01-01&endDate=2026-03-01",
        {
          headers: { Authorization: authorization },
        },
      ),
    );
    expect(tooWide.status).toBe(422);
  });

  it("returns provider coverage and recent jobs on the status read model", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO earnings_calendar_coverage
         (provider, coverage_start_date, coverage_end_date, horizon,
          provider_revision, observed_at, status, updated_at)
         VALUES ('alpha-vantage-earnings', '2026-07-01', '2026-10-01',
                 '3month', 'coverage-r1', ?1, 'current', ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO pipeline_jobs
         (id, trigger_type, priority, status, work_total, work_processed,
          created_at, updated_at)
         VALUES ('status-job', 'scheduled', 1, 'complete', 3, 3, ?1, ?1)`,
      ).bind(now),
    ]);

    const response = await exports.default.fetch(
      new Request("http://local/api/status?limit=10", {
        headers: { Authorization: authorization },
      }),
    );
    expect(response.status).toBe(200);
    const payload = await response.json<{
      status: {
        earningsCoverage: { status: string; coverageEndDate: string };
        jobs: Array<{ id: string; status: string }>;
      };
    }>();
    expect(payload.status.earningsCoverage).toMatchObject({
      status: "current",
      coverageEndDate: "2026-10-01",
    });
    expect(payload.status.jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "status-job", status: "complete" }),
      ]),
    );
  });
});
