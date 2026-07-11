import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { TickerRepository } from "../../src/db/tickers";
import {
  delayedBarDeadline,
  isCanadianMarketHoliday,
  isWithinDelayedBarHorizon,
  ScheduledReconciliationService,
  torontoLocalParts,
} from "../../src/services/scheduled-reconciliation";
import { handleScheduled } from "../../src/worker/scheduled";

describe("scheduled handler", () => {
  it("snapshots and dispatches one idempotent weekday run", async () => {
    const now = "2026-07-09T22:00:00.000Z";
    await new TickerRepository(env.DB).insert({
      id: "scheduled-aapl",
      symbol: "AAPL",
      companyName: "Apple Inc.",
      exchange: "NMS",
      currency: "USD",
      now,
    });
    const controller = {
      scheduledTime: Date.parse(now),
      cron: "0 22 * * MON-FRI",
      noRetry() {},
    } as ScheduledController;
    await handleScheduled(controller, env);
    await handleScheduled(controller, env);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM report_runs WHERE origin = 'scheduled'",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT status, symbol, target_date FROM screenings LIMIT 1",
      ).first(),
    ).toEqual({ status: "queued", symbol: "AAPL", target_date: "2026-07-09" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM dispatch_events",
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("runs one bounded migration page only when the migrator flag is enabled", async () => {
    const now = "2031-01-06T22:00:00.000Z";
    const enabledEnv = new Proxy(env, {
      get(target, property) {
        if (property === "PORTFOLIO_MIGRATOR_ENABLED") return "true";
        return Reflect.get(target, property);
      },
    });
    await handleScheduled(
      {
        scheduledTime: Date.parse(now),
        cron: "0 22 * * MON-FRI",
        noRetry() {},
      } as ScheduledController,
      enabledEnv,
    );
    expect(
      await env.DB.prepare(
        `SELECT status, examined_count
         FROM portfolio_migration_state WHERE id = 'legacy-published'`,
      ).first(),
    ).toEqual({ status: "complete", examined_count: 0 });
  });

  it("does not run the legacy scheduler for new planner or dispatcher triggers", async () => {
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM report_runs WHERE origin = 'scheduled'",
    ).first<{ count: number }>();
    const triggers = ["30 20 * * MON-FRI", "30 21 * * MON-FRI", "*/15 * * * *"];
    for (const cron of triggers) {
      await handleScheduled(
        {
          scheduledTime: Date.parse("2026-07-10T20:30:00.000Z"),
          cron,
          noRetry() {},
        } as ScheduledController,
        env,
      );
    }
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM report_runs WHERE origin = 'scheduled'",
    ).first<{ count: number }>();
    expect(after).toEqual(before);
  });

  it("expires and purges stale import staging during the dispatcher tick", async () => {
    const now = "2026-07-11T20:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO import_batches
         (id, file_digest, original_filename, base_position_basis_revision,
          status, expires_at, created_at, updated_at)
         VALUES ('scheduled-stale-import', 'scheduled-stale-digest',
                 'events.csv', 0, 'preview', '2026-07-01T12:00:00.000Z',
                 ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO import_rows
         (id, import_batch_id, row_number, symbol, status)
         VALUES ('scheduled-stale-row', 'scheduled-stale-import', 2,
                 'AAPL', 'invalid')`,
      ),
    ]);
    const disabledEnv = new Proxy(env, {
      get(target, property) {
        if (property === "PORTFOLIO_NEW_WRITES_ENABLED") return "false";
        return Reflect.get(target, property);
      },
    });
    await handleScheduled(
      {
        scheduledTime: Date.parse(now),
        cron: "*/15 * * * *",
        noRetry() {},
      } as ScheduledController,
      disabledEnv,
    );
    expect(
      await env.DB.prepare(
        "SELECT status FROM import_batches WHERE id = 'scheduled-stale-import'",
      ).first(),
    ).toEqual({ status: "expired" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM import_rows WHERE import_batch_id = 'scheduled-stale-import'",
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT file_digest FROM import_batches WHERE id = 'scheduled-stale-import'",
      ).first(),
    ).toEqual({ file_digest: "scheduled-stale-digest" });
  });

  it("runs one normalized planner job for a Toronto DST candidate and de-dupes repeats", async () => {
    const now = "2026-03-09T20:30:00.000Z"; // 16:30 Toronto after spring DST
    await new TickerRepository(env.DB).insert({
      id: "scheduled-normalized-aapl",
      symbol: "AAPL",
      companyName: "Apple Inc.",
      exchange: "NMS",
      currency: "USD",
      now,
    });
    await env.DB.prepare(
      `INSERT INTO instruments
       (id, symbol, company_name, exchange, currency, instrument_type,
        provider, provider_symbol, created_at, updated_at)
       VALUES ('instrument-scheduled-normalized-aapl', 'AAPL', 'Apple Inc.',
               'NMS', 'USD', 'stock', 'yahoo', 'AAPL', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO transactions
       (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
        revision, created_at, updated_at)
       VALUES ('scheduled-buy', 'instrument-scheduled-normalized-aapl',
               '2026-03-01', 'buy', '2', '100', 1, ?1, ?1)`,
    )
      .bind(now)
      .run();
    const enabledEnv = new Proxy(env, {
      get(target, property) {
        if (property === "PORTFOLIO_NEW_WRITES_ENABLED") return "true";
        return Reflect.get(target, property);
      },
    });
    const controller = {
      scheduledTime: Date.parse(now),
      cron: "30 20 * * MON-FRI",
      noRetry() {},
    } as ScheduledController;
    await handleScheduled(controller, enabledEnv);
    await handleScheduled(controller, enabledEnv);
    expect(
      await env.DB.prepare(
        `SELECT id, trigger_type, requested_start_date, status
         FROM pipeline_jobs WHERE id = 'scheduled:portfolio:2026-03-09'`,
      ).first(),
    ).toEqual({
      id: "scheduled:portfolio:2026-03-09",
      trigger_type: "scheduled",
      requested_start_date: "2026-03-09",
      status: "running",
    });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM work_items
         WHERE scope = 'global_fact' AND effective_date = '2026-03-09'`,
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("continues a bounded scheduled planner cursor from the dispatcher", async () => {
    const now = "2026-03-10T20:30:00.000Z";
    const statements: D1PreparedStatement[] = [];
    for (let index = 0; index < 11; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const instrumentId = `scheduled-page-${suffix}`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO instruments
           (id, symbol, company_name, exchange, currency, instrument_type,
            provider, provider_symbol, created_at, updated_at)
           VALUES (?1, ?2, 'Page Corp', 'NMS', 'USD', 'stock', 'yahoo', ?2, ?3, ?3)`,
        ).bind(instrumentId, `PAGE${suffix}`, now),
        env.DB.prepare(
          `INSERT INTO transactions
           (id, instrument_id, trade_date, side, quantity_decimal,
            price_decimal, revision, created_at, updated_at)
           VALUES (?1, ?2, '2026-03-01', 'buy', '1', '100', 1, ?3, ?3)`,
        ).bind(`scheduled-page-buy-${suffix}`, instrumentId, now),
      );
    }
    await env.DB.batch(statements);
    let id = 0;
    const service = new ScheduledReconciliationService({
      db: env.DB,
      now: () => new Date(now),
      plannerPageSize: 1,
      newId: () => `scheduled-page-work-${++id}`,
    });
    const first = await service.plan(new Date(now));
    expect(first).toEqual(
      expect.objectContaining({ kind: "planned", pages: 10, workItems: 10 }),
    );
    expect(
      await env.DB.prepare(
        `SELECT planner_cursor FROM pipeline_jobs
         WHERE id = 'scheduled:portfolio:2026-03-10'`,
      ).first(),
    ).toEqual({ planner_cursor: "10" });
    const continuation = await service.continueScheduledPlanning(new Date(now));
    expect(continuation).toEqual({ jobs: 1, pages: 1, workItems: 1 });
    expect(
      await env.DB.prepare(
        `SELECT planner_cursor FROM pipeline_jobs
         WHERE id = 'scheduled:portfolio:2026-03-10'`,
      ).first(),
    ).toEqual({ planner_cursor: null });
  });

  it("settles a scheduled job when every candidate is safely skipped", async () => {
    const now = "2026-03-11T20:30:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO instruments
         (id, symbol, company_name, exchange, currency, instrument_type,
          provider, provider_symbol, created_at, updated_at)
         VALUES ('scheduled-skip', 'SKIP', 'Skip Corp', 'NMS', 'USD', 'stock',
                 'yahoo', 'SKIP', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal,
          price_decimal, revision, created_at, updated_at)
         VALUES ('scheduled-skip-buy', 'scheduled-skip', '2026-03-01',
                 'buy', '1', '100', 1, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO daily_market_facts
         (id, instrument_id, trading_date, previous_trading_date,
          previous_raw_close_decimal, current_raw_close_decimal,
          crossing_split_numerator, crossing_split_denominator,
          split_adjusted_previous_close_decimal, movement_amount_decimal,
          movement_percent_decimal, raw_close_difference_decimal,
          movement_basis, provider, provider_revision, retrieved_at, status,
          created_at, updated_at)
         VALUES ('scheduled-skip-fact', 'scheduled-skip', '2026-03-11',
                 '2026-03-10', '99', '100', '1', '1', '99', '1', '1', '1',
                 'split_adjusted_price_return', 'test', 'r1', ?1, 'valid', ?1, ?1)`,
      ).bind(now),
    ]);
    const result = await new ScheduledReconciliationService({
      db: env.DB,
      now: () => new Date(now),
    }).plan(new Date(now));
    expect(result).toEqual(
      expect.objectContaining({ kind: "planned", workItems: 0 }),
    );
    expect(
      await env.DB.prepare(
        `SELECT status FROM pipeline_jobs
         WHERE id = 'scheduled:portfolio:2026-03-11'`,
      ).first(),
    ).toEqual({ status: "complete" });
  });

  it("skips the observed Independence Day holiday without creating a job", async () => {
    const now = "2026-07-03T20:30:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO instruments
         (id, symbol, company_name, exchange, currency, instrument_type,
          provider, provider_symbol, created_at, updated_at)
         VALUES ('holiday-us', 'HOLUS', 'Holiday US', 'NMS', 'USD', 'stock',
                 'yahoo', 'HOLUS', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
          revision, created_at, updated_at)
         VALUES ('holiday-us-buy', 'holiday-us', '2026-06-30', 'buy', '1',
                 '100', 1, ?1, ?1)`,
      ).bind(now),
    ]);
    const result = await new ScheduledReconciliationService({
      db: env.DB,
      now: () => new Date(now),
    }).plan(new Date(now));
    expect(result).toEqual({ kind: "skipped", reason: "holiday" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM pipeline_jobs WHERE trigger_type = 'scheduled'",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("keeps an open US exchange when TSX is closed for Canada Day", async () => {
    const now = "2026-07-01T20:30:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO instruments
         (id, symbol, company_name, exchange, currency, instrument_type,
          provider, provider_symbol, created_at, updated_at)
         VALUES ('mixed-us', 'MIXUS', 'Mixed US', 'NMS', 'USD', 'stock',
                 'yahoo', 'MIXUS', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO instruments
         (id, symbol, company_name, exchange, currency, instrument_type,
          provider, provider_symbol, created_at, updated_at)
         VALUES ('mixed-tsx', 'MIX.TO', 'Mixed TSX', 'TSX', 'CAD', 'stock',
                 'yahoo', 'MIX.TO', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
          revision, created_at, updated_at)
         VALUES ('mixed-us-buy', 'mixed-us', '2026-06-30', 'buy', '1', '100',
                 1, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
          revision, created_at, updated_at)
         VALUES ('mixed-tsx-buy', 'mixed-tsx', '2026-06-30', 'buy', '1', '100',
                 1, ?1, ?1)`,
      ).bind(now),
    ]);
    const result = await new ScheduledReconciliationService({
      db: env.DB,
      now: () => new Date(now),
    }).plan(new Date(now));
    expect(result).toEqual(
      expect.objectContaining({ kind: "planned", workItems: 1 }),
    );
    expect(
      await env.DB.prepare(
        `SELECT affected_instruments_json FROM pipeline_jobs
         WHERE id = 'scheduled:portfolio:2026-07-01'`,
      ).first<{ affected_instruments_json: string }>(),
    ).toEqual({ affected_instruments_json: '["mixed-us"]' });
  });

  it("keeps delayed bars retryable through six hours, then closes the horizon", () => {
    const scheduled = new Date("2026-07-09T20:30:00.000Z");
    expect(delayedBarDeadline(scheduled)).toBe("2026-07-10T02:30:00.000Z");
    expect(
      isWithinDelayedBarHorizon(
        scheduled,
        new Date("2026-07-10T02:30:00.000Z"),
      ),
    ).toBe(true);
    expect(
      isWithinDelayedBarHorizon(
        scheduled,
        new Date("2026-07-10T02:30:01.000Z"),
      ),
    ).toBe(false);
  });

  it("recognizes the fall-back Toronto 4:30 p.m. UTC representation", () => {
    expect(
      torontoLocalParts(new Date("2026-11-02T21:30:00.000Z")),
    ).toMatchObject({
      year: "2026",
      month: "11",
      day: "02",
      hour: "16",
      minute: "30",
    });
  });

  it("uses TMX Canadian holiday observance and excludes banking-only holidays", () => {
    expect(isCanadianMarketHoliday("2023-07-03")).toBe(true);
    expect(isCanadianMarketHoliday("2026-09-30")).toBe(false);
    expect(isCanadianMarketHoliday("2026-11-11")).toBe(false);
    expect(isCanadianMarketHoliday("2026-12-28")).toBe(true);
    expect(isCanadianMarketHoliday("2027-12-27")).toBe(true);
    expect(isCanadianMarketHoliday("2027-12-28")).toBe(true);
  });
});
