import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MigrationStateRepository } from "../../src/db/migration-state";
import { RunRepository } from "../../src/db/runs";
import { TickerRepository } from "../../src/db/tickers";
import { LegacyDualWriteService } from "../../src/services/legacy-dual-write";
import { LegacyFactMigrator } from "../../src/services/legacy-fact-migrator";

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
  ticker: Awaited<ReturnType<typeof insertTicker>>;
  repository: RunRepository;
  price?: {
    previousDate: string;
    previousPrice: number;
    currentPrice: number;
    changeAmount: number;
    changePct: number;
    priceBasis?: "adjusted" | "close";
  } | null;
  withAnalysis?: boolean;
}) => {
  const run = await input.repository.createRun({
    tradingDate: input.date,
    origin: input.origin ?? "scheduled",
    backfillJobId: null,
    tickers: [input.ticker],
    now,
  });
  const screeningId = run.screeningIds[0];
  if (!screeningId) throw new Error("screening_missing");
  if (input.price) {
    await input.repository.savePrice(screeningId, {
      ...input.price,
      priceBasis: input.price.priceBasis ?? "adjusted",
      qualified: input.price.changePct >= 5,
    });
    if (input.withAnalysis !== false && input.price.changePct >= 5) {
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
  await input.repository.finalizeRun(run.runId, now);
  return run;
};

const migrator = (
  options: ConstructorParameters<typeof LegacyFactMigrator>[1] = {},
) =>
  new LegacyFactMigrator(env.DB, {
    enabled: true,
    now: () => new Date(now),
    ...options,
  });

const runUntilComplete = async (
  service: LegacyFactMigrator,
  pageSize = 2,
): Promise<void> => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const result = await service.runPage({ pageSize, now });
    if (result.status === "complete") return;
    expect(result.status).toBe("running");
  }
  throw new Error("migration_did_not_complete");
};

