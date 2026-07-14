import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { RetentionCleanupService } from "../../src/services/retention-cleanup";

const now = "2026-07-11T12:00:00.000Z";
const old90 = "2026-04-01T12:00:00.000Z";
const oldYear = "2025-06-01T12:00:00.000Z";

describe("retention cleanup", () => {
  it("deletes bounded derived workflow artifacts while preserving facts and digests", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO instruments
         (id, symbol, company_name, exchange, currency, instrument_type,
          provider, provider_symbol, created_at, updated_at)
         VALUES ('cleanup-instrument', 'CLEAN', 'Cleanup Corp', 'NMS', 'USD',
                 'stock', 'test', 'CLEAN', ?1, ?1)`,
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
         VALUES ('cleanup-fact', 'cleanup-instrument', '2026-07-10',
                 '2026-07-09', '99', '100', '1', '1', '99', '1', '1', '1',
                 'split_adjusted_price_return', 'test', 'r1', ?1, 'valid',
                 ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO pipeline_jobs
         (id, trigger_type, requested_start_date, requested_end_date,
          affected_instruments_json, eligibility_intervals_json, priority,
          status, created_at, updated_at, completed_at)
         VALUES ('cleanup-job', 'backfill', '2026-07-01', '2026-07-01',
                 '[]', '[]', 1, 'complete', ?1, ?1, ?2)`,
      ).bind(oldYear, oldYear),
      env.DB.prepare(
        `INSERT INTO work_items
         (id, scope, work_type, instrument_id, effective_date,
          dependency_revision, deterministic_key, state, priority,
          created_at, updated_at, completed_at)
         VALUES ('cleanup-work', 'global_fact', 'market_fact',
                 'cleanup-instrument', '2026-07-01', 'r1',
                 'cleanup-work-key', 'complete', 1, ?1, ?1, ?2)`,
      ).bind(old90, old90),
      env.DB.prepare(
        `INSERT INTO job_work_items
         (pipeline_job_id, work_item_id, relationship, outcome, created_at)
         VALUES ('cleanup-job', 'cleanup-work', 'required', 'processed', ?1)`,
      ).bind(old90),
      env.DB.prepare(
        `INSERT INTO import_batches
         (id, file_digest, original_filename, base_position_basis_revision,
          status, expires_at, committed_at, created_at, updated_at)
         VALUES ('cleanup-import', 'cleanup-digest', 'events.csv', 0,
                 'committed', ?1, ?2, ?2, ?2)`,
      ).bind(oldYear, oldYear),
    ]);

    const service = new RetentionCleanupService({
      db: env.DB,
      now: () => new Date(now),
      batchSize: 1,
    });
    const first = await service.run(now);
    expect(first.deletedJobLinks).toBe(1);
    expect(first.deletedWorkItems).toBe(1);
    expect(first.deletedPipelineJobs).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT id FROM daily_market_facts WHERE id = 'cleanup-fact'",
      ).first(),
    ).toEqual({ id: "cleanup-fact" });
    expect(
      await env.DB.prepare(
        "SELECT file_digest FROM import_batches WHERE id = 'cleanup-import'",
      ).first(),
    ).toEqual({ file_digest: "cleanup-digest" });
  });

  it("does not delete work at the retention boundary", async () => {
    await env.DB.prepare(
      `INSERT INTO instruments
       (id, symbol, company_name, exchange, currency, instrument_type,
        provider, provider_symbol, created_at, updated_at)
       VALUES ('cleanup-boundary-instrument', 'BOUND', 'Boundary Corp',
               'NMS', 'USD', 'stock', 'test', 'BOUND', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO work_items
       (id, scope, work_type, instrument_id, effective_date,
        dependency_revision, deterministic_key, state, priority,
        created_at, updated_at, completed_at)
       VALUES ('cleanup-boundary-work', 'global_fact', 'market_fact',
               'cleanup-boundary-instrument', '2026-07-01', 'r1',
               'cleanup-boundary-key', 'complete', 1, ?1, ?1, ?2)`,
    )
      .bind("2026-04-13T12:00:00.000Z", "2026-04-13T12:00:00.000Z")
      .run();
    await new RetentionCleanupService({
      db: env.DB,
      now: () => new Date(now),
    }).run(now);
    expect(
      await env.DB.prepare(
        "SELECT id FROM work_items WHERE id = 'cleanup-boundary-work'",
      ).first(),
    ).toEqual({ id: "cleanup-boundary-work" });
  });

  it("resumes bounded import-row cleanup on the next tick", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO import_batches
         (id, file_digest, original_filename, base_position_basis_revision,
          status, expires_at, created_at, updated_at)
         VALUES ('cleanup-staging-import', 'cleanup-staging-digest',
                 'events.csv', 0, 'pending', '2026-07-01T12:00:00.000Z',
                 ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO import_rows
         (id, import_batch_id, row_number, symbol, category_name,
          account_name, status)
         VALUES ('cleanup-staging-row-1', 'cleanup-staging-import', 2,
                 'AAPL', 'Uncategorized', 'Default Account', 'invalid')`,
      ),
      env.DB.prepare(
        `INSERT INTO import_rows
         (id, import_batch_id, row_number, symbol, category_name,
          account_name, status)
         VALUES ('cleanup-staging-row-2', 'cleanup-staging-import', 3,
                 'MSFT', 'Uncategorized', 'Default Account', 'invalid')`,
      ),
    ]);
    const service = new RetentionCleanupService({
      db: env.DB,
      now: () => new Date(now),
      batchSize: 1,
    });
    await expect(service.run(now)).resolves.toEqual(
      expect.objectContaining({
        expiredImportBatches: 1,
        deletedImportRows: 1,
      }),
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM import_rows WHERE import_batch_id = 'cleanup-staging-import'",
      ).first(),
    ).toEqual({ count: 1 });
    await service.run(now);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM import_rows WHERE import_batch_id = 'cleanup-staging-import'",
      ).first(),
    ).toEqual({ count: 0 });
  });
});
