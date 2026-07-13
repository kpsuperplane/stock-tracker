import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InstrumentRepository } from "../../src/db/instruments";
import { PositionBasisRepository } from "../../src/db/position-basis";
import type {
  CorporateActionProvider,
  SplitEventRange,
} from "../../src/providers/corporate-actions";
import type { MarketDataProvider } from "../../src/providers/market-data";
import { YahooMarketDataProvider } from "../../src/providers/yahoo";
import { YahooCorporateActionProvider } from "../../src/providers/yahoo-corporate-actions";
import { EventImportsService } from "../../src/services/event-imports";

const now = "2026-07-10T12:00:00.000Z";
const header = "trade_date,symbol,side,quantity,price,category,account";

const provider = (revision = "snapshot-r1"): CorporateActionProvider => ({
  getSplits: async (symbol, startDate, endDate): Promise<SplitEventRange> => ({
    symbol: symbol.toUpperCase(),
    range: {
      requestedStartDate: startDate,
      requestedEndDate: endDate,
      coverageStartDate: null,
      coverageEndDate: null,
      isComplete: false,
      basis: "unverified",
      provider: "yahoo-chart-v8",
      observedAt: now,
      providerRevision: revision,
    },
    events: [],
  }),
});

const providerWithEvents = (
  revision: string,
  events: SplitEventRange["events"],
): CorporateActionProvider => ({
  getSplits: async (symbol, startDate, endDate): Promise<SplitEventRange> => ({
    symbol: symbol.toUpperCase(),
    range: {
      requestedStartDate: startDate,
      requestedEndDate: endDate,
      coverageStartDate: null,
      coverageEndDate: null,
      isComplete: false,
      basis: "unverified",
      provider: "yahoo-chart-v8",
      observedAt: now,
      providerRevision: revision,
    },
    events,
  }),
});

const service = (
  actions = provider(),
  marketDataProvider?: MarketDataProvider,
) =>
  new EventImportsService({
    db: env.DB,
    corporateActionProvider: actions,
    ...(marketDataProvider ? { marketDataProvider } : {}),
    now: () => new Date(now),
  });

async function insertInstrument(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO instruments
     (id, symbol, company_name, exchange, currency, instrument_type,
      provider, provider_symbol, created_at, updated_at)
     VALUES ('instrument-1', 'SHOP.TO', 'Shopify', 'TSX', 'CAD', 'stock',
             'yahoo', 'SHOP.TO', ?1, ?1)`,
  )
    .bind(now)
    .run();
}

async function insertAccount(input: {
  categoryId: string;
  categoryName: string;
  accountId: string;
  accountName: string;
}): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO account_categories
       (id, name, sort_order, revision, created_at, updated_at)
       VALUES (?1, ?2, 10, 1, ?3, ?3)`,
    ).bind(input.categoryId, input.categoryName, now),
    env.DB.prepare(
      `INSERT INTO accounts
       (id, category_id, name, sort_order, revision, created_at, updated_at)
       VALUES (?1, ?2, ?3, 10, 1, ?4, ?4)`,
    ).bind(input.accountId, input.categoryId, input.accountName, now),
  ]);
}

const csv = (rows: string[]) =>
  `${header}\n${rows.map((row) => `${row},Uncategorized,Default Account`).join("\n")}\n`;