describe("legacy published-generation migrator", () => {
  it("is inert when the exact migrator flag is disabled", async () => {
    const ticker = await insertTicker("migrator-off", "MOFF");
    const repository = new RunRepository(env.DB);
    await prepareRun({
      date: "2026-07-09",
      ticker,
      repository,
      price: {
        previousDate: "2026-07-08",
        previousPrice: 100,
        currentPrice: 110,
        changeAmount: 10,
        changePct: 10,
      },
    });
    const service = new LegacyFactMigrator(env.DB, { enabled: false });
    expect((await service.runPage({ now })).status).toBe("disabled");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM daily_market_facts",
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM portfolio_migration_audit",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("records a per-screening audit when source loading fails", async () => {
    const ticker = await insertTicker("migrator-source-error", "MSERR");
    const repository = new RunRepository(env.DB);
    const run = await prepareRun({
      date: "2026-07-09",
      ticker,
      repository,
      price: {
        previousDate: "2026-07-08",
        previousPrice: 100,
        currentPrice: 110,
        changeAmount: 10,
        changePct: 10,
      },
    });
    const service = migrator({
      beforeSourceRead: () => {
        throw new Error("source_read_transient");
      },
    });
    const result = await service.runPage({ now });
    expect(result.errors).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT outcome, reason_code, reason_message, content_hash, provenance_hash FROM portfolio_migration_audit WHERE legacy_screening_id = ?1",
      )
        .bind(run.screeningIds[0])
        .first(),
    ).toMatchObject({
      outcome: "error",
      reason_code: "migration_materialization_failed",
      reason_message: "source_read_transient",
    });
    const retry = await migrator().runPage({ now });
    expect(retry).toMatchObject({ status: "complete", inserted: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM daily_market_facts",
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("selects only the published replacement generation and preserves provenance", async () => {
    const ticker = await insertTicker("migrator-replacement", "MREP");
    const repository = new RunRepository(env.DB);
    const original = await prepareRun({
      date: "2026-07-08",
      ticker,
      repository,
      price: {
        previousDate: "2026-07-07",
        previousPrice: 100,
        currentPrice: 101,
        changeAmount: 1,
        changePct: 1,
        priceBasis: "close",
      },
      withAnalysis: false,
    });
    const replacement = await prepareRun({
      date: "2026-07-08",
      origin: "backfill",
      ticker,
      repository,
      price: {
        previousDate: "2026-07-07",
        previousPrice: 100,
        currentPrice: 120,
        changeAmount: 20,
        changePct: 20,
        priceBasis: "close",
      },
    });
    const service = migrator();
    await runUntilComplete(service, 1);
    expect(
      await env.DB.prepare(
        "SELECT current_raw_close_decimal, provider_revision, movement_basis, raw_close_difference_decimal FROM daily_market_facts",
      ).first(),
    ).toEqual({
      current_raw_close_decimal: "120",
      provider_revision: `legacy-report:${replacement.runId}:2:${replacement.screeningIds[0]}`,
      movement_basis: "legacy_migration",
      raw_close_difference_decimal: "20",
    });
    expect(
      await env.DB.prepare("SELECT published FROM report_runs WHERE id = ?1")
        .bind(original.runId)
        .first(),
    ).toEqual({ published: 0 });
    expect(
      await env.DB.prepare(
        "SELECT legacy_run_id, legacy_generation, outcome, provenance_hash, content_hash FROM portfolio_migration_audit",
      ).first(),
    ).toMatchObject({
      legacy_run_id: replacement.runId,
      legacy_generation: 2,
      outcome: "inserted",
    });
  });

  it("matches dual-write provenance and fingerprint without ETag churn", async () => {
    const ticker = await insertTicker("migrator-dual", "MDUAL");
    const dualWrite = new LegacyDualWriteService(env.DB, {
      enabled: true,
      now: () => new Date(now),
    });
    const repository = new RunRepository(env.DB, dualWrite);
    const run = await prepareRun({
      date: "2026-07-07",
      ticker,
      repository,
      price: {
        previousDate: "2026-07-06",
        previousPrice: 100,
        currentPrice: 110,
        changeAmount: 10,
        changePct: 10,
      },
    });
    const before = await env.DB.prepare(
      "SELECT revision FROM fact_revision_buckets WHERE bucket_key = '2026-07'",
    ).first();
    const result = await migrator().runPage({ now });
    const after = await env.DB.prepare(
      "SELECT revision FROM fact_revision_buckets WHERE bucket_key = '2026-07'",
    ).first();
    expect(result).toMatchObject({
      status: "complete",
      inserted: 0,
      updated: 0,
      unchanged: 1,
    });
    expect(after).toEqual(before);
    expect(
      await env.DB.prepare(
        "SELECT provider_revision FROM daily_market_facts",
      ).first(),
    ).toEqual({
      provider_revision: `legacy-report:${run.runId}:1:${run.screeningIds[0]}`,
    });
  });

  it("keeps deleted identities, exposes missing analysis/price, and resumes pages", async () => {
    const priced = await insertTicker("migrator-deleted", "MDEL");
    const missing = await insertTicker("migrator-missing", "MMISS");
    const orphan = await insertTicker("migrator-orphan", "MORPH");
    await new TickerRepository(env.DB).softDelete(priced.id, now);
    await new TickerRepository(env.DB).softDelete(orphan.id, now);
    const repository = new RunRepository(env.DB);
    await prepareRun({
      date: "2026-07-05",
      ticker: priced,
      repository,
      price: {
        previousDate: "2026-07-03",
        previousPrice: 100,
        currentPrice: 101,
        changeAmount: 1,
        changePct: 1,
      },
      withAnalysis: false,
    });
    const missingRun = await prepareRun({
      date: "2026-07-06",
      ticker: missing,
      repository,
      price: {
        previousDate: "2026-07-03",
        previousPrice: 100,
        currentPrice: 101,
        changeAmount: 1,
        changePct: 1,
      },
    });
    await env.DB.prepare(
      `UPDATE screenings SET current_price = NULL, status = 'complete',
             qualified = 0 WHERE id = ?1`,
    )
      .bind(missingRun.screeningIds[0])
      .run();
    const service = migrator();
    const first = await service.runPage({ pageSize: 1, now });
    expect(first.status).toBe("running");
    expect(first.cursor).not.toBeNull();
    await runUntilComplete(service, 1);
    expect(
      await env.DB.prepare(
        "SELECT symbol FROM instruments ORDER BY symbol",
      ).all(),
    ).toMatchObject({
      results: [{ symbol: "MDEL" }, { symbol: "MMISS" }, { symbol: "MORPH" }],
    });
    expect(
      await env.DB.prepare(
        "SELECT provider_metadata_json FROM instruments WHERE symbol = 'MORPH'",
      ).first(),
    ).toEqual({
      provider_metadata_json: JSON.stringify({
        legacyTickerId: orphan.id,
        legacyActive: false,
        legacyDeletedAt: now,
      }),
    });
    expect(
      await env.DB.prepare("SELECT status FROM movement_analyses").first(),
    ).toEqual({ status: "pending" });
    expect(
      await env.DB.prepare(
        "SELECT outcome, reason_code FROM portfolio_migration_audit WHERE legacy_screening_id = ?1",
      )
        .bind(missingRun.screeningIds[0])
        .first(),
    ).toEqual({ outcome: "skipped", reason_code: "migration_missing_price" });
    const state = await new MigrationStateRepository(env.DB).get();
    expect(state?.cursor).toBeNull();
  });

  it("is idempotent, audits hash mismatches, and supports a two-pass clean catch-up", async () => {
    const ticker = await insertTicker("migrator-hash", "MHASH");
    const repository = new RunRepository(env.DB);
    const run = await prepareRun({
      date: "2026-07-04",
      ticker,
      repository,
      price: {
        previousDate: "2026-07-03",
        previousPrice: 100,
        currentPrice: 110,
        changeAmount: 10,
        changePct: 10,
      },
    });
    const service = migrator();
    await runUntilComplete(service, 1);
    const firstFact = await env.DB.prepare(
      "SELECT provider_revision FROM daily_market_facts",
    ).first();
    await runUntilComplete(service, 1);
    const stateAfterCleanPass = await new MigrationStateRepository(
      env.DB,
    ).get();
    expect(stateAfterCleanPass?.passNumber).toBe(2);
    expect(stateAfterCleanPass?.consecutiveCleanPasses).toBe(2);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM portfolio_migration_audit",
      ).first(),
    ).toEqual({ count: 1 });
    await env.DB.prepare(
      "UPDATE screenings SET current_price = 111 WHERE id = ?1",
    )
      .bind(run.screeningIds[0])
      .run();
    await runUntilComplete(service, 1);
    expect(
      await env.DB.prepare(
        "SELECT outcome, reason_code FROM portfolio_migration_audit ORDER BY examined_at DESC, rowid DESC LIMIT 1",
      ).first(),
    ).toEqual({
      outcome: "mismatched",
      reason_code: "migration_hash_mismatch",
    });
    expect(
      await env.DB.prepare(
        "SELECT provider_revision FROM daily_market_facts",
      ).first(),
    ).toEqual(firstFact);
    const failingRetry = migrator({
      beforeSourceRead: () => {
        throw new Error("source_read_after_mismatch");
      },
    });
    expect((await failingRetry.runPage({ now })).errors).toBe(1);
    const successfulRetry = await migrator().runPage({ now });
    expect(successfulRetry).toMatchObject({
      status: "complete",
      mismatched: 1,
      inserted: 0,
      updated: 0,
    });
    expect(
      await env.DB.prepare(
        "SELECT provider_revision FROM daily_market_facts",
      ).first(),
    ).toEqual(firstFact);
  });

  it("uses a lease so a concurrent page cannot claim the active migration", async () => {
    const ticker = await insertTicker("migrator-lease", "MLEASE");
    const repository = new RunRepository(env.DB);
    await prepareRun({
      date: "2026-07-03",
      ticker,
      repository,
      price: {
        previousDate: "2026-07-02",
        previousPrice: 100,
        currentPrice: 110,
        changeAmount: 10,
        changePct: 10,
      },
    });
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = migrator({
      beforePage: async () => {
        started();
        await hold;
      },
    });
    const firstRun = first.runPage({ now });
    await startedPromise;
    const second = await migrator().runPage({ now });
    expect(second.status).toBe("leased");
    release();
    expect((await firstRun).status).toBe("complete");
  });

  it("defers a newly published run beyond the pass-start high-water mark", async () => {
    const initialTicker = await insertTicker("migrator-hwm-initial", "MHWM1");
    const laterTicker = await insertTicker("migrator-hwm-later", "MHWM2");
    const repository = new RunRepository(env.DB);
    await prepareRun({
      date: "2026-07-09",
      ticker: initialTicker,
      repository,
      price: {
        previousDate: "2026-07-08",
        previousPrice: 100,
        currentPrice: 110,
        changeAmount: 10,
        changePct: 10,
      },
    });
    let insertedLater = false;
    const service = migrator({
      beforePage: async () => {
        if (insertedLater) return;
        insertedLater = true;
        await prepareRun({
          date: "2026-07-10",
          ticker: laterTicker,
          repository,
          price: {
            previousDate: "2026-07-09",
            previousPrice: 100,
            currentPrice: 120,
            changeAmount: 20,
            changePct: 20,
          },
        });
      },
    });
    const first = await service.runPage({ pageSize: 100, now });
    expect(first.status).toBe("complete");
    expect(first.highWater?.tradingDate).toBe("2026-07-09");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM daily_market_facts",
      ).first(),
    ).toEqual({ count: 1 });
    const second = await service.runPage({ pageSize: 100, now });
    expect(second.status).toBe("complete");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM daily_market_facts",
      ).first(),
    ).toEqual({ count: 2 });
  });

  it("captures a missing high-water mark before resuming an active cursor", async () => {
    const firstTicker = await insertTicker("migrator-hwm-repair-1", "MHRP1");
    const secondTicker = await insertTicker("migrator-hwm-repair-2", "MHRP2");
    const repository = new RunRepository(env.DB);
    await prepareRun({
      date: "2026-07-01",
      ticker: firstTicker,
      repository,
      price: {
        previousDate: "2026-06-30",
        previousPrice: 100,
        currentPrice: 110,
        changeAmount: 10,
        changePct: 10,
      },
    });
    await prepareRun({
      date: "2026-07-02",
      ticker: secondTicker,
      repository,
      price: {
        previousDate: "2026-07-01",
        previousPrice: 100,
        currentPrice: 120,
        changeAmount: 20,
        changePct: 20,
      },
    });
    const service = migrator();
    const first = await service.runPage({ pageSize: 1, now });
    expect(first.status).toBe("running");
    await env.DB.prepare(
      `UPDATE portfolio_migration_state
          SET high_water_generation = NULL`,
    ).run();
    const resumed = await service.runPage({ pageSize: 1, now });
    expect(resumed.examined).toBe(1);
    expect(resumed.highWater).toMatchObject({
      tradingDate: "2026-07-02",
      generation: 1,
    });
    await runUntilComplete(service, 1);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM daily_market_facts",
      ).first(),
    ).toEqual({ count: 2 });
  });

  it("repairs a null high-water tuple when a running pass has no cursor", async () => {
    const ticker = await insertTicker("migrator-hwm-repair-running", "MHRUN");
    const repository = new RunRepository(env.DB);
    await prepareRun({
      date: "2026-07-03",
      ticker,
      repository,
      price: {
        previousDate: "2026-07-02",
        previousPrice: 100,
        currentPrice: 115,
        changeAmount: 15,
        changePct: 15,
      },
    });
    await env.DB.prepare(
      `UPDATE portfolio_migration_state
          SET status = 'running',
              cursor_trading_date = NULL,
              cursor_generation = NULL,
              cursor_run_id = NULL,
              cursor_screening_id = NULL,
              high_water_trading_date = NULL,
              high_water_generation = NULL,
              high_water_run_id = NULL,
              lease_owner = NULL,
              lease_until = NULL`,
    ).run();

    const result = await migrator().runPage({ pageSize: 2, now });
    expect(result).toMatchObject({
      status: "complete",
      examined: 1,
      inserted: 1,
      highWater: { tradingDate: "2026-07-03", generation: 1 },
    });
  });
});
