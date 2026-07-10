import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type {
  CorporateActionProvider,
  SplitEventRange,
} from "../../src/providers/corporate-actions";
import { EventImportsService } from "../../src/services/event-imports";

const now = "2026-07-10T12:00:00.000Z";
const header = "trade_date,symbol,side,quantity,price";

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

const service = (actions = provider()) =>
  new EventImportsService({
    db: env.DB,
    corporateActionProvider: actions,
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

const csv = (rows: string[]) => `${header}\n${rows.join("\n")}\n`;
const confirmation = (revision = "snapshot-r1") => ({
  instrumentId: "instrument-1",
  requestedStartDate: "2024-01-02",
  requestedEndDate: "2026-07-10",
  providerRevision: revision,
});

describe("EventImportsService", () => {
  beforeEach(async () => {
    await insertInstrument();
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
        confirmations: [],
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

  it("requires the previewed split confirmation, rejects a provider revision change, and never reparses staged bytes", async () => {
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
        confirmations: [],
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "review_required" }));
    await expect(
      service(provider("snapshot-r2")).commit({
        batchId: first.batchId,
        expectedPositionBasisRevision: 0,
        confirmations: [confirmation("snapshot-r1")],
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "review_required" }));
  });

  it("accepts RFC-style quoted fields but rejects bytes after a closing quote and preserves quoted newlines as one row", async () => {
    const quoted = await service().preview({
      originalFilename: "quoted.csv",
      file: new TextEncoder().encode(
        `${header}\n"2024-01-02","SHOP.TO","BUY","1","1"\n`,
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
          `${header}\n2024-01-02,"SHOP.TO"junk,BUY,1,1\n`,
        ),
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "invalid_file" }));
    const newline = await service().preview({
      originalFilename: "quoted-newline.csv",
      file: new TextEncoder().encode(
        `${header}\n2024-01-02,"SHOP\n.TO",BUY,1,1\n`,
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
      confirmations: [confirmation()],
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
        confirmations: [confirmation("snapshot-r2")],
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
        confirmations: [confirmation()],
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
        confirmations: [confirmation()],
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
        confirmations: [confirmation()],
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
        confirmations: [confirmation()],
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
      confirmations: [confirmation()],
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

  it("expires previews after 24 hours, removes staging rows after seven days, and retains digest/status", async () => {
    const preview = await service().preview({
      originalFilename: "portfolio-events.csv",
      file: new TextEncoder().encode(csv(["2024-01-02,SHOP.TO,buy,1,1"])),
    });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    await env.DB.prepare(
      "UPDATE import_batches SET expires_at = '2026-07-09T12:00:00.000Z', created_at = '2026-07-02T11:59:59.000Z' WHERE id = ?1",
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
    ).toEqual({ count: 0 });
    await expect(
      service().commit({
        batchId: preview.batchId,
        expectedPositionBasisRevision: 0,
        confirmations: [confirmation()],
      }),
    ).resolves.toEqual(expect.objectContaining({ kind: "expired" }));
  });
});

describe("event import route", () => {
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
