import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { MovementAnalysisRepository } from "../../src/db/analyses";
import { MarketFactRepository } from "../../src/db/market-facts";
import { PipelineJobRepository } from "../../src/db/pipeline-jobs";
import { WorkItemRepository } from "../../src/db/work-items";
import { ScheduledReconciliationService } from "../../src/services/scheduled-reconciliation";
import { WorkDispatcherService } from "../../src/services/work-dispatcher";
import type { PipelineDispatchMessage } from "../../src/shared/contracts";

const createdAt = "2026-07-12T03:00:00.000Z";
const recoveredAt = "2026-07-13T14:00:00.000Z";
const requestedDate = "2026-07-10";
const requestedEndDate = "2026-07-11";
const instrumentId = "ledger-recovery-instrument";

const insertLedger = async (tradeDate = "2026-07-01"): Promise<void> => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO instruments
       (id, symbol, company_name, exchange, currency, instrument_type,
        provider, provider_symbol, created_at, updated_at)
       VALUES (?1, 'RECOVER', 'Recovery Corp', 'NYSE', 'USD', 'stock',
               'yahoo', 'RECOVER', ?2, ?2)`,
    ).bind(instrumentId, createdAt),
    env.DB.prepare(
      `INSERT INTO transactions
       (id, instrument_id, trade_date, side, quantity_decimal, price_decimal,
        revision, created_at, updated_at)
       VALUES ('ledger-recovery-buy', ?1, ?2, 'buy', '1', '100',
               1, ?3, ?3)`,
    ).bind(instrumentId, tradeDate, createdAt),
  ]);
};

const createLedgerJob = async (
  id: string,
  intervals: readonly { startDate: string; endDate: string }[] = [
    { startDate: requestedDate, endDate: requestedDate },
  ],
): Promise<void> => {
  const jobs = new PipelineJobRepository(env.DB);
  const work = new WorkItemRepository(env.DB);
  const plannerId = `planner-${id}`;
  await env.DB.batch([
    jobs.createStatement({
      id,
      triggerType: "ledger_reconciliation",
      requestedStartDate: requestedDate,
      requestedEndDate,
      affectedInstrumentsJson: JSON.stringify([instrumentId]),
      eligibilityIntervalsJson: JSON.stringify(intervals),
      priority: 100,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    }),
    work.createPlanningStatement({
      id: plannerId,
      pipelineJobId: id,
      workType: "ledger_reconciliation_plan",
      deterministicKey: WorkItemRepository.planningKey(
        id,
        "ledger_reconciliation_plan",
      ),
      priority: 100,
      maxAttempts: 3,
      createdAt,
      updatedAt: createdAt,
    }),
    work.linkToJobStatement({
      pipelineJobId: id,
      workItemId: plannerId,
      relationship: "required",
      createdAt,
    }),
  ]);
};

const recoveryService = () =>
  new ScheduledReconciliationService({
    db: env.DB,
    now: () => new Date(recoveredAt),
    newId: (() => {
      let next = 0;
      return () => `ledger-recovery-work-${++next}`;
    })(),
  });

describe("ledger reconciliation lifecycle", () => {
  it("settles an old job without dispatching provider work when facts and analysis are already current", async () => {
    await insertLedger();
    await createLedgerJob("ledger-filled");
    await env.DB.batch([
      new MarketFactRepository(env.DB).upsertStatement({
        id: "ledger-filled-fact",
        instrumentId,
        tradingDate: requestedDate,
        previousTradingDate: "2026-07-09",
        previousRawCloseDecimal: "100",
        currentRawCloseDecimal: "106",
        crossingSplitNumerator: "1",
        crossingSplitDenominator: "1",
        splitAdjustedPreviousCloseDecimal: "100",
        movementAmountDecimal: "6",
        movementPercentDecimal: "6",
        rawCloseDifferenceDecimal: "6",
        movementBasis: "split_adjusted_price_return",
        provider: "yahoo-chart-v8",
        providerRevision: "r1",
        retrievedAt: createdAt,
        status: "valid",
        errorCode: null,
        errorMessage: null,
        createdAt,
        updatedAt: createdAt,
      }),
      new MovementAnalysisRepository(env.DB).upsertStatement({
        id: "ledger-filled-analysis",
        dailyMarketFactId: "ledger-filled-fact",
        dependencyFingerprint: "r1",
        summaryZhCn: "Already complete",
        model: "test",
        status: "complete",
        errorCode: null,
        errorMessage: null,
        createdAt,
        updatedAt: createdAt,
      }),
    ]);

    const first = await recoveryService().continueAutomaticPlanning(
      new Date(recoveredAt),
    );
    const second = await recoveryService().continueAutomaticPlanning(
      new Date(recoveredAt),
    );

    expect(first).toEqual({ jobs: 1, pages: 1, workItems: 0 });
    expect(second).toEqual({ jobs: 0, pages: 0, workItems: 0 });
    expect(
      await env.DB.prepare(
        "SELECT status FROM pipeline_jobs WHERE id = 'ledger-filled'",
      ).first(),
    ).toEqual({ status: "complete" });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM work_items WHERE scope = 'global_fact'",
      ).first(),
    ).toEqual({ count: 0 });
  });

  it("shares one missing-fact request across recovered jobs and preserves their original end date", async () => {
    await insertLedger();
    await createLedgerJob("ledger-missing-a");
    await createLedgerJob("ledger-missing-b");

    const result = await recoveryService().continueAutomaticPlanning(
      new Date(recoveredAt),
    );
    const globalWork = await env.DB.prepare(
      `SELECT id, effective_date AS effectiveDate
       FROM work_items WHERE scope = 'global_fact'`,
    ).all<{ id: string; effectiveDate: string }>();
    const linkedJobs = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM job_work_items
       WHERE work_item_id = ?1`,
    )
      .bind(globalWork.results[0]?.id)
      .first<{ count: number }>();

    expect(result).toEqual({ jobs: 2, pages: 2, workItems: 2 });
    expect(globalWork.results).toEqual([
      expect.objectContaining({ effectiveDate: requestedDate }),
    ]);
    expect(linkedJobs).toEqual({ count: 2 });

    const sent: PipelineDispatchMessage[] = [];
    const queue = {
      send: vi.fn(async (message: PipelineDispatchMessage) => {
        sent.push(message);
      }),
    } as unknown as Queue<PipelineDispatchMessage>;
    const dispatch = await new WorkDispatcherService({
      db: env.DB,
      queue,
      now: () => new Date(recoveredAt),
      newId: () => "ledger-recovery-batch",
    }).dispatch();

    expect(dispatch.dispatchedWorkItems).toBe(1);
    expect(sent).toHaveLength(1);
  });

  it("uses the two latest completed sessions when a weekend job introduced the current position", async () => {
    await insertLedger(requestedDate);
    await createLedgerJob("ledger-weekend-first-buy", []);

    await recoveryService().continueAutomaticPlanning(new Date(recoveredAt));

    const work = await env.DB.prepare(
      `SELECT effective_date AS effectiveDate
       FROM work_items WHERE scope = 'global_fact'
       ORDER BY effective_date`,
    ).all<{ effectiveDate: string }>();
    expect(work.results).toEqual([
      { effectiveDate: "2026-07-09" },
      { effectiveDate: "2026-07-10" },
    ]);
  });
});
