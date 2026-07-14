import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { PipelineJobRepository } from "../../src/db/pipeline-jobs";
import { PositionBasisRepository } from "../../src/db/position-basis";
import { TransactionRepository } from "../../src/db/transactions";
import { WorkItemRepository } from "../../src/db/work-items";
import { YahooMarketDataProvider } from "../../src/providers/yahoo";
import { YahooCorporateActionProvider } from "../../src/providers/yahoo-corporate-actions";
import { easternMarketDate } from "../../src/shared/dates";

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
        "backfill_jobs",
        "report_runs",
        "screenings",
        "dispatch_events",
        "analyses",
        "sources",
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
         VALUES ('tx-bad-side', 'instrument-1', '2026-01-03', 'hold', '1', '1', 1, ?1, ?1)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
          revision, created_at, updated_at)
         VALUES ('tx-bad-revision', 'instrument-1', '2026-01-03', 'buy', '1', '1', 0, ?1, ?1)`,
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

  it.each([
    [
      "snapshot revision",
      null,
      now,
      "2020-01-01",
      "2026-07-10",
      "snapshot-r1",
      now,
    ],
    [
      "retrieval time",
      "snapshot-r1",
      null,
      "2020-01-01",
      "2026-07-10",
      "snapshot-r1",
      now,
    ],
    [
      "confirmed start",
      "snapshot-r1",
      now,
      null,
      "2026-07-10",
      "snapshot-r1",
      now,
    ],
    [
      "confirmed end",
      "snapshot-r1",
      now,
      "2020-01-01",
      null,
      "snapshot-r1",
      now,
    ],
    [
      "confirmed revision",
      "snapshot-r1",
      now,
      "2020-01-01",
      "2026-07-10",
      null,
      now,
    ],
    [
      "confirmation time",
      "snapshot-r1",
      now,
      "2020-01-01",
      "2026-07-10",
      "snapshot-r1",
      null,
    ],
  ])("rejects confirmed coverage missing %s", async (_label, snapshotProviderRevision, retrievedAt, confirmedStartDate, confirmedEndDate, confirmedProviderRevision, confirmedAt) => {
    await insertInstrument();
    await expect(
      env.DB.prepare(
        `INSERT INTO corporate_action_coverage
           (instrument_id, provider, requested_start_date, requested_end_date,
            snapshot_provider_revision, retrieved_at, confirmed_start_date,
            confirmed_end_date, confirmed_provider_revision, confirmed_at,
            status, updated_at)
           VALUES ('instrument-1', 'yahoo', '2020-01-01', '2026-07-10',
                   ?1, ?2, ?3, ?4, ?5, ?6, 'confirmed', ?7)`,
      )
        .bind(
          snapshotProviderRevision,
          retrievedAt,
          confirmedStartDate,
          confirmedEndDate,
          confirmedProviderRevision,
          confirmedAt,
          now,
        )
        .run(),
    ).rejects.toThrow();
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

  it("allows repeated import digests and keeps staging cascade retention", async () => {
    await env.DB.prepare(
      `INSERT INTO import_batches
       (id, file_digest, original_filename, base_position_basis_revision,
        status, expires_at, created_at, updated_at)
       VALUES ('batch-1', 'digest-1', 'events.csv', 0, 'pending',
               '2026-07-11T12:00:00.000Z', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO import_rows
       (id, import_batch_id, row_number, symbol, trade_date, side,
        quantity_decimal, price_decimal, account_id, category_name,
        account_name, status)
       VALUES ('row-1', 'batch-1', 2, 'SHOP.TO', '2026-01-02', 'buy',
               '1', '10', 'account-default', 'Uncategorized',
               'Default Account', 'valid')`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO import_batches
       (id, file_digest, original_filename, base_position_basis_revision,
        status, expires_at, created_at, updated_at)
       VALUES ('batch-2', 'digest-1', 'copy.csv', 0, 'pending',
               '2026-07-11T12:00:00.000Z', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      "DELETE FROM import_batches WHERE id = 'batch-1'",
    ).run();
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM import_rows").first<{
        count: number;
      }>(),
    ).toEqual({ count: 0 });
  });

  it("retains import identity while cascading job-owned planning links", async () => {
    await env.DB.prepare(
      `INSERT INTO pipeline_jobs
       (id, trigger_type, affected_instruments_json, eligibility_intervals_json,
        priority, status, created_at, updated_at)
       VALUES ('job-retained', 'ledger_reconciliation', '[]', '[]', 1,
               'complete', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO import_batches
       (id, file_digest, original_filename, base_position_basis_revision,
        status, result_pipeline_job_id, expires_at, committed_at,
        created_at, updated_at)
       VALUES ('batch-retained', 'digest-retained', 'events.csv', 0,
               'committed', 'job-retained', '2026-07-11T12:00:00.000Z', ?1,
               ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO work_items
       (id, scope, pipeline_job_id, work_type, deterministic_key, state,
        priority, attempt_count, max_attempts, created_at, updated_at)
       VALUES ('planning-retained', 'job_planning', 'job-retained',
               'reconciliation_plan', 'job:job-retained:plan', 'complete',
               1, 1, 3, ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO job_work_items
       (pipeline_job_id, work_item_id, relationship, outcome, created_at)
       VALUES ('job-retained', 'planning-retained', 'required', 'processed', ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO work_items
       (id, scope, pipeline_job_id, work_type, deterministic_key, state,
        priority, attempt_count, max_attempts, created_at, updated_at)
       VALUES ('global-retained', 'global_fact', NULL, 'market_fact',
               'global:retained', 'complete', 1, 1, 3, ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.prepare(
      `INSERT INTO job_work_items
       (pipeline_job_id, work_item_id, relationship, outcome, created_at)
       VALUES ('job-retained', 'global-retained', 'required', 'reused', ?1)`,
    )
      .bind(now)
      .run();

    await env.DB.prepare(
      "DELETE FROM pipeline_jobs WHERE id = 'job-retained'",
    ).run();

    expect(
      await env.DB.prepare(
        `SELECT file_digest, status, result_pipeline_job_id
         FROM import_batches WHERE id = 'batch-retained'`,
      ).first(),
    ).toEqual({
      file_digest: "digest-retained",
      status: "committed",
      result_pipeline_job_id: null,
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM work_items WHERE id = 'planning-retained'",
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM work_items WHERE id = 'global-retained'",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM job_work_items
         WHERE work_item_id IN ('planning-retained', 'global-retained')`,
      ).first(),
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

const mutationHeaders = (legacyRevisionTags?: string): HeadersInit => {
  const basis = /position-basis-(\d+)/.exec(legacyRevisionTags ?? "")?.[1];
  const event = /event-(\d+)/.exec(legacyRevisionTags ?? "")?.[1];
  return {
    "Content-Type": "application/json",
    Host: "local",
    Origin: "http://local",
    "X-Stock-Tracker-Request": "1",
    ...(basis ? { "X-Position-Basis-Revision": basis } : {}),
    ...(event ? { "If-Match": `"event-${event}"` } : {}),
  };
};

const splitSnapshot = (
  symbol: string,
  startDate: string,
  endDate: string,
  revision = "snapshot-r1",
  events: Array<{
    type: "split";
    symbol: string;
    effectiveDate: string;
    numerator: string;
    denominator: string;
    provider: string;
    providerEventId: string;
    providerRevision: string;
  }> = [],
) => ({
  symbol: symbol.toUpperCase(),
  range: {
    requestedStartDate: startDate,
    requestedEndDate: endDate,
    coverageStartDate: null,
    coverageEndDate: null,
    isComplete: false as const,
    basis: "unverified" as const,
    provider: "yahoo-chart-v8",
    observedAt: now,
    providerRevision: revision,
  },
  events,
});

const mockSplitProvider = (revision = "snapshot-r1") =>
  vi
    .spyOn(YahooCorporateActionProvider.prototype, "getSplits")
    .mockImplementation(async (symbol, startDate, endDate) =>
      splitSnapshot(symbol, startDate, endDate, revision),
    );

const createBody = (overrides: Record<string, unknown> = {}) => ({
  symbol: "SHOP.TO",
  tradeDate: "2024-01-02",
  side: "buy",
  quantityDecimal: "1.230000",
  priceDecimal: "10.500000",
  ...overrides,
});

describe("portfolio event routes", () => {
  it("adds a valid new symbol to the watchlist before creating its transaction", async () => {
    vi.spyOn(
      YahooMarketDataProvider.prototype,
      "getInstrument",
    ).mockResolvedValue({
      metadata: {
        symbol: "SHOP.TO",
        companyName: "Shopify",
        exchange: "TSX",
        currency: "CAD",
        instrumentType: "EQUITY",
      },
      bars: [
        {
          date: "2026-07-10",
          close: 150,
          adjustedClose: 150,
          closeDecimal: "150",
          adjustedCloseDecimal: "150",
        },
      ],
      corporateActionDates: new Set<string>(),
    });
    mockSplitProvider();

    const response = await exports.default.fetch(
      new Request("http://local/api/transactions", {
        method: "POST",
        headers: mutationHeaders('"position-basis-0"'),
        body: JSON.stringify(createBody({ symbol: "shop.to" })),
      }),
    );

    expect(response.status).toBe(201);
    expect(
      (await response.json<{ transaction: { symbol: string } }>()).transaction
        .symbol,
    ).toBe("SHOP.TO");
    expect(
      await env.DB.prepare(
        "SELECT id, symbol, provider_symbol FROM instruments WHERE symbol = 'SHOP.TO'",
      ).first(),
    ).toEqual({
      id: "SHOP.TO",
      symbol: "SHOP.TO",
      provider_symbol: "SHOP.TO",
    });
    expect(
      await env.DB.prepare(
        "SELECT symbol, active FROM tickers WHERE symbol = 'SHOP.TO'",
      ).first(),
    ).toEqual({ symbol: "SHOP.TO", active: 1 });
  });

  it.each([
    "OPENW",
    "OPENL",
    "OPENZ",
  ])("creates a zero-basis %s warrant transaction without stock-only split enrichment", async (symbol) => {
    vi.spyOn(
      YahooMarketDataProvider.prototype,
      "getInstrument",
    ).mockImplementation(async (requestedSymbol) => ({
      metadata: {
        symbol: requestedSymbol.toUpperCase(),
        companyName: "Opendoor Technologies Inc.",
        exchange: "NMS",
        currency: "USD",
        instrumentType: "EQUITY",
      },
      bars: [
        {
          date: "2026-07-10",
          close: 0.25,
          adjustedClose: 0.25,
          closeDecimal: "0.25",
          adjustedCloseDecimal: "0.25",
        },
      ],
      corporateActionDates: new Set<string>(),
    }));
    const getSplits = vi.spyOn(
      YahooCorporateActionProvider.prototype,
      "getSplits",
    );

    const response = await exports.default.fetch(
      new Request("http://local/api/transactions", {
        method: "POST",
        headers: mutationHeaders('"position-basis-0"'),
        body: JSON.stringify(
          createBody({ symbol: symbol.toLowerCase(), priceDecimal: "0" }),
        ),
      }),
    );

    expect(response.status).toBe(201);
    expect(
      (
        await response.json<{
          transaction: { symbol: string; priceDecimal: string };
        }>()
      ).transaction,
    ).toMatchObject({ symbol, priceDecimal: "0" });
    expect(getSplits).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        `SELECT instruments.security_type, tickers.security_type AS ticker_type
             FROM instruments JOIN tickers ON tickers.symbol = instruments.symbol
            WHERE instruments.symbol = ?1`,
      )
        .bind(symbol)
        .first(),
    ).toEqual({ security_type: "warrant", ticker_type: "warrant" });
  });

  it("returns a paginated combined timeline with canonical decimal strings and filters", async () => {
    await insertInstrument();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
          revision, created_at, updated_at)
         VALUES ('transaction-1', 'instrument-1', '2024-01-02', 'buy', '1.23', '10.5', 1, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO corporate_actions
         (id, instrument_id, action_type, effective_date, split_numerator,
          split_denominator, provider, provider_event_id, provider_revision,
          retrieved_at, revision, status, conflict_code, conflict_message,
          created_at, updated_at)
         VALUES ('action-1', 'instrument-1', 'split', '2024-02-01', '2', '1',
                 'yahoo-chart-v8', 'split-1', 'r1', ?1, 1, 'quarantined',
                 'negative_history', 'Candidate correction conflicts with history.', ?1, ?1)`,
      ).bind(now),
    ]);

    const first = await exports.default.fetch(
      "http://local/api/events?limit=1",
    );
    expect(first.status).toBe(200);
    const firstPayload = await first.json<{
      events: Array<Record<string, unknown>>;
      nextCursor: string | null;
      positionBasisRevision: number;
    }>();
    expect(first.headers.get("ETag")).toBe('"position-basis-0"');
    expect(first.headers.get("X-Position-Basis-Revision")).toBe("0");
    expect(firstPayload.positionBasisRevision).toBe(0);
    expect(firstPayload.events).toEqual([
      expect.objectContaining({
        type: "split",
        status: "quarantined",
        conflictCode: "negative_history",
      }),
    ]);
    expect(firstPayload.nextCursor).toEqual(expect.any(String));

    const neutralRead = await exports.default.fetch(
      "http://local/data/ledger?limit=1",
    );
    expect(neutralRead.status).toBe(200);
    const neutralPayload = await neutralRead.json<{
      events: Array<Record<string, unknown>>;
    }>();
    expect(neutralPayload.events).toEqual([
      expect.objectContaining({
        type: "split",
        status: "quarantined",
      }),
    ]);

    const second = await exports.default.fetch(
      new Request(
        `http://local/api/events?limit=1&cursor=${encodeURIComponent(firstPayload.nextCursor ?? "")}`,
      ),
    );
    expect(
      (await second.json<{ events: Array<Record<string, unknown>> }>()).events,
    ).toEqual([
      expect.objectContaining({
        type: "transaction",
        quantityDecimal: "1.23",
        priceDecimal: "10.5",
        symbol: "SHOP.TO",
      }),
    ]);

    const filtered = await exports.default.fetch(
      "http://local/api/events?symbol=shop.to&type=transaction",
    );
    expect(
      (await filtered.json<{ events: Array<{ type: string }> }>()).events,
    ).toEqual([expect.objectContaining({ type: "transaction" })]);
  });

  it("allows unauthenticated reads and rejects cross-origin or non-simple mutation requests", async () => {
    expect(
      (await exports.default.fetch(new Request("http://local/api/events")))
        .status,
    ).toBe(200);

    await insertInstrument();
    const missingCustomHeader = await exports.default.fetch(
      new Request("http://local/api/events", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: "local",
          Origin: "http://local",
          "X-Position-Basis-Revision": "0",
        },
        body: JSON.stringify(createBody()),
      }),
    );
    expect(missingCustomHeader.status).toBe(403);
    expect(
      (await missingCustomHeader.json<{ error: { code: string } }>()).error
        .code,
    ).toBe("csrf_rejected");

    const crossOrigin = await exports.default.fetch(
      new Request("http://local/api/events", {
        method: "POST",
        headers: {
          ...mutationHeaders('"position-basis-0"'),
          Origin: "https://attacker.example",
        },
        body: JSON.stringify(createBody()),
      }),
    );
    expect(crossOrigin.status).toBe(403);

    const missingPrecondition = await exports.default.fetch(
      new Request("http://local/api/events", {
        method: "POST",
        headers: mutationHeaders(),
        body: JSON.stringify(createBody()),
      }),
    );
    expect(missingPrecondition.status).toBe(422);
    expect(
      (await missingPrecondition.json<{ error: { code: string } }>()).error
        .code,
    ).toBe("precondition_required");

    const forgedHost = await exports.default.fetch(
      new Request("http://local/api/events", {
        method: "POST",
        headers: {
          ...mutationHeaders('"position-basis-0"'),
          Host: "attacker.example",
          Origin: "http://attacker.example",
        },
        body: JSON.stringify(createBody()),
      }),
    );
    expect(forgedHost.status).toBe(403);

    const mismatchedHost = await exports.default.fetch(
      new Request("http://local/api/events", {
        method: "POST",
        headers: {
          ...mutationHeaders('"position-basis-0"'),
          Host: "attacker.example",
          Origin: "http://local",
        },
        body: JSON.stringify(createBody()),
      }),
    );
    expect(mismatchedHost.status).toBe(403);
  });

  it("automatically applies split history and returns canonical transaction DTOs", async () => {
    await insertInstrument();
    mockSplitProvider();
    const created = await exports.default.fetch(
      new Request("http://local/api/events", {
        method: "POST",
        headers: mutationHeaders('"position-basis-0"'),
        body: JSON.stringify(createBody()),
      }),
    );
    expect(created.status).toBe(201);
    const payload = await created.json<{
      transaction: {
        id: string;
        quantityDecimal: string;
        priceDecimal: string;
        revision: number;
      };
      positionBasisRevision: number;
    }>();
    expect(payload.transaction).toEqual(
      expect.objectContaining({
        quantityDecimal: "1.23",
        priceDecimal: "10.5",
        revision: 1,
      }),
    );
    expect(payload.positionBasisRevision).toBe(1);
    expect(created.headers.get("ETag")).toBe('"event-1"');
    expect(created.headers.get("X-Position-Basis-Revision")).toBe("1");
    expect(created.headers.get("X-Event-Revision")).toBe("1");
  });

  it("automatically activates fetched split history", async () => {
    const marketDate = easternMarketDate(new Date());
    await insertInstrument();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO transactions
         (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
          revision, created_at, updated_at)
         VALUES ('held-before-split', 'instrument-1', '2024-06-01', 'buy', '3', '10', 1, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO corporate_action_coverage
         (instrument_id, provider, requested_start_date, requested_end_date,
          snapshot_provider_revision, retrieved_at, status, updated_at)
         VALUES ('instrument-1', 'yahoo-chart-v8', '2024-01-01', ?2,
                 'split-r1', ?1, 'unavailable', ?1)`,
      ).bind(now, marketDate),
    ]);
    const split = {
      type: "split" as const,
      symbol: "SHOP.TO",
      effectiveDate: "2025-01-02",
      numerator: "2",
      denominator: "1",
      provider: "yahoo-chart-v8",
      providerEventId: "yahoo-chart-v8:SHOP.TO:split:2025-01-02",
      providerRevision: "2025-01-02|2:1",
    };
    vi.spyOn(
      YahooCorporateActionProvider.prototype,
      "getSplits",
    ).mockImplementation(async (symbol, startDate, endDate) =>
      splitSnapshot(symbol, startDate, endDate, "split-r1", [split]),
    );

    const created = await exports.default.fetch(
      new Request("http://local/api/events", {
        method: "POST",
        headers: mutationHeaders('"position-basis-0"'),
        body: JSON.stringify(
          createBody({ tradeDate: "2025-02-01", quantityDecimal: "1" }),
        ),
      }),
    );
    expect(created.status).toBe(201);
    expect(
      await env.DB.prepare(
        "SELECT status FROM corporate_actions WHERE provider_event_id = ?1",
      )
        .bind(split.providerEventId)
        .first(),
    ).toEqual({ status: "active" });
    expect(
      await env.DB.prepare(
        "SELECT status FROM corporate_action_coverage WHERE instrument_id = 'instrument-1'",
      ).first(),
    ).toEqual({ status: "confirmed" });
  });

  it("enforces event and basis revisions while applying provider revisions automatically", async () => {
    await insertInstrument();
    const provider = mockSplitProvider();
    const created = await exports.default.fetch(
      new Request("http://local/api/events", {
        method: "POST",
        headers: mutationHeaders('"position-basis-0"'),
        body: JSON.stringify(createBody()),
      }),
    );
    expect(created.status).toBe(201);
    const createdPayload = await created.json<{
      transaction: { id: string };
    }>();

    const negative = await exports.default.fetch(
      new Request("http://local/api/events", {
        method: "POST",
        headers: mutationHeaders('"position-basis-1"'),
        body: JSON.stringify(
          createBody({ side: "sell", quantityDecimal: "2" }),
        ),
      }),
    );
    expect(negative.status).toBe(422);
    expect(
      (await negative.json<{ error: { code: string } }>()).error.code,
    ).toBe("negative_holdings");

    const staleEvent = await exports.default.fetch(
      new Request(
        `http://local/api/transactions/${createdPayload.transaction.id}`,
        {
          method: "PATCH",
          headers: mutationHeaders('"position-basis-1", "event-9"'),
          body: JSON.stringify({
            tradeDate: "2024-01-02",
            side: "buy",
            quantityDecimal: "2",
            priceDecimal: "10.500000",
          }),
        },
      ),
    );
    expect(staleEvent.status).toBe(409);
    expect(
      (await staleEvent.json<{ error: { code: string } }>()).error.code,
    ).toBe("event_conflict");

    provider.mockImplementation(async (symbol, startDate, endDate) =>
      splitSnapshot(symbol, startDate, endDate, "snapshot-r2"),
    );
    const updated = await exports.default.fetch(
      new Request(`http://local/api/events/${createdPayload.transaction.id}`, {
        method: "PATCH",
        headers: mutationHeaders('"position-basis-1", "event-1"'),
        body: JSON.stringify({
          tradeDate: "2024-01-02",
          side: "buy",
          quantityDecimal: "2",
          priceDecimal: "10.500000",
        }),
      }),
    );
    expect(updated.status).toBe(200);
    expect(updated.headers.get("X-Position-Basis-Revision")).toBe("2");

    const stale = await exports.default.fetch(
      new Request(`http://local/api/events/${createdPayload.transaction.id}`, {
        method: "DELETE",
        headers: mutationHeaders('"position-basis-1", "event-2"'),
      }),
    );
    expect(stale.status).toBe(409);
    expect((await stale.json<{ error: { code: string } }>()).error.code).toBe(
      "ledger_conflict",
    );

    const deleted = await exports.default.fetch(
      new Request(`http://local/api/events/${createdPayload.transaction.id}`, {
        method: "DELETE",
        headers: mutationHeaders('"position-basis-2", "event-2"'),
      }),
    );
    expect(deleted.status).toBe(200);
    expect((await deleted.json<{ deleted: boolean }>()).deleted).toBe(true);

    const future = await exports.default.fetch(
      new Request("http://local/api/events", {
        method: "POST",
        headers: mutationHeaders('"position-basis-3"'),
        body: JSON.stringify(createBody({ tradeDate: "2099-01-01" })),
      }),
    );
    expect(future.status).toBe(422);
    expect((await future.json<{ error: { code: string } }>()).error.code).toBe(
      "invalid_transaction",
    );
  });

  it("rejects oversized and unsupported event requests without changing report routes", async () => {
    await insertInstrument();
    const oversized = await exports.default.fetch(
      new Request("http://local/api/events", {
        method: "POST",
        headers: mutationHeaders('"position-basis-0"'),
        body: JSON.stringify({ ...createBody(), note: "x".repeat(70_000) }),
      }),
    );
    expect(oversized.status).toBe(413);
    expect(
      (await oversized.json<{ error: { code: string } }>()).error.code,
    ).toBe("body_too_large");

    const unsupported = await exports.default.fetch(
      new Request("http://local/api/events/transaction-1", {
        method: "PUT",
        headers: mutationHeaders('"position-basis-0", "event-1"'),
        body: JSON.stringify(createBody()),
      }),
    );
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("Allow")).toBe("PATCH, DELETE");

    const aliasUnsupported = await exports.default.fetch(
      new Request("http://local/api/events/transactions", {
        method: "PUT",
        headers: mutationHeaders('"position-basis-0"'),
        body: JSON.stringify(createBody()),
      }),
    );
    expect(aliasUnsupported.status).toBe(405);
    expect(aliasUnsupported.headers.get("Allow")).toBe("POST");

    const rootUnsupported = await exports.default.fetch(
      new Request("http://local/api/events", {
        method: "PUT",
        headers: mutationHeaders('"position-basis-0"'),
        body: JSON.stringify(createBody()),
      }),
    );
    expect(rootUnsupported.status).toBe(405);
    expect(rootUnsupported.headers.get("Allow")).toBe("GET, POST");

    const invalidJsonMime = await exports.default.fetch(
      new Request("http://local/api/events", {
        method: "POST",
        headers: {
          ...mutationHeaders('"position-basis-0"'),
          "Content-Type": "application/jsonp",
        },
        body: JSON.stringify(createBody()),
      }),
    );
    expect(invalidJsonMime.status).toBe(415);

    const report = await exports.default.fetch(
      "http://local/api/reports/latest",
    );
    expect(report.status).toBe(200);
  });
});

