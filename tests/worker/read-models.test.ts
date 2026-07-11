import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

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
  date?: string;
  quantity: string;
  price?: string;
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO transactions
     (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
      revision, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'buy', ?4, ?5, 1, ?6, ?6)`,
  )
    .bind(
      input.id,
      input.instrumentId,
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
      };
    }>();
    expect(payload.calendar.actualTradingDates).toEqual(["2026-07-09"]);
    expect(payload.calendar.movers[0]).toEqual(
      expect.objectContaining({
        symbol: "CAL.ONE",
        heldQuantityDecimal: "10",
      }),
    );
    expect(payload.calendar.dividends[0]).toEqual(
      expect.objectContaining({
        expectedTotalValueDecimal: "15",
        eligible: true,
      }),
    );
    expect(payload.calendar.pendingFacts).toEqual([
      expect.objectContaining({ date: "2026-07-08", status: "queued" }),
    ]);
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
    const response = await exports.default.fetch(
      new Request("http://local/api/jobs/read-job", {
        headers: { Authorization: authorization },
      }),
    );
    expect(response.status).toBe(200);
    expect(
      (await response.json<{ job: { progress: { workTotal: number } } }>()).job
        .progress.workTotal,
    ).toBe(2);
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
});
