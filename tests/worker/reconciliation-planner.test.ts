import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DividendRepository } from "../../src/db/dividends";
import { MarketFactRepository } from "../../src/db/market-facts";
import { PipelineJobRepository } from "../../src/db/pipeline-jobs";
import { WorkItemRepository } from "../../src/db/work-items";
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
  withPlanner?: boolean;
}): Promise<void> => {
  const job = {
    id: input.id,
    triggerType: input.triggerType ?? ("ledger_reconciliation" as const),
    requestedStartDate: input.startDate ?? "2026-07-01",
    requestedEndDate: input.endDate ?? latestDate,
    affectedInstrumentsJson: JSON.stringify(
      input.instruments ?? ["instrument-1"],
    ),
    eligibilityIntervalsJson: JSON.stringify(input.intervals ?? []),
    priority: input.priority ?? 100,
    status: "pending" as const,
    createdAt: now,
    updatedAt: now,
  };
  const jobs = new PipelineJobRepository(env.DB);
  const work = new WorkItemRepository(env.DB);
  const statements = [jobs.createStatement(job)];
  if (input.withPlanner !== false) {
    const plannerId = `planner-${input.id}`;
    statements.push(
      work.createPlanningStatement({
        id: plannerId,
        pipelineJobId: input.id,
        workType: "ledger_reconciliation_plan",
        deterministicKey: WorkItemRepository.planningKey(
          input.id,
          "ledger_reconciliation_plan",
        ),
        priority: input.priority ?? 100,
        maxAttempts: 3,
        createdAt: now,
        updatedAt: now,
      }),
      work.linkToJobStatement({
        pipelineJobId: input.id,
        workItemId: plannerId,
        relationship: "required",
        createdAt: now,
      }),
    );
  }
  await env.DB.batch(statements);
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
  it("skips exchange holidays even when a broad backfill interval includes them", async () => {
    await insertInstrument();
    await insertTransaction({ id: "holiday-buy", tradeDate: "2026-07-01" });
    await createJob({
      id: "holiday-backfill",
      triggerType: "backfill",
      startDate: "2026-07-02",
      endDate: "2026-07-03",
      intervals: [{ startDate: "2026-07-02", endDate: "2026-07-03" }],
    });

    const result = await planner().planPage({
      pipelineJobId: "holiday-backfill",
      latestCompletedTradingDate: latestDate,
    });

    expect((await listGlobal()).map((work) => work.effective_date)).toEqual([
      "2026-07-02",
    ]);
    expect(result.skippedCount).toBe(1);
  });

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
        `SELECT COUNT(*) AS count FROM job_work_items link
         JOIN work_items work ON work.id = link.work_item_id
         WHERE link.pipeline_job_id = 'quantity-only'
           AND work.scope = 'global_fact'`,
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
    expect(
      await env.DB.prepare(
        "SELECT state, processing_lease_until FROM work_items WHERE id = 'planner-first-buy'",
      ).first(),
    ).toEqual({ state: "complete", processing_lease_until: null });
  });

  it("shares deterministic child work while attaching every owning job", async () => {
    await insertInstrument();
    await insertTransaction({ id: "shared-buy", tradeDate: "2026-07-01" });
    const interval = [{ startDate: "2026-07-02", endDate: "2026-07-06" }];
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
    let plannerLeaseUntil: string | undefined;
    do {
      const page = await service.planPage({
        pipelineJobId: "long-history",
        cursor,
        ...(plannerLeaseUntil ? { plannerLeaseUntil } : {}),
        pageSize: 7,
        latestCompletedTradingDate: latestDate,
        previousCompletedTradingDate: previousDate,
      });
      pages.push(...page.globalWork.map((work) => work.deterministicKey));
      cursor = page.nextCursor;
      plannerLeaseUntil = page.plannerLeaseUntil ?? undefined;
    } while (cursor !== null);
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
    expect(
      await env.DB.prepare(
        "SELECT work_total, work_skipped FROM pipeline_jobs WHERE id = 'dividend-only'",
      ).first(),
    ).toEqual({ work_total: 1, work_skipped: 1 });

    await createJob({
      id: "forced-backfill",
      triggerType: "backfill",
      startDate: "2026-07-01",
      endDate: "2026-07-06",
      intervals: [{ startDate: "2026-07-02", endDate: "2026-07-06" }],
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

  it("pages dividend recalculations without repeating the full list", async () => {
    await insertInstrument();
    await insertTransaction({
      id: "dividend-page-buy",
      tradeDate: "2026-07-01",
    });
    await env.DB.batch([
      ...["2026-07-02", "2026-07-03", "2026-07-04"].map((date, index) =>
        new MarketFactRepository(env.DB).upsertStatement(
          validFact({
            id: `dividend-page-fact-${index}`,
            date,
            movement: "1",
          }),
        ),
      ),
      ...["2026-07-02", "2026-07-03", "2026-07-04"].map((date, index) =>
        new DividendRepository(env.DB).upsertStatement({
          id: `dividend-page-${index}`,
          instrumentId: "instrument-1",
          exDate: date,
          declarationDate: null,
          recordDate: null,
          paymentDate: null,
          amountPerShareDecimal: "0.25",
          currency: "USD",
          provider: "alpha-vantage",
          providerEventId: `dividend-page-${index}`,
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
      ),
    ]);
    await createJob({
      id: "dividend-pages",
      intervals: [{ startDate: "2026-07-02", endDate: "2026-07-08" }],
    });

    const service = planner();
    const first = await service.planPage({
      pipelineJobId: "dividend-pages",
      pageSize: 2,
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });
    expect(first.dividendRecalculations.map((event) => event.exDate)).toEqual([
      "2026-07-02",
      "2026-07-03",
    ]);
    expect(first.nextCursor).toBe("2");
    expect(first.nextDividendCursor).toBe("2");
    expect(first.complete).toBe(false);

    const second = await service.planPage({
      pipelineJobId: "dividend-pages",
      cursor: first.nextCursor,
      plannerLeaseUntil: first.plannerLeaseUntil as string,
      pageSize: 2,
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });
    expect(second.dividendRecalculations.map((event) => event.exDate)).toEqual([
      "2026-07-02",
      "2026-07-03",
    ]);
    expect(second.nextDividendCursor).toBe("2");
    expect(second.complete).toBe(false);

    const third = await service.planPage({
      pipelineJobId: "dividend-pages",
      cursor: "4",
      dividendCursor: second.nextDividendCursor,
      plannerLeaseUntil: second.plannerLeaseUntil as string,
      pageSize: 2,
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });
    expect(third.dividendRecalculations.map((event) => event.exDate)).toEqual([
      "2026-07-04",
    ]);
    expect(third.nextDividendCursor).toBe(null);
    expect(third.complete).toBe(true);
  });

  it("uses automatic priority for scheduled historical intervals", async () => {
    await insertInstrument();
    await insertTransaction({ id: "scheduled-buy", tradeDate: "2026-07-01" });
    await insertTransaction({
      id: "scheduled-sell",
      tradeDate: "2026-07-07",
      side: "sell",
    });
    await createJob({
      id: "scheduled-history",
      triggerType: "scheduled",
      intervals: [{ startDate: "2026-07-02", endDate: "2026-07-06" }],
    });

    const result = await planner().planPage({
      pipelineJobId: "scheduled-history",
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });
    expect(result.globalWork).toHaveLength(2);
    expect(result.globalWork.every((work) => work.priority === 100)).toBe(true);
  });

  it("requires the exact owning planner item and a live lease", async () => {
    await insertInstrument();
    await insertTransaction({ id: "lease-buy", tradeDate: "2026-07-01" });
    await createJob({ id: "missing-owner", withPlanner: false });
    await expect(
      planner().planPage({ pipelineJobId: "missing-owner" }),
    ).rejects.toThrow("planner_work_item_missing");

    await createJob({ id: "owner-a" });
    await createJob({ id: "owner-b" });
    await expect(
      planner().planPage({
        pipelineJobId: "owner-a",
        jobId: "owner-b",
      }),
    ).rejects.toThrow("pipeline_job_id_conflict");
    await expect(
      planner().planPage({
        pipelineJobId: "owner-a",
        plannerWorkItemId: "planner-owner-b",
      }),
    ).rejects.toThrow("planner_work_item_owner_mismatch");

    await createJob({
      id: "leased-owner",
      intervals: [{ startDate: "2026-07-02", endDate: "2026-07-06" }],
    });
    const service = planner();
    const first = await service.planPage({
      pipelineJobId: "leased-owner",
      pageSize: 1,
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });
    expect(first.complete).toBe(false);
    await expect(
      new ReconciliationPlannerService({
        db: env.DB,
        now: () => new Date(now),
        newId: () => "other-work",
      }).planPage({
        pipelineJobId: "leased-owner",
        cursor: first.nextCursor,
        pageSize: 1,
      }),
    ).rejects.toThrow("planner_lease_required");
    const expiredLease = "2026-07-10T20:00:00.000Z";
    await env.DB.prepare(
      "UPDATE work_items SET processing_lease_until = ?1 WHERE id = 'planner-leased-owner'",
    )
      .bind(expiredLease)
      .run();
    const recovered = await service.planPage({
      pipelineJobId: "leased-owner",
      cursor: first.nextCursor,
      plannerLeaseUntil: expiredLease,
      pageSize: 1,
      latestCompletedTradingDate: latestDate,
      previousCompletedTradingDate: previousDate,
    });
    expect(recovered.complete).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT state, attempt_count FROM work_items WHERE id = 'planner-leased-owner'",
      ).first(),
    ).toEqual({ state: "complete", attempt_count: 2 });
  });
});