describe("ledger mutation token", () => {
  it("fails closed when the singleton position-basis row is absent", async () => {
    await env.DB.prepare("DELETE FROM position_basis_state WHERE id = 1").run();
    await expect(
      env.DB.prepare(
        `INSERT INTO ledger_mutations
         (id, expected_revision, resulting_revision, mutation_kind, created_at)
         VALUES ('mutation-missing-state', 0, 1, 'transaction_create', ?1)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM ledger_mutations WHERE id = 'mutation-missing-state'",
      ).first(),
    ).toEqual({ count: 0 });
    await env.DB.prepare(
      "INSERT INTO position_basis_state (id, revision) VALUES (1, 0)",
    ).run();
  });

  it("rolls back the token, revision, and prior writes when a later batch statement fails", async () => {
    await insertInstrument();
    await expect(
      env.DB.batch([
        env.DB.prepare(
          `INSERT INTO ledger_mutations
           (id, expected_revision, resulting_revision, mutation_kind, created_at)
           VALUES ('mutation-rollback', 0, 1, 'transaction_create', ?1)`,
        ).bind(now),
        env.DB.prepare(
          `INSERT INTO transactions
           (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
            revision, created_at, updated_at)
           VALUES ('tx-before-failure', 'instrument-1', '2026-01-02', 'buy',
                   '1', '10', 1, ?1, ?1)`,
        ).bind(now),
        env.DB.prepare(
          `INSERT INTO transactions
           (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
            revision, created_at, updated_at)
           VALUES ('tx-invalid', 'instrument-1', '2026-01-03', 'invalid',
                   '1', '10', 1, ?1, ?1)`,
        ).bind(now),
      ]),
    ).rejects.toThrow();

    expect(
      await env.DB.prepare(
        "SELECT revision, last_mutation_id FROM position_basis_state WHERE id = 1",
      ).first(),
    ).toEqual({ revision: 0, last_mutation_id: null });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM ledger_mutations WHERE id = 'mutation-rollback'",
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 0 });
  });

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
