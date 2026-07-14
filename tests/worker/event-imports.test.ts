import { env, exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type {
  CorporateActionProvider,
  SplitEventRange,
} from "../../src/providers/corporate-actions";
import type { MarketDataProvider } from "../../src/providers/market-data";
import { YahooCorporateActionProvider } from "../../src/providers/yahoo-corporate-actions";
import { EventImportIntakeService } from "../../src/services/event-import-intake";
import { EventImportJobProcessor } from "../../src/services/event-import-job";
import { EventImportRecoveryService } from "../../src/services/event-import-recovery";
import type { ImportDispatchMessage } from "../../src/shared/contracts";
import { handleQueue } from "../../src/worker/queue";

const now = "2026-07-10T12:00:00.000Z";
const header = "trade_date,symbol,side,quantity,price,category,account";
const queue = () => ({
  send: vi.fn(async () => ({})),
  sendBatch: vi.fn(async () => ({})),
});

const csv = (rows: string[]): Uint8Array =>
  new TextEncoder().encode(`${header}\n${rows.join("\n")}\n`);

const splits = (withEvent = false): CorporateActionProvider => ({
  getSplits: vi.fn(
    async (symbol, startDate, endDate): Promise<SplitEventRange> => ({
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
        providerRevision: `snapshot:${symbol}:${startDate}:${endDate}`,
      },
      events: withEvent
        ? [
            {
              type: "split",
              symbol: symbol.toUpperCase(),
              effectiveDate: "2026-07-05",
              numerator: "2",
              denominator: "1",
              provider: "yahoo-chart-v8",
              providerEventId: `${symbol}:2026-07-05`,
              providerRevision: "2:1",
            },
          ]
        : [],
    }),
  ),
});

const market = (): MarketDataProvider => ({
  getInstrument: vi.fn(async (symbol) => ({
    metadata: {
      symbol: symbol.toUpperCase(),
      companyName: `${symbol.toUpperCase()} Inc.`,
      exchange: "NMS",
      currency: "USD",
      instrumentType: "EQUITY" as const,
    },
    bars: [{ date: "2026-07-10", close: 10, adjustedClose: 10 }],
    corporateActionDates: new Set<string>(),
  })),
});