const multiAccountCsv = (rows: string[]) => `${header}\n${rows.join("\n")}\n`;
describe("EventImportsService", () => {
  beforeEach(async () => {
    await insertInstrument();
  });

  it("registers a missing symbol through the same resolver used by event creation", async () => {
    const marketDataProvider: MarketDataProvider = {
      getInstrument: vi.fn(async (symbol) => ({
        metadata: {
          symbol: symbol.toUpperCase(),
          companyName: "New Company",
          exchange: "NMS",
          currency: "USD",
          instrumentType: "EQUITY" as const,
        },
        bars: [
          {
            date: now.slice(0, 10),
            close: 10,
            adjustedClose: 10,
          },
        ],
        corporateActionDates: new Set<string>(),
      })),
    };
    const result = await service(provider(), marketDataProvider).preview({
      originalFilename: "new-symbol.csv",
      file: new TextEncoder().encode(csv(["2024-01-02,NEWCO,buy,1,10"])),
    });

    expect(result).toEqual(
      expect.objectContaining({
        kind: "preview",
        rows: [expect.objectContaining({ symbol: "NEWCO", status: "valid" })],
      }),
    );
    expect(marketDataProvider.getInstrument).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare(
        "SELECT symbol, active FROM tickers WHERE symbol = 'NEWCO'",
      ).first(),
    ).toEqual({ symbol: "NEWCO", active: 1 });
    expect(
      await env.DB.prepare(
        "SELECT symbol, provider_symbol FROM instruments WHERE symbol = 'NEWCO'",
      ).first(),
    ).toEqual({ symbol: "NEWCO", provider_symbol: "NEWCO" });
  });

  it("accepts the documented UTF-8 template, strips a BOM, normalizes rows, and stages a review", async () => {
    const result = await service().preview({
      originalFilename: "portfolio-events.csv",
      file: new TextEncoder().encode(
        `\uFEFF${csv(["2024-01-02,shop.to, BUY ,001.2500,100.5000"])}`,
      ),
    });

    expect(result.kind).toBe("preview");
    if (result.kind !== "preview") return;
    expect(result.rows).toEqual([
      expect.objectContaining({
        rowNumber: 2,
        symbol: "SHOP.TO",
        side: "buy",
        quantityDecimal: "1.25",
        priceDecimal: "100.5",
        status: "valid",
      }),
    ]);
    expect(result.reviews).toEqual([
      expect.objectContaining({
        instrumentId: "instrument-1",
        providerRevision: "snapshot-r1",
      }),
    ]);
    expect(
      await env.DB.prepare(
        "SELECT normalized_transaction_json FROM import_rows WHERE import_batch_id = ?1",
      )
        .bind(result.batchId)
        .first<{ normalized_transaction_json: string }>(),
    ).toEqual({
      normalized_transaction_json: expect.stringContaining(
        '"instrumentId":"instrument-1"',
      ),
    });
  });

  it("previews and commits one file across multiple active accounts", async () => {
    await insertAccount({
      categoryId: "category-registered",
      categoryName: "Registered",
      accountId: "account-tfsa",
      accountName: "TFSA",
    });
    const getSplits = vi.fn(provider().getSplits);
    const importService = service({ getSplits });
    const preview = await importService.preview({
      originalFilename: "multi-account.csv",
      file: new TextEncoder().encode(
        multiAccountCsv([
          "2024-01-02,SHOP.TO,buy,2,10, registered , tfsa ",
          "2024-01-03,SHOP.TO,buy,3,11,Uncategorized,Default Account",
        ]),
      ),
    });

    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    expect(preview.rows).toEqual([
      expect.objectContaining({
        accountId: "account-tfsa",
        categoryName: "Registered",
        accountName: "TFSA",
        status: "valid",
      }),
      expect.objectContaining({
        accountId: "account-default",
        categoryName: "Uncategorized",
        accountName: "Default Account",
        status: "valid",
      }),
    ]);
    expect(preview.projectedHoldings).toEqual([
      {
        accountId: "account-tfsa",
        categoryName: "Registered",
        accountName: "TFSA",
        symbol: "SHOP.TO",
        quantityDecimal: "2",
      },
      {
        accountId: "account-default",
        categoryName: "Uncategorized",
        accountName: "Default Account",
        symbol: "SHOP.TO",
        quantityDecimal: "3",
      },
    ]);
    expect(preview.reviews).toHaveLength(1);
    expect(getSplits).toHaveBeenCalledTimes(1);

    const committed = await importService.commit({
      batchId: preview.batchId,
      expectedPositionBasisRevision: preview.basePositionBasisRevision,
    });
    expect(committed.kind).toBe("committed");
    expect(
      await env.DB.prepare(
        "SELECT account_id, quantity_decimal FROM transactions ORDER BY account_id",
      ).all(),
    ).toEqual(
      expect.objectContaining({
        results: [
          { account_id: "account-default", quantity_decimal: "3" },
          { account_id: "account-tfsa", quantity_decimal: "2" },
        ],
      }),
    );
  });

  it("uses category names to disambiguate accounts and rejects invalid account references", async () => {
    await insertAccount({
      categoryId: "category-one",
      categoryName: "Category One",
      accountId: "account-one",
      accountName: "Shared",
    });
    await insertAccount({
      categoryId: "category-two",
      categoryName: "Category Two",
      accountId: "account-two",
      accountName: "Shared",
    });
    const preview = await service().preview({
      originalFilename: "account-validation.csv",
      file: new TextEncoder().encode(
        multiAccountCsv([
          "2024-01-02,SHOP.TO,buy,1,1,Category One,Shared",
          "2024-01-03,SHOP.TO,buy,1,1,Category Two,Shared",
          "2024-01-04,SHOP.TO,buy,1,1,,Shared",
          "2024-01-05,SHOP.TO,buy,1,1,Category One,",
          "2024-01-06,SHOP.TO,buy,1,1,Missing,Shared",
        ]),
      ),
    });

    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    expect(preview.rows.map((row) => row.accountId)).toEqual([
      "account-one",
      "account-two",
      null,
      null,
      null,
    ]);
    expect(preview.rows[2]?.errors).toContain("invalid_category");
    expect(preview.rows[3]?.errors).toContain("invalid_account");
    expect(preview.rows[4]?.errors).toContain("unknown_account");
  });

  it("marks negative holdings only on the affected account rows", async () => {
    await insertAccount({
      categoryId: "category-registered",
      categoryName: "Registered",
      accountId: "account-tfsa",
      accountName: "TFSA",
    });
    await env.DB.prepare(
      `INSERT INTO transactions
       (id, instrument_id, account_id, trade_date, side, quantity_decimal,
        price_decimal, revision, created_at, updated_at)
       VALUES ('existing-default', 'instrument-1', 'account-default',
               '2024-01-01', 'buy', '1', '1', 1, ?1, ?1)`,
    )
      .bind(now)
      .run();
    const preview = await service().preview({
      originalFilename: "account-negative.csv",
      file: new TextEncoder().encode(
        multiAccountCsv([
          "2024-01-02,SHOP.TO,sell,2,1,Uncategorized,Default Account",
          "2024-01-02,SHOP.TO,buy,2,1,Registered,TFSA",
        ]),
      ),
    });

    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    expect(preview.rows[0]).toEqual(
      expect.objectContaining({
        accountId: "account-default",
        status: "invalid",
        errors: expect.arrayContaining(["negative_holdings"]),
      }),
    );
    expect(preview.rows[1]).toEqual(
      expect.objectContaining({ accountId: "account-tfsa", status: "valid" }),
    );
  });

  it("rejects an inexact header and invalid date, side, decimal, and symbol rows without making them commit-ready", async () => {
    await expect(
      service().preview({
        originalFilename: "wrong.csv",
        file: new TextEncoder().encode(
          "symbol,date,side,quantity_decimal,price_decimal\n2024-01-02,SHOP.TO,buy,1,1\n",
        ),
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "invalid_file" }));

    const result = await service().preview({
      originalFilename: "invalid.csv",
      file: new TextEncoder().encode(
        csv([
          "2024-02-30,unknown,hold,-1,nope",
          "2026-07-11,SHOP.TO,sell,1.1234567,2",
        ]),
      ),
    });
    expect(result.kind).toBe("preview");
    if (result.kind !== "preview") return;
    expect(result.rows.every((row) => row.status === "invalid")).toBe(true);
    await expect(
      service().commit({
        batchId: result.batchId,
        expectedPositionBasisRevision: 0,
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "validation_error" }));
  });

  it("enforces file and row limits and retains a digest record when duplicate upload is rejected", async () => {
    const importService = service();
    const tooManyRows = Array.from(
      { length: 10_001 },
      () => "2024-01-02,SHOP.TO,buy,1,1",
    );
    await expect(
      importService.preview({
        originalFilename: "many.csv",
        file: new TextEncoder().encode(csv(tooManyRows)),
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "invalid_file" }));
    await expect(
      importService.preview({
        originalFilename: "large.csv",
        file: new Uint8Array(5 * 1024 * 1024 + 1),
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "invalid_file" }));

    const file = new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,buy,1,1"]));
    const first = await importService.preview({
      originalFilename: "portfolio-events.csv",
      file,
    });
    expect(first.kind).toBe("preview");
    const duplicate = await importService.preview({
      originalFilename: "renamed.csv",
      file,
    });
    expect(duplicate).toEqual(expect.objectContaining({ kind: "duplicate" }));
  });

  it("bulk-resolves repeated symbols rather than issuing one D1 lookup per CSV row", async () => {
    const lookup = vi.spyOn(InstrumentRepository.prototype, "findBySymbol");
    const result = await service().preview({
      originalFilename: "many-valid.csv",
      file: new TextEncoder().encode(
        csv(Array.from({ length: 500 }, () => "2024-01-02,SHOP.TO,buy,1,1")),
      ),
    });
    expect(result).toEqual(expect.objectContaining({ kind: "preview" }));
    expect(lookup).not.toHaveBeenCalled();
  });

  it("keeps a 10,000-row 40-symbol preview within D1 and provider budgets", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
           VALUES(1)
           UNION ALL SELECT value + 1 FROM sequence WHERE value < 40
         )
         INSERT INTO instruments
         (id, symbol, company_name, exchange, currency, instrument_type,
          provider, provider_symbol, created_at, updated_at)
         SELECT 'bulk-' || value, 'B' || printf('%03d', value),
                'Bulk Corp', 'NYSE', 'USD', 'stock', 'yahoo',
                'B' || printf('%03d', value), ?1, ?1
         FROM sequence`,
    )
      .bind(now)
      .run();
    const getSplits = vi.fn(provider().getSplits);
    const databaseCalls = vi.spyOn(env.DB, "prepare");
    const result = await service({ getSplits }).preview({
      originalFilename: "diverse.csv",
      file: new TextEncoder().encode(
        csv(
          Array.from(
            { length: 10_000 },
            (_, index) =>
              `2024-01-02,B${String((index % 40) + 1).padStart(3, "0")},buy,1,1`,
          ),
        ),
      ),
    });
    expect(result).toEqual(
      expect.objectContaining({
        kind: "preview",
        rows: expect.arrayContaining([
          expect.objectContaining({ status: "valid" }),
        ]),
      }),
    );
    if (result.kind === "preview") expect(result.rows).toHaveLength(10_000);
    expect(databaseCalls.mock.calls).toHaveLength(30);
    expect(getSplits).toHaveBeenCalledTimes(40);
  }, 20_000);

  it("refetches no more than 40 providers when committing a maximum-symbol preview", async () => {
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         VALUES(1)
         UNION ALL SELECT value + 1 FROM sequence WHERE value < 40
       )
       INSERT INTO instruments
       (id, symbol, company_name, exchange, currency, instrument_type,
        provider, provider_symbol, created_at, updated_at)
       SELECT 'commit-' || value, 'C' || printf('%03d', value),
              'Commit Corp', 'NYSE', 'USD', 'stock', 'yahoo',
              'C' || printf('%03d', value), ?1, ?1
       FROM sequence`,
    )
      .bind(now)
      .run();
    const rows = Array.from({ length: 40 }, (_, index) => {
      const symbol = `C${String(index + 1).padStart(3, "0")}`;
      return [`2024-01-02,${symbol},buy,1,1`, `2024-01-02,${symbol},sell,1,1`];
    }).flat();
    const getSplits = vi.fn(provider().getSplits);
    const importService = service({ getSplits });
    const preview = await importService.preview({
      originalFilename: "hundred.csv",
      file: new TextEncoder().encode(csv(rows)),
    });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    expect(getSplits).toHaveBeenCalledTimes(40);
    getSplits.mockClear();
    const databaseCalls = vi.spyOn(env.DB, "prepare");
    const result = await importService.commit({
      batchId: preview.batchId,
      expectedPositionBasisRevision: 0,
    });
    expect(result).toEqual(expect.objectContaining({ kind: "committed" }));
    expect(databaseCalls.mock.calls.length).toBeLessThanOrEqual(25);
    expect(getSplits).toHaveBeenCalledTimes(40);
  });

  it("rejects 41 distinct symbols before provider calls or staging", async () => {
    const getSplits = vi.fn(provider().getSplits);
    const result = await service({ getSplits }).preview({
      originalFilename: "over-symbol-cap.csv",
      file: new TextEncoder().encode(
        csv(
          Array.from(
            { length: 41 },
            (_, index) =>
              `2024-01-02,OVER${String(index + 1).padStart(2, "0")},buy,1,1`,
          ),
        ),
      ),
    });
    expect(result).toEqual({ kind: "invalid_file", code: "too_many_symbols" });
    expect(getSplits).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM import_batches",
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM import_rows").first(),
    ).toEqual({ count: 0 });
  });

  it("rejects an over-cap preview before retention cleanup mutates expired staging", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO import_batches
           (id, file_digest, original_filename, base_position_basis_revision,
            status, expires_at, created_at, updated_at)
           VALUES ('expired-preview', 'expired-digest', 'old.csv', 0,
                   'preview', '2026-07-09T12:00:00.000Z', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO import_rows
           (id, import_batch_id, row_number, symbol, category_name,
            account_name, status)
           VALUES ('expired-row', 'expired-preview', 2, 'SHOP.TO',
                   'Uncategorized', 'Default Account', 'invalid')`,
      ),
    ]);
    const result = await service().preview({
      originalFilename: "over-symbol-cap.csv",
      file: new TextEncoder().encode(
        csv(
          Array.from(
            { length: 41 },
            (_, index) => `2024-01-02,CAP${index + 1},buy,1,1`,
          ),
        ),
      ),
    });
    expect(result).toEqual({ kind: "invalid_file", code: "too_many_symbols" });
    expect(
      await env.DB.prepare(
        "SELECT status FROM import_batches WHERE id = 'expired-preview'",
      ).first(),
    ).toEqual({ status: "preview" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM import_rows WHERE import_batch_id = 'expired-preview'",
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("rejects a malformed 41-instrument staged batch before provider refetches", async () => {
    await env.DB.prepare(
      `INSERT INTO import_batches
       (id, file_digest, original_filename, base_position_basis_revision,
        status, expires_at, created_at, updated_at)
       VALUES ('malformed-batch', 'malformed-digest', 'legacy.csv', 0,
               'preview', '2026-07-11T12:00:00.000Z', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await env.DB.batch(
      Array.from({ length: 41 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO import_rows
             (id, import_batch_id, row_number, symbol, trade_date, side,
              quantity_decimal, price_decimal, account_id, category_name,
              account_name, status, normalized_transaction_json)
             VALUES (?1, 'malformed-batch', ?2, ?3, '2024-01-02', 'buy',
                     '1', '1', 'account-default', 'Uncategorized',
                     'Default Account', 'valid', ?4)`,
        ).bind(
          `malformed-row-${index + 1}`,
          index + 2,
          `LEGACY${index + 1}`,
          JSON.stringify({
            instrumentId: `legacy-instrument-${index + 1}`,
            symbol: `LEGACY${index + 1}`,
            tradeDate: "2024-01-02",
            side: "buy",
            quantityDecimal: "1",
            priceDecimal: "1",
            snapshot: {
              provider: "yahoo-chart-v8",
              requestedStartDate: "2024-01-02",
              requestedEndDate: "2026-07-10",
              providerRevision: "legacy-r1",
            },
          }),
        ),
      ),
    );
    const getSplits = vi.fn(provider().getSplits);
    const result = await service({ getSplits }).commit({
      batchId: "malformed-batch",
      expectedPositionBasisRevision: 0,
    });
    expect(result).toEqual({
      kind: "validation_error",
      code: "too_many_symbols",
    });
    expect(getSplits).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM pipeline_jobs",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("commits without confirmation and automatically accepts a newer provider revision", async () => {
    const first = await service(provider("snapshot-r1")).preview({
      originalFilename: "portfolio-events.csv",
      file: new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,buy,1,1"])),
    });
    expect(first.kind).toBe("preview");
    if (first.kind !== "preview") return;

    await expect(
      service(provider("snapshot-r1")).commit({
        batchId: first.batchId,
        expectedPositionBasisRevision: 0,
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "committed" }));

    const second = await service(provider("snapshot-r1")).preview({
      originalFilename: "portfolio-events-updated.csv",
      file: new TextEncoder().encode(csv(["2024-01-03,SHOP.TO,buy,1,2"])),
    });
    expect(second.kind).toBe("preview");
    if (second.kind !== "preview") return;
    await expect(
      service(provider("snapshot-r2")).commit({
        batchId: second.batchId,
        expectedPositionBasisRevision: 1,
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "committed" }));
    expect(
      await env.DB.prepare(
        "SELECT snapshot_provider_revision FROM corporate_action_coverage",
      ).first(),
    ).toEqual({ snapshot_provider_revision: "snapshot-r2" });
  });

  it("uses a corrected split snapshot during preview and quarantines an invalid historical correction", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO transactions
           (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
            revision, created_at, updated_at)
           VALUES ('prior-buy', 'instrument-1', '2025-01-01', 'buy', '1', '1', 1, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO transactions
           (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
            revision, created_at, updated_at)
           VALUES ('prior-sell', 'instrument-1', '2025-02-01', 'sell', '0.75', '1', 1, ?1, ?1)`,
      ).bind(now),
    ]);
    const reverseSplit = {
      type: "split" as const,
      symbol: "SHOP.TO",
      effectiveDate: "2025-01-15",
      numerator: "1",
      denominator: "2",
      provider: "yahoo-chart-v8",
      providerEventId: "corrected-reverse-split",
      providerRevision: "event-r2",
    };
    const result = await service(
      providerWithEvents("snapshot-r2", [reverseSplit]),
    ).preview({
      originalFilename: "correction.csv",
      file: new TextEncoder().encode(csv(["2025-02-02,SHOP.TO,buy,1,1"])),
    });
    expect(result).toEqual(
      expect.objectContaining({
        kind: "preview",
        basePositionBasisRevision: 1,
        rows: [expect.objectContaining({ status: "invalid" })],
      }),
    );
    expect(
      await env.DB.prepare(
        "SELECT revision FROM position_basis_state WHERE id = 1",
      ).first(),
    ).toEqual({ revision: 1 });
    expect(
      await env.DB.prepare(
        `SELECT expected_revision, resulting_revision, mutation_kind
         FROM ledger_mutations`,
      ).first(),
    ).toEqual({
      expected_revision: 0,
      resulting_revision: 1,
      mutation_kind: "action_quarantine",
    });
    expect(
      await env.DB.prepare(
        "SELECT status, conflict_code FROM corporate_actions WHERE provider_event_id = 'corrected-reverse-split'",
      ).first(),
    ).toEqual({ status: "quarantined", conflict_code: "negative_history" });
    expect(
      await env.DB.prepare(
        "SELECT status, error_code FROM corporate_action_coverage WHERE instrument_id = 'instrument-1'",
      ).first(),
    ).toEqual({ status: "conflict", error_code: "negative_history" });
  });

  it("rejects a stale preview correction without overwriting the newer authoritative state", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO transactions
           (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
            revision, created_at, updated_at)
           VALUES ('prior-buy', 'instrument-1', '2025-01-01', 'buy', '1', '1', 1, ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO transactions
           (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
            revision, created_at, updated_at)
           VALUES ('prior-sell', 'instrument-1', '2025-02-01', 'sell', '0.75', '1', 1, ?1, ?1)`,
      ).bind(now),
    ]);
    const originalBatch = env.DB.batch.bind(env.DB);
    let batchCalls = 0;
    const batch = vi
      .spyOn(env.DB, "batch")
      .mockImplementation(async (statements) => {
        batchCalls += 1;
        if (batchCalls === 2) {
          await originalBatch([
            new PositionBasisRepository(env.DB).mutationTokenStatement({
              id: "concurrent-winner",
              expectedRevision: 0,
              kind: "action_quarantine",
              createdAt: now,
            }),
          ]);
        }
        return originalBatch(statements);
      });
    try {
      const result = await service(
        providerWithEvents("snapshot-r2", [
          {
            type: "split",
            symbol: "SHOP.TO",
            effectiveDate: "2025-01-15",
            numerator: "1",
            denominator: "2",
            provider: "yahoo-chart-v8",
            providerEventId: "stale-reverse-split",
            providerRevision: "event-r2",
          },
        ]),
      ).preview({
        originalFilename: "stale-correction.csv",
        file: new TextEncoder().encode(csv(["2025-02-02,SHOP.TO,buy,1,1"])),
      });
      expect(result).toEqual({ kind: "conflict", code: "ledger_conflict" });
    } finally {
      batch.mockRestore();
    }
    expect(
      await env.DB.prepare(
        "SELECT revision, last_mutation_id FROM position_basis_state WHERE id = 1",
      ).first(),
    ).toEqual({ revision: 1, last_mutation_id: "concurrent-winner" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM import_batches",
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM corporate_actions WHERE provider_event_id = 'stale-reverse-split'",
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM corporate_action_coverage",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("accepts RFC-style quoted fields but rejects bytes after a closing quote and preserves quoted newlines as one row", async () => {
    const quoted = await service().preview({
      originalFilename: "quoted.csv",
      file: new TextEncoder().encode(
        `${header}\n"2024-01-02","SHOP.TO","BUY","1","1","Uncategorized","Default Account"\n`,
      ),
    });
    expect(quoted).toEqual(
      expect.objectContaining({
        kind: "preview",
        rows: [expect.objectContaining({ status: "valid" })],
      }),
    );
    await expect(
      service().preview({
        originalFilename: "malformed.csv",
        file: new TextEncoder().encode(
          `${header}\n2024-01-02,"SHOP.TO"junk,BUY,1,1,Uncategorized,Default Account\n`,
        ),
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "invalid_file" }));
    const newline = await service().preview({
      originalFilename: "quoted-newline.csv",
      file: new TextEncoder().encode(
        `${header}\n2024-01-02,"SHOP\n.TO",BUY,1,1,Uncategorized,Default Account\n`,
      ),
    });
    expect(newline).toEqual(
      expect.objectContaining({
        kind: "preview",
        rows: [expect.objectContaining({ rowNumber: 2, status: "invalid" })],
      }),
    );
  });

  it("commits all normalized rows, one pipeline job, and a basis revision atomically", async () => {
    const importService = service();
    const preview = await importService.preview({
      originalFilename: "portfolio-events.csv",
      file: new TextEncoder().encode(
        csv(["2024-01-02,SHOP.TO,buy,2,1", "2024-01-03,SHOP.TO,sell,1,1"]),
      ),
    });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;

    const committed = await importService.commit({
      batchId: preview.batchId,
      expectedPositionBasisRevision: 0,
    });
    expect(committed).toEqual(
      expect.objectContaining({
        kind: "committed",
        positionBasisRevision: 1,
      }),
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 2 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM pipeline_jobs",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare("SELECT status FROM import_batches WHERE id = ?1")
        .bind(preview.batchId)
        .first(),
    ).toEqual({ status: "committed" });
  });

  it("commits a migrated preview whose staged JSON predates row-level accounts", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO import_batches
         (id, file_digest, original_filename, base_position_basis_revision,
          status, expires_at, created_at, updated_at)
         VALUES ('legacy-preview', 'legacy-preview-digest', 'legacy.csv', 0,
                 'preview', '2026-07-11T12:00:00.000Z', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO import_rows
         (id, import_batch_id, row_number, symbol, trade_date, side,
          quantity_decimal, price_decimal, account_id, category_name,
          account_name, status, normalized_transaction_json)
         VALUES ('legacy-preview-row', 'legacy-preview', 2, 'SHOP.TO',
                 '2024-01-02', 'buy', '1', '10', 'account-default',
                 'Uncategorized', 'Default Account', 'valid', ?1)`,
      ).bind(
        JSON.stringify({
          instrumentId: "instrument-1",
          symbol: "SHOP.TO",
          tradeDate: "2024-01-02",
          side: "buy",
          quantityDecimal: "1",
          priceDecimal: "10",
          snapshot: {
            provider: "yahoo-chart-v8",
            requestedStartDate: "2024-01-02",
            requestedEndDate: "2026-07-10",
            providerRevision: "snapshot-r1",
          },
        }),
      ),
    ]);

    const result = await service().commit({
      batchId: "legacy-preview",
      expectedPositionBasisRevision: 0,
    });
    expect(result.kind).toBe("committed");
    expect(
      await env.DB.prepare(
        "SELECT account_id FROM transactions WHERE id = 'legacy-preview:2'",
      ).first(),
    ).toEqual({ account_id: "account-default" });
  });

  it("only promotes candidates that belong to the fresh confirmed snapshot", async () => {
    const event = {
      type: "split" as const,
      symbol: "SHOP.TO",
      effectiveDate: "2025-01-02",
      numerator: "2",
      denominator: "1",
      provider: "yahoo-chart-v8",
      providerEventId: "fresh-split",
      providerRevision: "event-r2",
    };
    const importService = service(providerWithEvents("snapshot-r2", [event]));
    const preview = await importService.preview({
      originalFilename: "portfolio-events.csv",
      file: new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,buy,1,1"])),
    });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    await env.DB.prepare(
      `INSERT INTO corporate_actions
       (id, instrument_id, action_type, effective_date, split_numerator, split_denominator,
        provider, provider_event_id, provider_revision, retrieved_at, revision, status,
        created_at, updated_at)
       VALUES ('stale-candidate', 'instrument-1', 'split', '2025-01-02', '3', '1',
               'yahoo-chart-v8', 'stale-split', 'event-r1', ?1, 1, 'candidate', ?1, ?1)`,
    )
      .bind(now)
      .run();
    await expect(
      importService.commit({
        batchId: preview.batchId,
        expectedPositionBasisRevision: 0,
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "committed" }));
    expect(
      await env.DB.prepare(
        "SELECT status FROM corporate_actions WHERE id = 'stale-candidate'",
      ).first(),
    ).toEqual({ status: "candidate" });
    expect(
      await env.DB.prepare(
        "SELECT status FROM corporate_actions WHERE provider_event_id = 'fresh-split'",
      ).first(),
    ).toEqual({ status: "active" });
  });

  it.each([
    "active",
    "superseded",
    "quarantined",
  ] as const)("reactivates an exact fresh snapshot action previously marked %s", async (status) => {
    const event = {
      type: "split" as const,
      symbol: "SHOP.TO",
      effectiveDate: "2025-01-02",
      numerator: "2",
      denominator: "1",
      provider: "yahoo-chart-v8",
      providerEventId: "reusable-split",
      providerRevision: "event-r2",
    };
    const importService = service(providerWithEvents("snapshot-r2", [event]));
    const preview = await importService.preview({
      originalFilename: "portfolio-events.csv",
      file: new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,buy,1,1"])),
    });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    await env.DB.prepare(
      `INSERT INTO corporate_actions
         (id, instrument_id, action_type, effective_date, split_numerator, split_denominator,
          provider, provider_event_id, provider_revision, retrieved_at, revision, status,
          conflict_code, conflict_message, created_at, updated_at)
         VALUES ('reusable-action', 'instrument-1', 'split', '2025-01-02', '2', '1',
                 'yahoo-chart-v8', 'reusable-split', 'event-r2', ?1, 1, ?2,
                 ?3, ?3, ?1, ?1)`,
    )
      .bind(now, status, status === "quarantined" ? "prior_conflict" : null)
      .run();
    await expect(
      importService.commit({
        batchId: preview.batchId,
        expectedPositionBasisRevision: 0,
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "committed" }));
    expect(
      await env.DB.prepare(
        "SELECT status, conflict_code FROM corporate_actions WHERE id = 'reusable-action'",
      ).first(),
    ).toEqual({ status: "active", conflict_code: null });
  });

  it("does not allow an import to create a 101st current position", async () => {
    const statements: D1PreparedStatement[] = [];
    for (let index = 2; index <= 101; index += 1) {
      const id = `instrument-${index}`;
      const symbol = `CAP${index}`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO instruments
             (id, symbol, company_name, exchange, currency, instrument_type,
              provider, provider_symbol, created_at, updated_at)
             VALUES (?1, ?2, ?2, 'NYSE', 'USD', 'stock', 'yahoo', ?2, ?3, ?3)`,
        ).bind(id, symbol, now),
        env.DB.prepare(
          `INSERT INTO transactions
             (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
              revision, created_at, updated_at)
             VALUES (?1, ?2, '2024-01-01', 'buy', '1', '1', 1, ?3, ?3)`,
        ).bind(`transaction-${index}`, id, now),
      );
    }
    await env.DB.batch(statements);
    const preview = await service().preview({
      originalFilename: "portfolio-events.csv",
      file: new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,buy,1,1"])),
    });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    await expect(
      service().commit({
        batchId: preview.batchId,
        expectedPositionBasisRevision: 0,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: "validation_error",
        code: "position_limit",
      }),
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 100 });
  });

  it("does not partially commit a projected negative holding or stale basis", async () => {
    const preview = await service().preview({
      originalFilename: "portfolio-events.csv",
      file: new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,sell,1,1"])),
    });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    expect(preview.rows[0]?.status).toBe("invalid");
    await expect(
      service().commit({
        batchId: preview.batchId,
        expectedPositionBasisRevision: 0,
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "validation_error" }));
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 0 });

    const valid = await service().preview({
      originalFilename: "second.csv",
      file: new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,buy,1,1"])),
    });
    expect(valid.kind).toBe("preview");
    if (valid.kind !== "preview") return;
    await expect(
      service().commit({
        batchId: valid.batchId,
        expectedPositionBasisRevision: 99,
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "conflict" }));
  });

  it("rolls back the mutation token, job, coverage, and batch status when INSERT … SELECT fails", async () => {
    const importService = service();
    const preview = await importService.preview({
      originalFilename: "portfolio-events.csv",
      file: new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,buy,1,1"])),
    });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    await env.DB.prepare(
      `INSERT INTO transactions
       (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
        revision, created_at, updated_at)
       VALUES (?1, 'instrument-1', '2020-01-01', 'buy', '1', '1', 1, ?2, ?2)`,
    )
      .bind(`${preview.batchId}:2`, now)
      .run();

    await expect(
      importService.commit({
        batchId: preview.batchId,
        expectedPositionBasisRevision: 0,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: "validation_error",
        code: "import_commit_failed",
      }),
    );
    expect(
      await env.DB.prepare(
        "SELECT revision FROM position_basis_state WHERE id = 1",
      ).first(),
    ).toEqual({ revision: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM pipeline_jobs",
      ).first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare("SELECT status FROM import_batches WHERE id = ?1")
        .bind(preview.batchId)
        .first(),
    ).toEqual({ status: "preview" });
  });

  it("allows only one simultaneous preview for the same digest to create staging", async () => {
    const file = new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,buy,1,1"]));
    const [left, right] = await Promise.all([
      service().preview({ originalFilename: "left.csv", file }),
      service().preview({ originalFilename: "right.csv", file }),
    ]);
    expect([left.kind, right.kind].sort()).toEqual(["duplicate", "preview"]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM import_batches",
      ).first(),
    ).toEqual({ count: 1 });
  });

  it("allows exactly one of two simultaneous commits to advance the ledger", async () => {
    const importService = service();
    const preview = await importService.preview({
      originalFilename: "portfolio-events.csv",
      file: new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,buy,1,1"])),
    });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    const input = {
      batchId: preview.batchId,
      expectedPositionBasisRevision: 0,
    };
    const results = await Promise.all([
      importService.commit(input),
      importService.commit(input),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      "committed",
      "conflict",
    ]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM pipeline_jobs",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT revision FROM position_basis_state WHERE id = 1",
      ).first(),
    ).toEqual({ revision: 1 });
  });

  it("aborts atomically when a preview expires after the initial read but before the guarded write", async () => {
    let current = new Date(now);
    const previewService = new EventImportsService({
      db: env.DB,
      corporateActionProvider: provider(),
      now: () => current,
    });
    const preview = await previewService.preview({
      originalFilename: "portfolio-events.csv",
      file: new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,buy,1,1"])),
    });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    const expiryProvider: CorporateActionProvider = {
      getSplits: async (...args) => {
        current = new Date("2026-07-11T12:00:00.000Z");
        return provider().getSplits(...args);
      },
    };
    const result = await new EventImportsService({
      db: env.DB,
      corporateActionProvider: expiryProvider,
      now: () => current,
    }).commit({
      batchId: preview.batchId,
      expectedPositionBasisRevision: 0,
    });
    expect(result).toEqual({ kind: "expired" });
    expect(
      await env.DB.prepare(
        "SELECT revision FROM position_basis_state WHERE id = 1",
      ).first(),
    ).toEqual({ revision: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("expires previews after 24 hours and retains staging through the seven-day cleanup boundary", async () => {
    const preview = await service().preview({
      originalFilename: "portfolio-events.csv",
      file: new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,buy,1,1"])),
    });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    await env.DB.prepare(
      "UPDATE import_batches SET expires_at = '2026-07-09T12:00:00.000Z' WHERE id = ?1",
    )
      .bind(preview.batchId)
      .run();
    await service().cleanup();
    expect(
      await env.DB.prepare("SELECT status FROM import_batches WHERE id = ?1")
        .bind(preview.batchId)
        .first(),
    ).toEqual({ status: "expired" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM import_rows WHERE import_batch_id = ?1",
      )
        .bind(preview.batchId)
        .first(),
    ).toEqual({ count: 1 });
    await expect(
      service().commit({
        batchId: preview.batchId,
        expectedPositionBasisRevision: 0,
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "expired" }));
    await env.DB.prepare(
      "UPDATE import_batches SET expires_at = '2026-07-02T11:59:59.000Z' WHERE id = ?1",
    )
      .bind(preview.batchId)
      .run();
    await service().cleanup();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM import_rows WHERE import_batch_id = ?1",
      )
        .bind(preview.batchId)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("purges expired staging seven days after expiry and committed staging seven days after commitment", async () => {
    const expired = await service().preview({
      originalFilename: "expired.csv",
      file: new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,buy,1,1"])),
    });
    const committed = await service().preview({
      originalFilename: "committed.csv",
      file: new TextEncoder().encode(csv(["2024-01-03,SHOP.TO,buy,1,1"])),
    });
    expect(expired.kind).toBe("preview");
    expect(committed.kind).toBe("preview");
    if (expired.kind !== "preview" || committed.kind !== "preview") return;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE import_batches SET expires_at = '2026-07-10T11:59:59.000Z' WHERE id = ?1",
      ).bind(expired.batchId),
      env.DB.prepare(
        `UPDATE import_batches
           SET status = 'committed', committed_at = '2026-07-03T11:59:59.000Z'
           WHERE id = ?1`,
      ).bind(committed.batchId),
    ]);
    await service().cleanup();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM import_rows WHERE import_batch_id = ?1",
      )
        .bind(expired.batchId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM import_rows WHERE import_batch_id = ?1",
      )
        .bind(committed.batchId)
        .first(),
    ).toEqual({ count: 0 });
  });
});

describe("event import route", () => {
  it("auto-registers a new symbol during a routed preview", async () => {
    vi.spyOn(
      YahooMarketDataProvider.prototype,
      "getInstrument",
    ).mockResolvedValue({
      metadata: {
        symbol: "NEWCO",
        companyName: "New Company",
        exchange: "NMS",
        currency: "USD",
        instrumentType: "EQUITY",
      },
      bars: [
        {
          date: now.slice(0, 10),
          close: 10,
          adjustedClose: 10,
        },
      ],
      corporateActionDates: new Set<string>(),
    });
    vi.spyOn(
      YahooCorporateActionProvider.prototype,
      "getSplits",
    ).mockImplementation((symbol, startDate, endDate) =>
      provider().getSplits(symbol, startDate, endDate),
    );

    const form = new FormData();
    form.set(
      "file",
      new File([csv(["2024-01-02,NEWCO,buy,1,10"])], "new-symbol.csv", {
        type: "text/csv",
      }),
    );
    const response = await exports.default.fetch(
      new Request("http://local/api/event-imports/preview", {
        method: "POST",
        body: form,
        headers: {
          Origin: "http://local",
          Host: "local",
          "X-Stock-Tracker-Request": "1",
        },
      }),
    );

    expect(response.status).toBe(201);
    expect(
      (
        await response.json<{
          rows: Array<{ symbol: string; status: string }>;
        }>()
      ).rows,
    ).toEqual([expect.objectContaining({ symbol: "NEWCO", status: "valid" })]);
    expect(
      await env.DB.prepare(
        "SELECT symbol FROM tickers WHERE symbol = 'NEWCO'",
      ).first(),
    ).toEqual({ symbol: "NEWCO" });
  });

  it("accepts a 5 MiB file part plus bounded multipart framing rather than rejecting the envelope", async () => {
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array(5 * 1024 * 1024)], "boundary.csv", {
        type: "text/csv",
      }),
    );
    const response = await exports.default.fetch(
      new Request("http://local/api/event-imports/preview", {
        method: "POST",
        body: form,
        headers: {
          Authorization: "Basic b3duZXI6cGFzc3dvcmQ=",
          Origin: "http://local",
          Host: "local",
          "X-Stock-Tracker-Request": "1",
        },
      }),
    );
    expect(response.status).not.toBe(413);
    expect(response.status).toBe(422);
  });

  it("requires same-origin application requests before multipart parsing", async () => {
    const form = new FormData();
    form.set(
      "file",
      new File([csv(["2024-01-02,SHOP.TO,buy,1,1"])], "portfolio-events.csv", {
        type: "text/csv",
      }),
    );
    const response = await exports.default.fetch(
      new Request("http://local/api/event-imports/preview", {
        method: "POST",
        body: form,
        headers: { Authorization: "Basic b3duZXI6cGFzc3dvcmQ=" },
      }),
    );
    expect(response.status).toBe(403);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("csrf_rejected");
  });
});
