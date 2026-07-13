import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import type {
  CorporateActionProvider,
  SplitEventRange,
} from "../../src/providers/corporate-actions";
import { LedgerService } from "../../src/services/ledger";

const now = "2026-07-10T12:00:00.000Z";

async function insertInstrument(
  id = "instrument-1",
  symbol = "CASE",
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO instruments
     (id, symbol, company_name, exchange, currency, instrument_type,
      provider, provider_symbol, created_at, updated_at)
     VALUES (?1, ?2, 'Case Corp', 'NYSE', 'USD', 'stock',
             'yahoo', ?2, ?3, ?3)`,
  )
    .bind(id, symbol, now)
    .run();
}

const snapshot = (
  overrides: Partial<SplitEventRange> = {},
): SplitEventRange => ({
  symbol: "CASE",
  range: {
    requestedStartDate: "2024-01-01",
    requestedEndDate: "2026-07-10",
    coverageStartDate: null,
    coverageEndDate: null,
    isComplete: false,
    basis: "unverified",
    provider: "yahoo-chart-v8",
    observedAt: now,
    providerRevision: "snapshot-r1",
  },
  events: [
    {
      type: "split",
      symbol: "CASE",
      effectiveDate: "2025-01-02",
      numerator: "2",
      denominator: "1",
      provider: "yahoo-chart-v8",
      providerEventId: "yahoo-chart-v8:CASE:split:2025-01-02",
      providerRevision: "2025-01-02|2:1",
    },
  ],
  ...overrides,
});

const service = (provider: CorporateActionProvider) =>
  new LedgerService({
    db: env.DB,
    corporateActionProvider: provider,
    now: () => new Date(now),
  });

const rangeSnapshot = (
  symbol: string,
  startDate: string,
  endDate: string,
  providerRevision = "snapshot-r1",
  events: SplitEventRange["events"] = [],
): SplitEventRange => ({
  symbol,
  range: {
    requestedStartDate: startDate,
    requestedEndDate: endDate,
    coverageStartDate: null,
    coverageEndDate: null,
    isComplete: false,
    basis: "unverified",
    provider: "yahoo-chart-v8",
    observedAt: now,
    providerRevision,
  },
  events,
});

const dynamicProvider = (
  revision = "snapshot-r1",
  events: SplitEventRange["events"] = [],
): CorporateActionProvider => ({
  getSplits: async (symbol, startDate, endDate) =>
    rangeSnapshot(symbol.toUpperCase(), startDate, endDate, revision, events),
});

async function seedConfirmedCoverage(input: {
  instrumentId: string;
  startDate: string;
  endDate?: string;
  revision?: string;
}): Promise<void> {
  const endDate = input.endDate ?? "2026-07-10";
  const revision = input.revision ?? "snapshot-r1";
  await env.DB.prepare(
    `INSERT INTO corporate_action_coverage
     (instrument_id, provider, requested_start_date, requested_end_date,
      snapshot_provider_revision, retrieved_at, confirmed_start_date,
      confirmed_end_date, confirmed_provider_revision, confirmed_at,
      status, updated_at)
     VALUES (?1, 'yahoo-chart-v8', ?2, ?3, ?4, ?5, ?2, ?3, ?4, ?5,
             'confirmed', ?5)`,
  )
    .bind(input.instrumentId, input.startDate, endDate, revision, now)
    .run();
}

describe("LedgerService", () => {
  it("automatically applies a server-fetched split snapshot before a historical create", async () => {
    await insertInstrument();
    const getSplits = vi.fn(async () => snapshot());

    const result = await service({ getSplits }).apply({
      expectedPositionBasisRevision: 0,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2024-01-01",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "10",
      },
    });

    expect(result.kind).toBe("committed");
    expect(getSplits).toHaveBeenCalledWith("CASE", "2024-01-01", "2026-07-10");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        `SELECT status, snapshot_provider_revision
         FROM corporate_action_coverage WHERE instrument_id = 'instrument-1'`,
      ).first(),
    ).toEqual({
      status: "confirmed",
      snapshot_provider_revision: "snapshot-r1",
    });
  });

  it("commits with retry state when the split snapshot cannot be fetched", async () => {
    await insertInstrument();
    const result = await service({
      getSplits: async () => {
        throw new Error("provider_http_429");
      },
    }).apply({
      expectedPositionBasisRevision: 0,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2024-01-01",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "10",
      },
    });

    expect(result).toMatchObject({
      kind: "committed",
      warningCode: "split_history_unavailable",
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM ledger_mutations",
      ).first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT status, error_code FROM corporate_action_coverage",
      ).first(),
    ).toEqual({ status: "unavailable", error_code: "provider_http_429" });
  });

  it("commits a server snapshot with its transaction, action, job, and planning work", async () => {
    await insertInstrument();
    const provider = dynamicProvider("snapshot-r1", snapshot().events);
    const result = await service(provider).apply({
      expectedPositionBasisRevision: 0,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2024-01-01",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "10",
      },
    });

    expect(result.kind).toBe("committed");
    if (result.kind !== "committed") return;
    expect(result.positionBasisRevision).toBe(1);
    expect(
      await env.DB.prepare("SELECT status FROM corporate_actions").first(),
    ).toEqual({ status: "active" });
    expect(
      await env.DB.prepare(
        "SELECT status FROM corporate_action_coverage",
      ).first(),
    ).toEqual({ status: "confirmed" });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM job_work_items WHERE pipeline_job_id = ?1`,
      )
        .bind(result.pipelineJobId)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("preserves same-provider active actions outside a confirmed snapshot range", async () => {
    await insertInstrument();
    await seedConfirmedCoverage({
      instrumentId: "instrument-1",
      startDate: "2025-01-01",
    });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO corporate_actions
           (id, instrument_id, action_type, effective_date, split_numerator,
            split_denominator, provider, provider_event_id, provider_revision,
            retrieved_at, revision, status, created_at, updated_at)
           VALUES ('old-active', 'instrument-1', 'split', '2024-06-01', '2', '1',
                   'yahoo-chart-v8', 'old-event', 'old-r1', ?1, 1, 'active', ?1, ?1)`,
      ).bind(now),
      env.DB.prepare(
        `INSERT INTO corporate_actions
           (id, instrument_id, action_type, effective_date, split_numerator,
            split_denominator, provider, provider_event_id, provider_revision,
            retrieved_at, revision, status, created_at, updated_at)
           VALUES ('in-range-active', 'instrument-1', 'split', '2025-02-01', '2', '1',
                   'yahoo-chart-v8', 'in-range-event', 'in-range-r1', ?1, 1,
                   'active', ?1, ?1)`,
      ).bind(now),
    ]);

    const result = await service(dynamicProvider()).apply({
      expectedPositionBasisRevision: 0,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2025-01-01",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "10",
      },
    });

    expect(result.kind).toBe("committed");
    expect(
      await env.DB.prepare(
        `SELECT id, status FROM corporate_actions ORDER BY effective_date`,
      ).all(),
    ).toEqual({
      results: [
        { id: "old-active", status: "active" },
        { id: "in-range-active", status: "superseded" },
      ],
      success: true,
      meta: expect.anything(),
    });
  });

  it("automatically refreshes when a proposal reaches earlier history", async () => {
    await insertInstrument();
    const provider = dynamicProvider();
    const first = await service(provider).apply({
      expectedPositionBasisRevision: 0,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2025-01-01",
        side: "buy",
        quantityDecimal: "2",
        priceDecimal: "10",
      },
    });
    expect(first.kind).toBe("committed");
    const oldRangeBefore = await env.DB.prepare(
      "SELECT revision FROM fact_revision_buckets WHERE bucket_key = '2025-06'",
    ).first<{ revision: number }>();

    const result = await service(provider).apply({
      expectedPositionBasisRevision: 1,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2024-01-01",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "10",
      },
    });
    expect(result.kind).toBe("committed");
    expect(
      await env.DB.prepare(
        "SELECT requested_start_date, status FROM corporate_action_coverage",
      ).first(),
    ).toEqual({ requested_start_date: "2024-01-01", status: "confirmed" });
    const oldRangeAfter = await env.DB.prepare(
      "SELECT revision FROM fact_revision_buckets WHERE bucket_key = '2025-06'",
    ).first<{ revision: number }>();
    expect(oldRangeAfter?.revision).toBeGreaterThan(
      oldRangeBefore?.revision ?? 0,
    );
  });

  it("automatically applies a new provider snapshot revision", async () => {
    await insertInstrument();
    const initialProvider = dynamicProvider();
    await service(initialProvider).apply({
      expectedPositionBasisRevision: 0,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2025-01-01",
        side: "buy",
        quantityDecimal: "2",
        priceDecimal: "10",
      },
    });

    const result = await service(dynamicProvider("snapshot-r2")).apply({
      expectedPositionBasisRevision: 1,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2025-02-01",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "10",
      },
    });
    expect(result.kind).toBe("committed");
    expect(
      await env.DB.prepare(
        "SELECT status, snapshot_provider_revision FROM corporate_action_coverage",
      ).first(),
    ).toEqual({
      status: "confirmed",
      snapshot_provider_revision: "snapshot-r2",
    });
  });

  it("rejects negative histories and stale event or basis revisions before committing", async () => {
    await insertInstrument();
    const provider = dynamicProvider();
    const created = await service(provider).apply({
      expectedPositionBasisRevision: 0,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2025-01-01",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "10",
      },
    });
    if (created.kind !== "committed" || !created.transactionId)
      throw new Error("setup failed");

    const negative = await service(provider).apply({
      expectedPositionBasisRevision: 1,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2025-01-02",
        side: "sell",
        quantityDecimal: "2",
        priceDecimal: "10",
      },
    });
    expect(negative).toEqual({
      kind: "validation_error",
      code: "negative_holdings",
    });

    const staleEvent = await service(provider).apply({
      expectedPositionBasisRevision: 1,
      proposal: {
        kind: "update",
        eventId: created.transactionId,
        expectedEventRevision: 0,
        tradeDate: "2025-01-01",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "11",
      },
    });
    expect(staleEvent).toEqual({ kind: "conflict", code: "event_conflict" });

    const staleBasis = await service(provider).apply({
      expectedPositionBasisRevision: 0,
      proposal: {
        kind: "update",
        eventId: created.transactionId,
        expectedEventRevision: 1,
        tradeDate: "2025-01-01",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "11",
      },
    });
    expect(staleBasis).toEqual({ kind: "conflict", code: "ledger_conflict" });
  });

  it("quarantines a provider correction that makes historical holdings negative", async () => {
    await insertInstrument();
    const normal = dynamicProvider();
    await service(normal).apply({
      expectedPositionBasisRevision: 0,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2025-01-01",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "10",
      },
    });
    await service(normal).apply({
      expectedPositionBasisRevision: 1,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2025-02-01",
        side: "sell",
        quantityDecimal: "0.75",
        priceDecimal: "10",
      },
    });

    const correction = {
      type: "split" as const,
      symbol: "CASE",
      effectiveDate: "2025-01-15",
      numerator: "1",
      denominator: "2",
      provider: "yahoo-chart-v8",
      providerEventId: "yahoo-chart-v8:CASE:split:2025-01-15",
      providerRevision: "2025-01-15|1:2",
    };
    const result = await service(
      dynamicProvider("snapshot-r2", [correction]),
    ).apply({
      expectedPositionBasisRevision: 2,
      proposal: {
        kind: "update",
        eventId:
          (
            await env.DB.prepare(
              "SELECT id FROM transactions WHERE side = 'sell'",
            ).first<{ id: string }>()
          )?.id ?? "missing",
        expectedEventRevision: 1,
        tradeDate: "2025-02-01",
        side: "sell",
        quantityDecimal: "0.75",
        priceDecimal: "11",
      },
    });
    expect(result).toMatchObject({
      kind: "committed",
      warningCode: "split_history_conflict",
    });
    expect(
      await env.DB.prepare(
        "SELECT status, conflict_code FROM corporate_actions",
      ).first(),
    ).toEqual({ status: "quarantined", conflict_code: "negative_history" });
  });

  it("automatically enriches independent instruments", async () => {
    await insertInstrument("instrument-a", "A");
    await insertInstrument("instrument-b", "B");
    const provider = dynamicProvider();
    const first = await service(provider).apply({
      expectedPositionBasisRevision: 0,
      proposal: {
        kind: "create",
        instrumentId: "instrument-a",
        tradeDate: "2025-01-01",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "10",
      },
    });
    expect(first.kind).toBe("committed");

    const committed = await service(provider).apply({
      expectedPositionBasisRevision: 1,
      proposal: {
        kind: "create",
        instrumentId: "instrument-b",
        tradeDate: "2025-01-01",
        side: "buy",
        quantityDecimal: "1",
        priceDecimal: "10",
      },
    });
    expect(committed.kind).toBe("committed");
  });

  it("can resolve an edit while automatically promoting the provider snapshot", async () => {
    await insertInstrument();
    const normal = dynamicProvider();
    const buy = await service(normal).apply({
      expectedPositionBasisRevision: 0,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2025-01-01",
        side: "buy",
        quantityDecimal: "2",
        priceDecimal: "10",
      },
    });
    if (buy.kind !== "committed") throw new Error("buy setup failed");
    const sell = await service(normal).apply({
      expectedPositionBasisRevision: 1,
      proposal: {
        kind: "create",
        instrumentId: "instrument-1",
        tradeDate: "2025-02-01",
        side: "sell",
        quantityDecimal: "1",
        priceDecimal: "10",
      },
    });
    if (sell.kind !== "committed" || !sell.transactionId)
      throw new Error("sell setup failed");

    const correction = {
      type: "split" as const,
      symbol: "CASE",
      effectiveDate: "2025-01-15",
      numerator: "1",
      denominator: "3",
      provider: "yahoo-chart-v8",
      providerEventId: "yahoo-chart-v8:CASE:split:2025-01-15",
      providerRevision: "2025-01-15|1:3",
    };
    const resolved = await service(
      dynamicProvider("snapshot-r2", [correction]),
    ).apply({
      expectedPositionBasisRevision: 2,
      proposal: {
        kind: "update",
        eventId: sell.transactionId,
        expectedEventRevision: 1,
        tradeDate: "2025-02-01",
        side: "sell",
        quantityDecimal: "0.5",
        priceDecimal: "10",
      },
    });
    expect(resolved.kind).toBe("committed");
    expect(
      await env.DB.prepare("SELECT status FROM corporate_actions").first(),
    ).toEqual({ status: "active" });
    expect(
      await env.DB.prepare("SELECT revision FROM transactions WHERE id = ?1")
        .bind(sell.transactionId)
        .first(),
    ).toEqual({ revision: 2 });
  });

  it("allows only one of two competing 100-position proposals to commit", async () => {
    for (let index = 0; index < 101; index += 1) {
      await insertInstrument(`instrument-${index}`, `S${index}`);
      if (index < 99) {
        await env.DB.prepare(
          `INSERT INTO transactions
           (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
            revision, created_at, updated_at)
           VALUES (?1, ?2, '2025-01-01', 'buy', '1', '1', 1, ?3, ?3)`,
        )
          .bind(`seed-${index}`, `instrument-${index}`, now)
          .run();
      } else {
        await seedConfirmedCoverage({
          instrumentId: `instrument-${index}`,
          startDate: "2026-07-10",
        });
      }
    }
    const provider = dynamicProvider();
    const proposal = (instrumentId: string) =>
      service(provider).apply({
        expectedPositionBasisRevision: 0,
        proposal: {
          kind: "create",
          instrumentId,
          tradeDate: "2026-07-10",
          side: "buy",
          quantityDecimal: "1",
          priceDecimal: "1",
        },
      });
    const results = await Promise.all([
      proposal("instrument-99"),
      proposal("instrument-100"),
    ]);
    expect(
      results.filter((result) => result.kind === "committed"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.kind === "conflict")).toHaveLength(
      1,
    );
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM transactions",
      ).first(),
    ).toEqual({ count: 100 });
  });
});
