import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { PipelineJobRepository } from "../../src/db/pipeline-jobs";
import { PositionBasisRepository } from "../../src/db/position-basis";
import { TransactionRepository } from "../../src/db/transactions";
import { WorkItemRepository } from "../../src/db/work-items";

const now = "2026-07-10T12:00:00.000Z";

async function insertInstrument(id = "instrument-1") {
  await env.DB.prepare(
    `INSERT INTO instruments
     (id, symbol, company_name, exchange, currency, instrument_type,
      provider, provider_symbol, created_at, updated_at)
     VALUES (?1, 'SHOP.TO', 'Shopify', 'TSX', 'CAD', 'stock',
             'yahoo', 'SHOP.TO', ?2, ?2)`,
  )
    .bind(id, now)
    .run();
}

describe("portfolio ledger migration", () => {
  it("applies additively and preserves legacy tables", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = tables.results.map(({ name }) => name);
    expect(names).toEqual(
      expect.arrayContaining([
        "tickers",
        "report_runs",
        "screenings",
        "instruments",
        "transactions",
        "corporate_actions",
        "corporate_action_coverage",
        "position_basis_state",
        "ledger_mutations",
        "import_batches",
        "import_rows",
        "pipeline_jobs",
        "work_items",
        "job_work_items",
      ]),
    );

    const state = await env.DB.prepare(
      "SELECT revision FROM position_basis_state WHERE id = 1",
    ).first<{ revision: number }>();
    expect(state?.revision).toBe(0);
  });

  it("enforces transaction revisions, statuses, indexes, and foreign keys", async () => {
    await insertInstrument();
    await env.DB.prepare(
      `INSERT INTO transactions
       (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
        revision, created_at, updated_at)
       VALUES ('tx-1', 'instrument-1', '2026-01-02', 'buy', '1.25', '99.50', 1, ?1, ?1)`,
    )
      .bind(now)
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
          revision, created_at, updated_at)
         VALUES ('tx-bad', 'instrument-1', '2026-01-03', 'hold', '1', '1', 0, ?1, ?1)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare("DELETE FROM instruments WHERE id = 'instrument-1'").run(),
    ).rejects.toThrow();

    const indexes = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index'",
    ).all<{ name: string }>();
    expect(indexes.results.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "transactions_instrument_date_idx",
        "transactions_events_idx",
        "corporate_actions_instrument_date_idx",
        "work_items_state_priority_idx",
        "work_items_one_planner_per_job_idx",
      ]),
    );
  });

  it("keeps best-effort retrieval distinct from exact user confirmation", async () => {
    await insertInstrument();
    await env.DB.prepare(
      `INSERT INTO corporate_action_coverage
       (instrument_id, provider, requested_start_date, requested_end_date,
        snapshot_provider_revision, retrieved_at, status, updated_at)
       VALUES ('instrument-1', 'yahoo', '2020-01-01', '2026-07-10',
               'snapshot-r1', ?1, 'review_required', ?1)`,
    )
      .bind(now)
      .run();
    const coverage = await env.DB.prepare(
      `SELECT requested_start_date, requested_end_date, snapshot_provider_revision,
              retrieved_at, confirmed_start_date, confirmed_end_date,
              confirmed_provider_revision, confirmed_at
       FROM corporate_action_coverage WHERE instrument_id = 'instrument-1'`,
    ).first<Record<string, string | null>>();
    expect(coverage).toMatchObject({
      requested_start_date: "2020-01-01",
      requested_end_date: "2026-07-10",
      snapshot_provider_revision: "snapshot-r1",
      confirmed_start_date: null,
      confirmed_end_date: null,
      confirmed_provider_revision: null,
      confirmed_at: null,
    });

    await expect(
      env.DB.prepare(
        `UPDATE corporate_action_coverage
         SET status = 'confirmed', confirmed_start_date = '2020-01-01'
         WHERE instrument_id = 'instrument-1'`,
      ).run(),
    ).rejects.toThrow();

    await env.DB.prepare(
      `UPDATE corporate_action_coverage
       SET status = 'confirmed', confirmed_start_date = requested_start_date,
           confirmed_end_date = requested_end_date,
           confirmed_provider_revision = snapshot_provider_revision,
           confirmed_at = ?1
       WHERE instrument_id = 'instrument-1'`,
    )
      .bind(now)
      .run();
    expect(
      await env.DB.prepare(
        `SELECT confirmed_start_date, confirmed_end_date,
                confirmed_provider_revision, confirmed_at
         FROM corporate_action_coverage WHERE instrument_id = 'instrument-1'`,
      ).first(),
    ).toEqual({
      confirmed_start_date: "2020-01-01",
      confirmed_end_date: "2026-07-10",
      confirmed_provider_revision: "snapshot-r1",
      confirmed_at: now,
    });
  });

  it("supports candidate, active, superseded, and quarantined split revisions", async () => {
    await insertInstrument();
    for (const [index, status] of [
      "candidate",
      "active",
      "superseded",
      "quarantined",
    ].entries()) {
      await env.DB.prepare(
        `INSERT INTO corporate_actions
         (id, instrument_id, action_type, effective_date, split_numerator,
          split_denominator, provider, provider_event_id, provider_revision,
          retrieved_at, revision, status, conflict_code, created_at, updated_at)
         VALUES (?1, 'instrument-1', 'split', '2024-01-01', '2', '1',
                 'yahoo', ?2, ?3, ?4, 1, ?5, ?6, ?4, ?4)`,
      )
        .bind(
          `action-${index}`,
          `event-${index}`,
          `r${index}`,
          now,
          status,
          status === "quarantined" ? "negative_history" : null,
        )
        .run();
    }
    await expect(
      env.DB.prepare(
        `INSERT INTO corporate_actions
         (id, instrument_id, action_type, effective_date, split_numerator,
          split_denominator, provider, provider_event_id, provider_revision,
          retrieved_at, revision, status, created_at, updated_at)
         VALUES ('bad', 'instrument-1', 'split', '2024-01-01', '2', '1',
                 'yahoo', 'bad', 'bad', ?1, 1, 'verified', ?1, ?1)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow();
  });

  it("enforces unique import digests and staging cascade retention", async () => {
    await env.DB.prepare(
      `INSERT INTO import_batches
       (id, file_digest, original_filename, base_position_basis_revision,
        status, expires_at, created_at, updated_at)
       VALUES ('batch-1', 'digest-1', 'events.csv', 0, 'preview',
               '2026-07-11T12:00:00.000Z', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO import_rows
       (id, import_batch_id, row_number, symbol, trade_date, side,
        quantity_decimal, price_decimal, status)
       VALUES ('row-1', 'batch-1', 2, 'SHOP.TO', '2026-01-02', 'buy',
               '1', '10', 'valid')`,
    ).run();
    await expect(
      env.DB.prepare(
        `INSERT INTO import_batches
         (id, file_digest, original_filename, base_position_basis_revision,
          status, expires_at, created_at, updated_at)
         VALUES ('batch-2', 'digest-1', 'copy.csv', 0, 'preview',
                 '2026-07-11T12:00:00.000Z', ?1, ?1)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow();
    await env.DB.prepare(
      "DELETE FROM import_batches WHERE id = 'batch-1'",
    ).run();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM import_rows").first<{
        count: number;
      }>(),
    ).toEqual({ count: 0 });
  });

  it("models complete job-scoped and global deterministic work", async () => {
    await insertInstrument();
    await env.DB.prepare(
      `INSERT INTO pipeline_jobs
       (id, trigger_type, requested_start_date, requested_end_date,
        affected_instruments_json, eligibility_intervals_json, priority, status,
        created_at, updated_at)
       VALUES ('job-1', 'ledger_reconciliation', '2026-01-01', '2026-07-10',
               '["instrument-1"]', '[]', 100, 'pending', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO work_items
       (id, scope, pipeline_job_id, work_type, deterministic_key, state,
        priority, attempt_count, max_attempts, created_at, updated_at)
       VALUES ('planning-1', 'job_planning', 'job-1', 'reconciliation_plan',
               'job:job-1:plan', 'pending', 100, 0, 3, ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO work_items
       (id, scope, pipeline_job_id, work_type, instrument_id, effective_date,
        dependency_revision, forced_refresh_generation, deterministic_key,
        state, priority, attempt_count, max_attempts, created_at, updated_at)
       VALUES ('global-1', 'global_fact', NULL, 'market_fact', 'instrument-1',
               '2026-07-10', 'basis:1', 2, 'market:instrument-1:2026-07-10:basis:1:2',
               'pending', 50, 0, 3, ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO job_work_items
       (pipeline_job_id, work_item_id, relationship, outcome, created_at)
       VALUES ('job-1', 'global-1', 'required', 'pending', ?1)`,
    )
      .bind(now)
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO work_items
         (id, scope, work_type, deterministic_key, state, priority,
          attempt_count, max_attempts, created_at, updated_at)
         VALUES ('bad-planner', 'job_planning', 'reconciliation_plan', 'bad',
                 'pending', 1, 0, 3, ?1, ?1)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow();
  });
});

