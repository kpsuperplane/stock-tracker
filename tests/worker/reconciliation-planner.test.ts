import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DividendRepository } from "../../src/db/dividends";
import { MarketFactRepository } from "../../src/db/market-facts";
import { PipelineJobRepository } from "../../src/db/pipeline-jobs";
import { ReconciliationPlannerService } from "../../src/services/reconciliation-planner";

const now = "2026-07-10T21:00:00.000Z";
const latestDate = "2026-07-10";
const previousDate = "2026-07-09";

const insertInstrument = async (id = "instrument-1"): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO instruments
     (id, symbol, company_name, exchange, currency, instrument_type,
      provider, provider_symbol, created_at, updated_at)
     VALUES (?1, ?2, 'Planner Corp', 'NYSE', 'USD', 'stock',
             'yahoo', ?2, ?3, ?3)`,
  )
    .bind(id, `PLAN-${id}`, now)
    .run();
};

const insertTransaction = async (input: {
  id: string;
  instrumentId?: string;
  tradeDate: string;
  side?: "buy" | "sell";
  quantity?: string;
}): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO transactions
     (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
      revision, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, '100', 1, ?6, ?6)`,
  )
    .bind(
      input.id,
      input.instrumentId ?? "instrument-1",
      input.tradeDate,
      input.side ?? "buy",
      input.quantity ?? "1",
      now,
    )
    .run();
};

const createJob = async (input: {
  id: string;
  triggerType?: "scheduled" | "ledger_reconciliation" | "backfill";
  startDate?: string;
  endDate?: string;
  intervals?: unknown[];
  instruments?: string[];
  priority?: number;
}): Promise<void> => {
  await new PipelineJobRepository(env.DB)
    .createStatement({
      id: input.id,
      triggerType: input.triggerType ?? "ledger_reconciliation",
      requestedStartDate: input.startDate ?? "2026-07-01",
      requestedEndDate: input.endDate ?? latestDate,
      affectedInstrumentsJson: JSON.stringify(
        input.instruments ?? ["instrument-1"],
      ),
      eligibilityIntervalsJson: JSON.stringify(input.intervals ?? []),
      priority: input.priority ?? 100,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    })
    .run();
};

const planner = () =>
  new ReconciliationPlannerService({
    db: env.DB,
    now: () => new Date(now),
    newId: (() => {
      let next = 0;
      return () => `planner-work-${++next}`;
    })(),
  });

const listGlobal = async () =>
  (
    await env.DB.prepare(
      `SELECT work_type, instrument_id, effective_date, dependency_revision,
              forced_refresh_generation, priority, state
       FROM work_items WHERE scope = 'global_fact'
       ORDER BY effective_date, instrument_id, work_type, id`,
    ).all<{
      work_type: string;
      instrument_id: string;
      effective_date: string;
      dependency_revision: string;
      forced_refresh_generation: number | null;
      priority: number;
      state: string;
    }>()
  ).results;