const insertInstruments = async (symbols: string[]): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO instruments
     (id, symbol, company_name, exchange, currency, instrument_type,
      security_type, provider, provider_symbol, created_at, updated_at)
     SELECT value, value, value || ' Inc.', 'NMS', 'USD', 'stock', 'stock',
            'yahoo', value, ?2, ?2 FROM json_each(?1)`,
  )
    .bind(JSON.stringify(symbols), now)
    .run();
};

const acceptedImport = async (
  contents: Uint8Array,
  importQueue = queue(),
  filename = "portfolio.csv",
) => {
  const result = await new EventImportIntakeService({
    db: env.DB,
    queue: importQueue,
    now: () => new Date(now),
  }).start({ originalFilename: filename, file: contents });
  if (result.kind !== "accepted") throw new Error(result.code);
  return { result, importQueue };
};

const process = async (
  importId: string,
  importQueue = queue(),
  actionProvider = splits(),
  marketProvider = market(),
  current = now,
) => {
  await new EventImportJobProcessor({
    db: env.DB,
    queue: importQueue,
    corporateActionProvider: actionProvider,
    marketDataProvider: marketProvider,
    now: () => new Date(current),
  }).process(importId);
};

describe("asynchronous portfolio imports", () => {
  it("stages 10,000 rows and 10,000 distinct symbols without provider calls", async () => {
    const rows = Array.from(
      { length: 10_000 },
      (_, index) =>
        `2026-07-01,S${String(index).padStart(5, "0")},buy,1,1,Uncategorized,Default Account`,
    );
    const importQueue = queue();
    const { result } = await acceptedImport(csv(rows), importQueue);

    expect(importQueue.send).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        `SELECT status, total_rows AS totalRows, total_symbols AS totalSymbols
           FROM import_batches WHERE id = ?1`,
      )
        .bind(result.importId)
        .first(),
    ).toEqual({ status: "pending", totalRows: 10_000, totalSymbols: 10_000 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM import_symbols WHERE import_batch_id = ?1",
      )
        .bind(result.importId)
        .first(),
    ).toEqual({ count: 10_000 });
  });

  it.each([
    [
      "bad.txt",
      csv(["2026-07-01,AAPL,buy,1,1,Uncategorized,Default Account"]),
      "invalid_filename",
    ],
    ["bad.csv", new Uint8Array([0xff]), "invalid_utf8"],
    [
      "bad.csv",
      new TextEncoder().encode("wrong,header\n1,2\n"),
      "invalid_header",
    ],
    ["bad.csv", new TextEncoder().encode(`${header}\n1,2\n`), "column_count"],
  ])("rejects unreadable file input (%s, %s)", async (filename, file, code) => {
    const importQueue = queue();
    const result = await new EventImportIntakeService({
      db: env.DB,
      queue: importQueue,
    }).start({ originalFilename: filename, file });
    expect(result).toEqual({ kind: "invalid_file", code });
    expect(importQueue.send).not.toHaveBeenCalled();
  });

  it("defers dates, decimals, accounts, and symbols to the queued job", async () => {
    const { result } = await acceptedImport(
      csv(["not-a-date,!,hold,nope,-1,Missing,Account"]),
    );
    expect(
      await env.DB.prepare(
        "SELECT status FROM import_rows WHERE import_batch_id = ?1",
      )
        .bind(result.importId)
        .first(),
    ).toEqual({ status: "pending" });

    await process(result.importId);
    expect(
      await env.DB.prepare(
        `SELECT status, failed_rows AS failedRows
           FROM import_batches WHERE id = ?1`,
      )
        .bind(result.importId)
        .first(),
    ).toEqual({ status: "complete_with_errors", failedRows: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("commits every row atomically and starts reconciliation", async () => {
    await insertInstruments(["AAPL", "MSFT"]);
    const actionProvider = splits(true);
    const importQueue = queue();
    const { result } = await acceptedImport(
      csv([
        "2026-07-01,AAPL,buy,2,100,Uncategorized,Default Account",
        "2026-07-02,MSFT,buy,3,200,Uncategorized,Default Account",
      ]),
      importQueue,
    );
    await process(result.importId, importQueue, actionProvider);

    expect(actionProvider.getSplits).toHaveBeenCalledTimes(2);
    expect(
      await env.DB.prepare(
        `SELECT status, processed_symbols AS processedSymbols,
                result_pipeline_job_id AS jobId
           FROM import_batches WHERE id = ?1`,
      )
        .bind(result.importId)
        .first(),
    ).toEqual({
      status: "committed",
      processedSymbols: 2,
      jobId: expect.any(String),
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 2 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM tickers WHERE active = 1 AND deleted_at IS NULL",
      ).first(),
    ).toEqual({ count: 2 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM pipeline_jobs WHERE trigger_type = 'ledger_reconciliation'",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM corporate_actions WHERE status = 'active'",
      ).first(),
    ).toEqual({ count: 2 });
  });

  it("materializes unknown instruments only during a successful final commit", async () => {
    const marketProvider = market();
    const { result } = await acceptedImport(
      csv(["2026-07-01,NEWCO,buy,1,10,Uncategorized,Default Account"]),
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM instruments WHERE symbol = 'NEWCO'",
      ).first(),
    ).toEqual({ count: 0 });

    await process(result.importId, queue(), splits(), marketProvider);
    expect(marketProvider.getInstrument).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        "SELECT symbol FROM instruments WHERE symbol = 'NEWCO'",
      ).first(),
    ).toEqual({ symbol: "NEWCO" });
  });

  it("keeps a closed historical symbol off the active watchlist", async () => {
    await insertInstruments(["CLOSED"]);
    const { result } = await acceptedImport(
      csv([
        "2026-07-01,CLOSED,buy,1,10,Uncategorized,Default Account",
        "2026-07-02,CLOSED,sell,1,11,Uncategorized,Default Account",
      ]),
    );
    await process(result.importId);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM tickers WHERE symbol = 'CLOSED'",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("commits 101 current positions and activates all 101 symbols", async () => {
    const symbols = Array.from(
      { length: 101 },
      (_, index) => `CAP${String(index).padStart(3, "0")}`,
    );
    await insertInstruments(symbols);
    const { result } = await acceptedImport(
      csv(
        symbols.map(
          (symbol) =>
            `2026-07-01,${symbol},buy,1,1,Uncategorized,Default Account`,
        ),
      ),
    );
    const actionProvider = splits();
    for (let index = 0; index < 21; index += 1) {
      await process(result.importId, queue(), actionProvider);
    }
    expect(
      await env.DB.prepare("SELECT status FROM import_batches WHERE id = ?1")
        .bind(result.importId)
        .first(),
    ).toEqual({ status: "committed" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM tickers WHERE active = 1 AND deleted_at IS NULL",
      ).first(),
    ).toEqual({ count: 101 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 101 });
  }, 20_000);

  it("allows only one consumer to hold an import lease", async () => {
    await insertInstruments(["LEASED"]);
    const { result } = await acceptedImport(
      csv(["2026-07-01,LEASED,buy,1,1,Uncategorized,Default Account"]),
    );
    await env.DB.prepare(
      `UPDATE import_batches SET status = 'running',
              processing_lease_until = '2026-07-10T12:01:00.000Z'
        WHERE id = ?1`,
    )
      .bind(result.importId)
      .run();
    const actionProvider = splits();
    await process(result.importId, queue(), actionProvider);
    expect(actionProvider.getSplits).not.toHaveBeenCalled();
  });

  it("makes duplicate queue deliveries idempotent", async () => {
    await insertInstruments(["DUPLICATE"]);
    const { result } = await acceptedImport(
      csv(["2026-07-01,DUPLICATE,buy,1,1,Uncategorized,Default Account"]),
    );
    const getSplits = vi
      .spyOn(YahooCorporateActionProvider.prototype, "getSplits")
      .mockImplementation((symbol, startDate, endDate) =>
        splits().getSplits(symbol, startDate, endDate),
      );
    const messages = [0, 1].map(
      () =>
        ({
          body: { importBatchId: result.importId },
          ack: vi.fn(),
          retry: vi.fn(),
        }) as unknown as Message<ImportDispatchMessage>,
    );
    await handleQueue(
      { messages } as unknown as MessageBatch<ImportDispatchMessage>,
      env,
    );
    expect(
      messages.every(
        (message) => vi.mocked(message.ack).mock.calls.length === 1,
      ),
    ).toBe(true);
    expect(getSplits).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare("SELECT status FROM import_batches WHERE id = ?1")
        .bind(result.importId)
        .first(),
    ).toEqual({ status: "committed" });
  });

  it("persists transient provider retries and resumes after backoff", async () => {
    await insertInstruments(["RETRY"]);
    const actionProvider = splits();
    vi.mocked(actionProvider.getSplits)
      .mockRejectedValueOnce(new Error("provider_http_429"))
      .mockImplementationOnce(async (symbol, startDate, endDate) =>
        splits().getSplits(symbol, startDate, endDate),
      );
    const importQueue = queue();
    const { result } = await acceptedImport(
      csv(["2026-07-01,RETRY,buy,1,1,Uncategorized,Default Account"]),
      importQueue,
    );
    await process(result.importId, importQueue, actionProvider);
    expect(
      await env.DB.prepare(
        "SELECT state, attempt_count AS attempts FROM import_symbols WHERE import_batch_id = ?1",
      )
        .bind(result.importId)
        .first(),
    ).toEqual({ state: "retry", attempts: 1 });

    await process(
      result.importId,
      importQueue,
      actionProvider,
      market(),
      "2026-07-10T12:01:00.000Z",
    );
    expect(
      await env.DB.prepare("SELECT status FROM import_batches WHERE id = ?1")
        .bind(result.importId)
        .first(),
    ).toEqual({ status: "committed" });
  });

  it("reports an invalid split snapshot without changing the ledger", async () => {
    await insertInstruments(["BADSPLIT"]);
    const actionProvider = splits();
    vi.mocked(actionProvider.getSplits).mockImplementation(
      async (symbol, startDate, endDate) => ({
        ...(await splits().getSplits(symbol, startDate, endDate)),
        symbol: "WRONG",
      }),
    );
    const { result } = await acceptedImport(
      csv(["2026-07-01,BADSPLIT,buy,1,1,Uncategorized,Default Account"]),
    );
    await process(result.importId, queue(), actionProvider);
    expect(
      await env.DB.prepare(
        `SELECT status, failed_rows AS failedRows
           FROM import_batches WHERE id = ?1`,
      )
        .bind(result.importId)
        .first(),
    ).toEqual({ status: "complete_with_errors", failedRows: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("rejects a stale portfolio revision without partial ledger writes", async () => {
    await insertInstruments(["STALE"]);
    const { result } = await acceptedImport(
      csv(["2026-07-01,STALE,buy,1,1,Uncategorized,Default Account"]),
    );
    await env.DB.prepare(
      `INSERT INTO ledger_mutations
       (id, expected_revision, resulting_revision, mutation_kind, created_at)
       VALUES ('concurrent-change', 0, 1, 'transaction_create', ?1)`,
    )
      .bind(now)
      .run();

    await process(result.importId);
    expect(
      await env.DB.prepare(
        `SELECT status, terminal_error_code AS code
           FROM import_batches WHERE id = ?1`,
      )
        .bind(result.importId)
        .first(),
    ).toEqual({ status: "terminal", code: "ledger_conflict" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("recovers unsent imports and expired processing leases", async () => {
    await insertInstruments(["RECOVER"]);
    const { result } = await acceptedImport(
      csv(["2026-07-01,RECOVER,buy,1,1,Uncategorized,Default Account"]),
    );
    await env.DB.prepare(
      `UPDATE import_batches SET status = 'running',
              processing_lease_until = '2026-07-10T11:59:00.000Z',
              processing_lease_token = 'stale-lease'
        WHERE id = ?1`,
    )
      .bind(result.importId)
      .run();
    await env.DB.prepare(
      `UPDATE import_symbols SET state = 'processing',
              processing_token = 'stale-lease'
        WHERE import_batch_id = ?1`,
    )
      .bind(result.importId)
      .run();
    const importQueue = queue();
    const recovered = await new EventImportRecoveryService({
      db: env.DB,
      queue: importQueue,
      now: () => new Date(now),
    }).recover();
    expect(recovered.enqueued).toBe(1);
    expect(importQueue.sendBatch).toHaveBeenCalledWith([
      { body: { importBatchId: result.importId } },
    ]);
    await process(result.importId, importQueue);
    expect(
      await env.DB.prepare(
        `SELECT batches.status, symbols.state
           FROM import_batches batches JOIN import_symbols symbols
             ON symbols.import_batch_id = batches.id
          WHERE batches.id = ?1`,
      )
        .bind(result.importId)
        .first(),
    ).toEqual({ status: "committed", state: "complete" });
  });

  it("recovers an import when the initial queue send fails", async () => {
    const failedQueue = queue();
    failedQueue.send.mockRejectedValueOnce(new Error("queue_unavailable"));
    const { result } = await acceptedImport(
      csv(["2026-07-01,UNSENT,buy,1,1,Uncategorized,Default Account"]),
      failedQueue,
    );
    const recoveryQueue = queue();
    await new EventImportRecoveryService({
      db: env.DB,
      queue: recoveryQueue,
      now: () => new Date(now),
    }).recover();
    expect(recoveryQueue.sendBatch).toHaveBeenCalledWith([
      { body: { importBatchId: result.importId } },
    ]);
  });

  it("makes exhausted provider retries terminal without ledger writes", async () => {
    await insertInstruments(["EXHAUST"]);
    const actionProvider = splits();
    vi.mocked(actionProvider.getSplits).mockRejectedValue(
      new Error("provider_http_503"),
    );
    const { result } = await acceptedImport(
      csv(["2026-07-01,EXHAUST,buy,1,1,Uncategorized,Default Account"]),
    );
    for (const current of [
      now,
      "2026-07-10T12:01:00.000Z",
      "2026-07-10T12:03:00.000Z",
      "2026-07-10T12:10:00.000Z",
      "2026-07-10T12:30:00.000Z",
    ]) {
      await process(
        result.importId,
        queue(),
        actionProvider,
        market(),
        current,
      );
    }
    expect(
      await env.DB.prepare(
        `SELECT status, terminal_error_code AS code
           FROM import_batches WHERE id = ?1`,
      )
        .bind(result.importId)
        .first(),
    ).toEqual({ status: "terminal", code: "provider_retry_exhausted" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("reports negative holdings and leaves the ledger unchanged", async () => {
    await insertInstruments(["NEGATIVE"]);
    const { result } = await acceptedImport(
      csv(["2026-07-01,NEGATIVE,sell,1,1,Uncategorized,Default Account"]),
    );
    await process(result.importId);
    expect(
      await env.DB.prepare(
        "SELECT status, failed_rows AS failedRows FROM import_batches WHERE id = ?1",
      )
        .bind(result.importId)
        .first(),
    ).toEqual({ status: "complete_with_errors", failedRows: 1 });
    expect(
      await env.DB.prepare(
        "SELECT validation_errors_json AS errors FROM import_rows WHERE import_batch_id = ?1",
      )
        .bind(result.importId)
        .first(),
    ).toEqual({ errors: '["negative_holdings"]' });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("folds provider-canonicalized aliases together before activation", async () => {
    const marketProvider = market();
    vi.mocked(marketProvider.getInstrument).mockImplementation(async () => ({
      metadata: {
        symbol: "CANON",
        companyName: "Canonical Inc.",
        exchange: "NMS",
        currency: "USD",
        instrumentType: "EQUITY",
      },
      bars: [{ date: "2026-07-10", close: 10, adjustedClose: 10 }],
      corporateActionDates: new Set<string>(),
    }));
    const { result } = await acceptedImport(
      csv([
        "2026-07-01,ALIAS.A,buy,1,1,Uncategorized,Default Account",
        "2026-07-02,ALIAS-A,sell,1,1,Uncategorized,Default Account",
      ]),
    );
    await process(result.importId, queue(), splits(), marketProvider);
    expect(
      await env.DB.prepare("SELECT status FROM import_batches WHERE id = ?1")
        .bind(result.importId)
        .first(),
    ).toEqual({ status: "committed" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 2 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM tickers WHERE symbol = 'CANON'",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("rolls back every finalization write when D1 rejects one statement", async () => {
    const { result } = await acceptedImport(
      csv(["2026-07-01,ROLLBACK,buy,1,1,Uncategorized,Default Account"]),
    );
    await env.DB.prepare(
      `CREATE TRIGGER injected_import_failure
       BEFORE INSERT ON transactions
       BEGIN SELECT RAISE(ABORT, 'injected_import_failure'); END`,
    ).run();
    try {
      await process(result.importId);
    } finally {
      await env.DB.prepare("DROP TRIGGER injected_import_failure").run();
    }
    expect(
      await env.DB.prepare(
        "SELECT status, terminal_error_code AS code FROM import_batches WHERE id = ?1",
      )
        .bind(result.importId)
        .first(),
    ).toEqual({ status: "terminal", code: "import_commit_failed" });
    expect(
      await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM instruments WHERE symbol = 'ROLLBACK') AS instruments,
           (SELECT COUNT(*) FROM transactions) AS transactions,
           (SELECT COUNT(*) FROM tickers WHERE symbol = 'ROLLBACK') AS tickers,
           (SELECT COUNT(*) FROM pipeline_jobs) AS jobs,
           (SELECT revision FROM position_basis_state WHERE id = 1) AS revision`,
      ).first(),
    ).toEqual({
      instruments: 0,
      transactions: 0,
      tickers: 0,
      jobs: 0,
      revision: 0,
    });
  });
});