describe("ledger mutation token", () => {
  it("supports an atomic mutation with its job-scoped planning item", async () => {
    await insertInstrument();
    const basis = new PositionBasisRepository(env.DB);
    const transactions = new TransactionRepository(env.DB);
    const jobs = new PipelineJobRepository(env.DB);
    const work = new WorkItemRepository(env.DB);

    await env.DB.batch([
      basis.mutationTokenStatement({
        id: "mutation-atomic",
        expectedRevision: 0,
        kind: "transaction_create",
        createdAt: now,
      }),
      transactions.insertStatement({
        id: "tx-atomic",
        instrumentId: "instrument-1",
        tradeDate: "2026-01-02",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "10",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }),
      jobs.createStatement({
        id: "job-atomic",
        triggerType: "ledger_reconciliation",
        requestedStartDate: "2026-01-02",
        requestedEndDate: "2026-07-10",
        affectedInstrumentsJson: '["instrument-1"]',
        eligibilityIntervalsJson: "[]",
        priority: 100,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      }),
      work.createPlanningStatement({
        id: "work-atomic",
        pipelineJobId: "job-atomic",
        workType: "reconciliation_plan",
        deterministicKey: "job:job-atomic:plan",
        priority: 100,
        maxAttempts: 3,
        createdAt: now,
        updatedAt: now,
      }),
      work.linkToJobStatement({
        pipelineJobId: "job-atomic",
        workItemId: "work-atomic",
        relationship: "required",
        createdAt: now,
      }),
    ]);

    expect(await basis.revision()).toBe(1);
    expect(await transactions.listForInstrument("instrument-1")).toHaveLength(
      1,
    );
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM job_work_items
         WHERE pipeline_job_id = 'job-atomic'`,
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("lets only one competing expected revision commit without partial writes", async () => {
    await insertInstrument();
    const mutation = (suffix: string) =>
      env.DB.batch([
        env.DB.prepare(
          `INSERT INTO ledger_mutations
           (id, expected_revision, resulting_revision, mutation_kind, created_at)
           VALUES (?1, 0, 1, 'transaction_create', ?2)`,
        ).bind(`mutation-${suffix}`, now),
        env.DB.prepare(
          `INSERT INTO transactions
           (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
            revision, created_at, updated_at)
           VALUES (?1, 'instrument-1', '2026-01-02', 'buy', '1', '10', 1, ?2, ?2)`,
        ).bind(`tx-${suffix}`, now),
      ]);

    const results = await Promise.allSettled([mutation("a"), mutation("b")]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    expect(
      await env.DB.prepare(
        "SELECT revision FROM position_basis_state WHERE id = 1",
      ).first(),
    ).toEqual({ revision: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 1 });
  });
});