const validFact = (input: {
  id: string;
  date: string;
  movement?: string;
  basis?: "split_adjusted_price_return" | "legacy_migration";
  status?: "valid" | "stale" | "error";
  splitNumerator?: string;
  splitDenominator?: string;
}): Parameters<MarketFactRepository["upsertStatement"]>[0] => ({
  id: input.id,
  instrumentId: "instrument-1",
  tradingDate: input.date,
  previousTradingDate: (() => {
    const date = new Date(`${input.date}T12:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() - 1);
    return date.toISOString().slice(0, 10);
  })(),
  previousRawCloseDecimal: "100",
  currentRawCloseDecimal: "105",
  crossingSplitNumerator: input.splitNumerator ?? "1",
  crossingSplitDenominator: input.splitDenominator ?? "1",
  splitAdjustedPreviousCloseDecimal: "100",
  movementAmountDecimal: input.movement ?? "5",
  movementPercentDecimal: input.movement ?? "5",
  rawCloseDifferenceDecimal: "5",
  movementBasis: input.basis ?? "split_adjusted_price_return",
  provider: "yahoo-chart-v8",
  providerRevision: "r1",
  retrievedAt: now,
  status: input.status ?? "valid",
  errorCode: null,
  errorMessage: null,
  createdAt: now,
  updatedAt: now,
});

describe("incremental reconciliation planner", () => {
  it("does not create work for a quantity-only positive-position edit", async () => {
    await insertInstrument();
    await insertTransaction({ id: "buy-1", tradeDate: "2026-07-01" });
    await insertTransaction({
      id: "buy-2",
      tradeDate: "2026-07-05",
      quantity: "2",
    });
    await createJob({ id: "quantity-only", intervals: [] });

    const result = await planner().planPage({
      pipelineJobId: "quantity-only",
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });

    expect(result.complete).toBe(true);
    expect(result.globalWork).toHaveLength(0);
    expect(result.attachedCount).toBe(0);
    expect(await listGlobal()).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM job_work_items WHERE pipeline_job_id = 'quantity-only'",
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it("requests both latest completed bars for a first current buy", async () => {
    await insertInstrument();
    await insertTransaction({ id: "current-buy", tradeDate: latestDate });
    await createJob({
      id: "first-buy",
      startDate: latestDate,
      intervals: [],
    });

    const result = await planner().planPage({
      pipelineJobId: "first-buy",
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });

    expect(result.globalWork.map((work) => work.effectiveDate)).toEqual([
      latestDate,
      previousDate,
    ]);
    expect(
      result.globalWork.every((work) => work.workType === "market_fact"),
    ).toBe(true);
    expect(
      result.globalWork.find((work) => work.effectiveDate === latestDate)
        ?.priority,
    ).toBe(300);
    expect(
      result.globalWork.find((work) => work.effectiveDate === previousDate)
        ?.priority,
    ).toBe(100);
    expect(
      await env.DB.prepare(
        "SELECT status FROM pipeline_jobs WHERE id = 'first-buy'",
      ).first<{ status: string }>(),
    ).toEqual({ status: "running" });
  });

  it("shares deterministic child work while attaching every owning job", async () => {
    await insertInstrument();
    await insertTransaction({ id: "shared-buy", tradeDate: "2026-07-01" });
    const interval = [{ startDate: "2026-07-02", endDate: "2026-07-03" }];
    await createJob({ id: "shared-a", intervals: interval });
    await createJob({ id: "shared-b", intervals: interval });

    const service = planner();
    const first = await service.planPage({
      pipelineJobId: "shared-a",
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });
    const second = await service.planPage({
      pipelineJobId: "shared-b",
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });

    expect(first.globalWork).toHaveLength(2);
    expect(second.globalWork).toHaveLength(2);
    expect(await listGlobal()).toHaveLength(2);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM job_work_items WHERE work_item_id IN (SELECT id FROM work_items WHERE scope = 'global_fact')",
      ).first<{ count: number }>(),
    ).toEqual({ count: 4 });
    expect(second.createdCount).toBe(0);
    expect(second.attachedCount).toBe(2);
  });

  it("resumes a long historical plan in bounded, idempotent pages", async () => {
    await insertInstrument();
    await insertTransaction({ id: "history-buy", tradeDate: "2026-01-01" });
    await createJob({
      id: "long-history",
      startDate: "2026-01-01",
      endDate: "2026-07-10",
      triggerType: "backfill",
    });

    const pages: string[] = [];
    const service = planner();
    let cursor: string | null = null;
    do {
      const page = await service.planPage({
        pipelineJobId: "long-history",
        cursor,
        pageSize: 7,
        latestCompletedTradingDate: latestDate,
        previousCompletedTradingDate: previousDate,
      });
      pages.push(...page.globalWork.map((work) => work.deterministicKey));
      cursor = page.nextCursor;
    } while (cursor !== null);

    const repeated = await service.planPage({
      pipelineJobId: "long-history",
      cursor: "0",
      pageSize: 7,
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });
    expect(repeated.createdCount).toBe(0);
    expect(repeated.attachedCount).toBe(0);
    expect(new Set(pages).size).toBe(pages.length);
    expect(pages.length).toBeGreaterThan(100);
    expect(await listGlobal()).toHaveLength(pages.length);
  });

  it("queues legacy and split-correction refreshes, and only missing qualifying analysis", async () => {
    await insertInstrument();
    await insertTransaction({ id: "split-buy", tradeDate: "2026-07-01" });
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO corporate_actions
           (id, instrument_id, action_type, effective_date, split_numerator,
            split_denominator, provider, provider_event_id, provider_revision,
            retrieved_at, revision, status, created_at, updated_at)
           VALUES ('split-1', 'instrument-1', 'split', '2026-07-09', '2', '1',
                   'yahoo', 'split-1', 'r2', ?1, 1, 'active', ?1, ?1)`,
      ).bind(now),
      new MarketFactRepository(env.DB).upsertStatement(
        validFact({
          id: "legacy-fact",
          date: latestDate,
          basis: "legacy_migration",
          splitNumerator: "1",
          splitDenominator: "1",
        }),
      ),
      new MarketFactRepository(env.DB).upsertStatement(
        validFact({ id: "movement-fact", date: previousDate, movement: "6" }),
      ),
      new MarketFactRepository(env.DB).upsertStatement(
        validFact({ id: "analysis-fact", date: "2026-07-08", movement: "6" }),
      ),
    ]);
    await createJob({
      id: "refreshes",
      intervals: [{ startDate: "2026-07-08", endDate: latestDate }],
    });

    const result = await planner().planPage({
      pipelineJobId: "refreshes",
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });
    expect(
      result.globalWork.map((work) => [work.workType, work.effectiveDate]),
    ).toEqual(
      expect.arrayContaining([
        ["market_fact", latestDate],
        ["market_fact", previousDate],
        ["analysis", "2026-07-08"],
      ]),
    );
  });

  it("keeps dividend-only recalculation local and supports forced Backfill generations", async () => {
    await insertInstrument();
    await insertTransaction({ id: "dividend-buy", tradeDate: "2026-07-01" });
    await env.DB.batch([
      new MarketFactRepository(env.DB).upsertStatement(
        validFact({ id: "dividend-fact", date: "2026-07-02", movement: "1" }),
      ),
      new DividendRepository(env.DB).upsertStatement({
        id: "dividend-1",
        instrumentId: "instrument-1",
        exDate: "2026-07-02",
        declarationDate: null,
        recordDate: null,
        paymentDate: null,
        amountPerShareDecimal: "0.25",
        currency: "USD",
        provider: "alpha-vantage",
        providerEventId: "dividend-1",
        providerRevision: "r1",
        sourceUrl: null,
        announcedAt: null,
        retrievedAt: now,
        status: "active",
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
    await createJob({
      id: "dividend-only",
      intervals: [{ startDate: "2026-07-02", endDate: "2026-07-02" }],
    });
    const dividendResult = await planner().planPage({
      pipelineJobId: "dividend-only",
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });
    expect(dividendResult.globalWork).toHaveLength(0);
    expect(dividendResult.dividendRecalculations).toEqual([
      { instrumentId: "instrument-1", exDate: "2026-07-02" },
    ]);

    await createJob({
      id: "forced-backfill",
      triggerType: "backfill",
      startDate: "2026-07-01",
      endDate: "2026-07-03",
      intervals: [{ startDate: "2026-07-02", endDate: "2026-07-03" }],
    });
    const forced = await planner().planPage({
      pipelineJobId: "forced-backfill",
      forceRefresh: true,
      forcedRefreshGeneration: 7,
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });
    expect(forced.globalWork).toHaveLength(2);
    expect(
      forced.globalWork.every((work) => work.forcedRefreshGeneration === 7),
    ).toBe(true);
    expect(forced.globalWork.every((work) => work.priority === 200)).toBe(true);
  });
});