describe("event import API", () => {
  const requestHeaders = {
    Origin: "http://local",
    Host: "local",
    "X-Stock-Tracker-Request": "1",
  };

  it("accepts a file with HTTP 202 and no synchronous provider work", async () => {
    const form = new FormData();
    form.set(
      "file",
      new File(
        [
          new TextDecoder().decode(
            csv(["invalid-date,UNKNOWN,buy,1,1,Missing,Account"]),
          ),
        ],
        "portfolio.csv",
        { type: "text/csv" },
      ),
    );
    const response = await exports.default.fetch(
      new Request("http://local/api/event-imports", {
        method: "POST",
        headers: requestHeaders,
        body: form,
      }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      importId: expect.any(String),
      status: "pending",
    });
  });

  it("requires same-origin application requests before parsing multipart", async () => {
    const response = await exports.default.fetch(
      new Request("http://local/api/event-imports", {
        method: "POST",
        body: new FormData(),
      }),
    );
    expect(response.status).toBe(403);
    expect(
      ((await response.json()) as { error: { code: string } }).error.code,
    ).toBe("csrf_rejected");
  });

  it("paginates row and provider failures", async () => {
    const { result } = await acceptedImport(
      csv([
        "bad,AAPL,hold,nope,-1,Missing,One",
        "bad,MSFT,hold,nope,-1,Missing,Two",
      ]),
    );
    await process(result.importId);
    const first = await exports.default.fetch(
      new Request(
        `http://local/api/event-imports/${result.importId}/errors?limit=1`,
      ),
    );
    const firstBody = (await first.json()) as {
      errors: Array<{ rowNumber: number; code: string }>;
      nextCursor: string | null;
    };
    expect(first.status).toBe(200);
    expect(firstBody.errors).toHaveLength(1);
    expect(firstBody.nextCursor).toEqual(expect.any(String));

    const second = await exports.default.fetch(
      new Request(
        `http://local/api/event-imports/${result.importId}/errors?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
      ),
    );
    expect(
      ((await second.json()) as { errors: unknown[] }).errors,
    ).toHaveLength(1);
  });
});
