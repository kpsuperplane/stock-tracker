import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MovementAnalysisRepository } from "../../src/db/analyses";
import { DispatchBatchRepository } from "../../src/db/dispatch-batches";
import { DividendRepository } from "../../src/db/dividends";
import { MarketFactRepository } from "../../src/db/market-facts";
import { PipelineJobRepository } from "../../src/db/pipeline-jobs";
import { FactRevisionBucketRepository } from "../../src/db/revision-buckets";
import { WorkItemRepository } from "../../src/db/work-items";

const now = "2026-07-10T12:00:00.000Z";

async function insertInstrument(id = "instrument-1"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO instruments
     (id, symbol, company_name, exchange, currency, instrument_type,
      provider, provider_symbol, created_at, updated_at)
     VALUES (?1, ?2, 'Case Corp', 'NYSE', 'USD', 'stock',
             'yahoo', ?2, ?3, ?3)`,
  )
    .bind(id, `CASE-${id}`, now)
    .run();
}

const job = (id: string) => ({
  id,
  triggerType: "ledger_reconciliation" as const,
  requestedStartDate: "2026-07-01",
  requestedEndDate: "2026-07-10",
  affectedInstrumentsJson: '["instrument-1"]',
  eligibilityIntervalsJson: "[]",
  priority: 100,
  status: "pending" as const,
  createdAt: now,
  updatedAt: now,
});

const globalWork = (id: string, generation: number | null = null) => ({
  id,
  workType: "market_fact",
  instrumentId: "instrument-1",
  effectiveDate: "2026-07-10",
  dependencyRevision: "market-r1",
  forcedRefreshGeneration: generation,
  deterministicKey: WorkItemRepository.globalFactKey({
    workType: "market_fact",
    instrumentId: "instrument-1",
    effectiveDate: "2026-07-10",
    dependencyRevision: "market-r1",
    forcedRefreshGeneration: generation,
  }),
  priority: 100,
  maxAttempts: 3,
  availableAt: now,
  retentionUntil: null,
  createdAt: now,
  updatedAt: now,
});

describe("normalized facts and reconciliation schema", () => {
  it("adds normalized fact, revision, and dispatch tables without replacing legacy tables", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>();
    const names = tables.results.map(({ name }) => name);

    expect(names).toEqual(
      expect.arrayContaining([
        "tickers",
        "report_runs",
        "daily_market_facts",
        "movement_analyses",
        "news_sources",
        "dividend_events",
        "fact_revision_buckets",
        "dispatch_batches",
        "dispatch_batch_items",
      ]),
    );
  });

  it("enforces normalized fact constraints and deterministic identities", async () => {
    await insertInstrument();
    const marketFacts = new MarketFactRepository(env.DB);
    const analyses = new MovementAnalysisRepository(env.DB);
    const dividends = new DividendRepository(env.DB);
    await env.DB.batch([
      marketFacts.upsertStatement({
        id: "fact-1",
        instrumentId: "instrument-1",
        tradingDate: "2026-07-10",
        previousTradingDate: "2026-07-09",
        previousRawCloseDecimal: "10",
        currentRawCloseDecimal: "11",
        crossingSplitNumerator: "1",
        crossingSplitDenominator: "1",
        splitAdjustedPreviousCloseDecimal: "10",
        movementAmountDecimal: "1",
        movementPercentDecimal: "10",
        rawCloseDifferenceDecimal: "1",
        movementBasis: "split_adjusted_price_return",
        provider: "yahoo",
        providerRevision: "r1",
        retrievedAt: now,
        status: "valid",
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      }),
      analyses.upsertStatement({
        id: "analysis-1",
        dailyMarketFactId: "fact-1",
        dependencyFingerprint: "fact-r1/news-r1",
        summaryZhCn: "中文摘要",
        model: "test-model",
        status: "complete",
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      }),
      dividends.upsertStatement({
        id: "dividend-1",
        instrumentId: "instrument-1",
        exDate: "2026-08-01",
        declarationDate: "2026-07-01",
        recordDate: null,
        paymentDate: null,
        amountPerShareDecimal: "0.25",
        currency: "USD",
        provider: "alpha-vantage",
        providerEventId: "event-1",
        providerRevision: "revision-1",
        sourceUrl: "https://example.com/dividend",
        announcedAt: now,
        retrievedAt: now,
        status: "active",
        errorCode: null,
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
      }),
    ]);
    await expect(
      env.DB.prepare(
        `INSERT INTO news_sources
         (id, movement_analysis_id, source_order, title, source_url, created_at)
         VALUES ('bad-url', 'analysis-1', 0, 'Bad', 'javascript:alert(1)', ?1)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO daily_market_facts
         (id, instrument_id, trading_date, current_raw_close_decimal,
          movement_basis, provider, provider_revision, retrieved_at, status,
          created_at, updated_at)
         VALUES ('bad-fact', 'instrument-1', '2026-07-11', '',
                 'split_adjusted_price_return', 'yahoo', 'r2', ?1, 'valid', ?1, ?1)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `INSERT INTO dividend_events
         (id, instrument_id, ex_date, amount_per_share_decimal, currency,
          provider, provider_event_id, provider_revision, retrieved_at, status,
          created_at, updated_at)
         VALUES ('duplicate', 'instrument-1', '2026-08-01', '0.25', 'USD',
                 'alpha-vantage', 'event-1', 'revision-1', ?1, 'active', ?1, ?1)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow();
  });

  it("keeps month and latest revision buckets independent and monotonic", async () => {
    const buckets = new FactRevisionBucketRepository(env.DB);
    await env.DB.batch([
      buckets.bumpStatement("latest", now),
      buckets.bumpStatement("2026-07", now),
      buckets.bumpStatement("latest", "2026-07-10T13:00:00.000Z"),
    ]);
    expect(await buckets.revision("latest")).toBe(2);
    expect(await buckets.revision("2026-07")).toBe(1);
    await expect(
      env.DB.prepare(
        `INSERT INTO fact_revision_buckets (bucket_key, revision, updated_at)
         VALUES ('2026-13', 1, ?1)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow();
  });

  it("deduplicates global work while each job owns an independent link and planner", async () => {
    await insertInstrument();
    const jobs = new PipelineJobRepository(env.DB);
    const work = new WorkItemRepository(env.DB);
    await env.DB.batch([
      jobs.createStatement(job("job-a")),
      jobs.createStatement(job("job-b")),
    ]);

    const first = await work.ensureGlobal(globalWork("global-a"));
    const duplicate = await work.ensureGlobal(globalWork("global-b"));
    expect(duplicate.id).toBe(first.id);
    expect(
      await work.attachToJob({
        pipelineJobId: "job-a",
        workItemId: first.id,
        relationship: "required",
        now,
      }),
    ).toBe(true);
    expect(
      await work.attachToJob({
        pipelineJobId: "job-b",
        workItemId: first.id,
        relationship: "required",
        now,
      }),
    ).toBe(true);
    expect(
      await env.DB.prepare(
        `SELECT pipeline_job_id, outcome FROM job_work_items
         WHERE work_item_id = ?1 ORDER BY pipeline_job_id`,
      )
        .bind(first.id)
        .all(),
    ).toMatchObject({
      results: [
        { pipeline_job_id: "job-a", outcome: "pending" },
        { pipeline_job_id: "job-b", outcome: "pending" },
      ],
    });
    await env.DB.prepare(
      `UPDATE job_work_items SET outcome = 'processed', updated_at = ?1
       WHERE pipeline_job_id = 'job-a' AND work_item_id = ?2`,
    )
      .bind(now, first.id)
      .run();
    expect(
      await env.DB.prepare(
        `SELECT outcome FROM job_work_items
         WHERE pipeline_job_id = 'job-b' AND work_item_id = ?1`,
      )
        .bind(first.id)
        .first(),
    ).toEqual({ outcome: "pending" });

    const plannerKey = WorkItemRepository.planningKey(
      "job-a",
      "reconciliation_plan",
    );
    await work
      .createPlanningStatement({
        id: "planner-a",
        pipelineJobId: "job-a",
        workType: "reconciliation_plan",
        deterministicKey: plannerKey,
        priority: 100,
        maxAttempts: 3,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(() =>
      work.createPlanningStatement({
        id: "planner-b",
        pipelineJobId: "job-b",
        workType: "reconciliation_plan",
        deterministicKey: plannerKey,
        priority: 100,
        maxAttempts: 3,
        createdAt: now,
        updatedAt: now,
      }),
    ).toThrow("invalid_planning_work_key");
    await expect(
      work
        .createPlanningStatement({
          id: "planner-b",
          pipelineJobId: "job-b",
          workType: "reconciliation_plan",
          deterministicKey: WorkItemRepository.planningKey(
            "job-b",
            "reconciliation_plan",
          ),
          priority: 100,
          maxAttempts: 3,
          createdAt: now,
          updatedAt: now,
        })
        .run(),
    ).resolves.toBeDefined();
    expect(
      await work.attachToJob({
        pipelineJobId: "job-a",
        workItemId: "planner-a",
        relationship: "required",
        now,
      }),
    ).toBe(true);
    await expect(
      env.DB.prepare(
        `INSERT INTO job_work_items
           (pipeline_job_id, work_item_id, relationship, outcome, created_at)
           VALUES ('job-b', 'planner-a', 'required', 'pending', ?1)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow();
    await expect(
      env.DB.prepare(
        `UPDATE work_items SET pipeline_job_id = 'job-b'
           WHERE id = 'planner-a'`,
      ).run(),
    ).rejects.toThrow();
    await expect(
      work.attachToJob({
        pipelineJobId: "job-b",
        workItemId: "planner-a",
        relationship: "required",
        now,
      }),
    ).rejects.toThrow("job_planning_owner_mismatch");
    await env.DB.prepare(
      `INSERT INTO dispatch_batches
         (id, work_type, instrument_id, requested_start_date, requested_end_date,
          state, attempt_count, max_attempts, created_at, updated_at)
         VALUES ('dispatch-guard', 'market_fact', 'instrument-1', '2026-07-10',
                 '2026-07-10', 'dispatching', 0, 3, ?1, ?1)`,
    )
      .bind(now)
      .run();
    await expect(
      env.DB.prepare(
        `INSERT INTO dispatch_batch_items
           (dispatch_batch_id, work_item_id, created_at)
           VALUES ('dispatch-guard', 'planner-a', ?1)`,
      )
        .bind(now)
        .run(),
    ).rejects.toThrow();

    expect(
      await jobs.transition({
        id: "job-a",
        from: "pending",
        to: "planning",
        now,
      }),
    ).toBe(true);
    expect(
      await jobs.updateProgress({
        id: "job-a",
        progress: {
          workTotal: 2,
          workReused: 0,
          workSkipped: 0,
          workFetched: 1,
          workAnalyzed: 0,
          workProcessed: 1,
          workFailed: 0,
        },
        now,
      }),
    ).toBe(true);
    expect(
      await jobs.transition({
        id: "job-a",
        from: "planning",
        to: "complete",
        now,
        retentionUntil: "2026-08-10T12:00:00.000Z",
      }),
    ).toBe(true);
    await expect(
      jobs.transition({
        id: "job-a",
        from: "complete",
        to: "pending",
        now,
      }),
    ).rejects.toThrow("invalid_pipeline_job_transition");
    expect(
      await jobs.updateProgress({
        id: "job-a",
        progress: {
          workTotal: 99,
          workReused: 0,
          workSkipped: 0,
          workFetched: 0,
          workAnalyzed: 0,
          workProcessed: 0,
          workFailed: 0,
        },
        now,
      }),
    ).toBe(false);
  });

  it("separates forced refresh work and centralizes compatible dispatch transitions", async () => {
    await insertInstrument();
    const work = new WorkItemRepository(env.DB);
    const dispatch = new DispatchBatchRepository(env.DB);
    const base = await work.ensureGlobal(globalWork("global-base"));
    const forced = await work.ensureGlobal(globalWork("global-forced", 1));
    expect(forced.id).not.toBe(base.id);
    await expect(
      work.ensureGlobal({
        ...globalWork("typo"),
        deterministicKey:
          "fact:market_fact:instrument-1:2026-07-10:market-r1:0",
      }),
    ).rejects.toThrow("invalid_global_fact_key");
    expect(
      await work.claimForDispatch({
        id: base.id,
        now,
        leaseUntil: "2026-07-10T12:05:00.000Z",
      }),
    ).toBe(true);
    const dispatching = await work.findByDeterministicKey(
      base.deterministicKey,
    );
    if (!dispatching) throw new Error("dispatching work missing");
    await dispatch.createForWork({
      batch: {
        id: "dispatch-1",
        workType: "market_fact",
        instrumentId: "instrument-1",
        requestedStartDate: "2026-07-10",
        requestedEndDate: "2026-07-10",
        state: "dispatching",
        dispatchLeaseUntil: "2026-07-10T12:05:00.000Z",
        processingLeaseUntil: null,
        attemptCount: 1,
        maxAttempts: 3,
        terminalErrorCode: null,
        terminalErrorMessage: null,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        retentionUntil: null,
      },
      work: [dispatching],
    });
    await env.DB.prepare(
      `INSERT INTO dispatch_batches
         (id, work_type, instrument_id, requested_start_date, requested_end_date,
          state, attempt_count, max_attempts, created_at, updated_at)
         VALUES ('dispatch-update-bad', 'analysis', 'instrument-1', '2026-07-10',
                 '2026-07-10', 'dispatching', 0, 3, ?1, ?1)`,
    )
      .bind(now)
      .run();
    await expect(
      env.DB.prepare(
        `UPDATE dispatch_batch_items SET dispatch_batch_id = 'dispatch-update-bad'
           WHERE dispatch_batch_id = 'dispatch-1' AND work_item_id = ?1`,
      )
        .bind(base.id)
        .run(),
    ).rejects.toThrow();
    expect(
      await dispatch.reclaimExpiredDispatch({
        id: "dispatch-1",
        expectedLeaseUntil: "2026-07-10T12:05:00.000Z",
        now: "2026-07-10T12:06:00.000Z",
        leaseUntil: "2026-07-10T12:07:00.000Z",
      }),
    ).toBe(true);
    expect(
      await dispatch.transition({
        id: "dispatch-1",
        from: "dispatching",
        to: "queued",
        now: "2026-07-10T12:06:00.000Z",
        expectedDispatchLeaseUntil: "2026-07-10T12:05:00.000Z",
      }),
    ).toBe(false);
    expect(
      await dispatch.transition({
        id: "dispatch-1",
        from: "dispatching",
        to: "queued",
        now: "2026-07-10T12:06:00.000Z",
        expectedDispatchLeaseUntil: "2026-07-10T12:07:00.000Z",
      }),
    ).toBe(true);
    expect(
      await dispatch.transition({
        id: "dispatch-1",
        from: "queued",
        to: "processing",
        now,
        processingLeaseUntil: "2026-07-10T12:10:00.000Z",
      }),
    ).toBe(true);
    await expect(
      dispatch.transition({
        id: "dispatch-1",
        from: "processing",
        to: "terminal",
        now,
        expectedProcessingLeaseUntil: "2026-07-10T12:10:00.000Z",
      }),
    ).rejects.toThrow("terminal_dispatch_batch_requires_error");
    await expect(
      dispatch.createForWork({
        batch: {
          id: "bad-dispatch",
          workType: "analysis",
          instrumentId: "instrument-1",
          requestedStartDate: "2026-07-10",
          requestedEndDate: "2026-07-10",
          state: "dispatching",
          dispatchLeaseUntil: null,
          processingLeaseUntil: null,
          attemptCount: 0,
          maxAttempts: 3,
          terminalErrorCode: null,
          terminalErrorMessage: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          retentionUntil: null,
        },
        work: [dispatching],
      }),
    ).rejects.toThrow("dispatch_batch_incompatible_work");
    await env.DB.prepare(
      "UPDATE work_items SET state = 'pending' WHERE id = ?1",
    )
      .bind(forced.id)
      .run();
    await expect(
      dispatch.createForWork({
        batch: {
          id: "stale-work-batch",
          workType: "market_fact",
          instrumentId: "instrument-1",
          requestedStartDate: "2026-07-10",
          requestedEndDate: "2026-07-10",
          state: "dispatching",
          dispatchLeaseUntil: "2026-07-10T12:05:00.000Z",
          processingLeaseUntil: null,
          attemptCount: 1,
          maxAttempts: 3,
          terminalErrorCode: null,
          terminalErrorMessage: null,
          createdAt: now,
          updatedAt: now,
          completedAt: null,
          retentionUntil: null,
        },
        work: [forced],
      }),
    ).rejects.toThrow("dispatch_batch_incompatible_work");
    const leaseWork = await work.ensureGlobal({
      ...globalWork("lease-work", 2),
      effectiveDate: "2026-07-09",
      deterministicKey: WorkItemRepository.globalFactKey({
        workType: "market_fact",
        instrumentId: "instrument-1",
        effectiveDate: "2026-07-09",
        dependencyRevision: "market-r1",
        forcedRefreshGeneration: 2,
      }),
    });
    expect(
      await work.claimForDispatch({
        id: leaseWork.id,
        now,
        leaseUntil: "2026-07-10T12:01:00.000Z",
      }),
    ).toBe(true);
    expect(
      await work.recoverExpiredDispatch({
        id: leaseWork.id,
        expectedLeaseUntil: "2026-07-10T12:01:00.000Z",
        now: "2026-07-10T12:02:00.000Z",
      }),
    ).toBe(true);
    expect(
      await work.claimForDispatch({
        id: leaseWork.id,
        now: "2026-07-10T12:02:00.000Z",
        leaseUntil: "2026-07-10T12:03:00.000Z",
      }),
    ).toBe(true);
    expect(
      await work.transition({
        id: leaseWork.id,
        from: "dispatching",
        to: "queued",
        now: "2026-07-10T12:02:00.000Z",
        expectedDispatchLeaseUntil: "2026-07-10T12:01:00.000Z",
      }),
    ).toBe(false);
    await expect(
      work.transition({
        id: forced.id,
        from: "complete",
        to: "pending",
        now,
      }),
    ).rejects.toThrow("invalid_work_item_transition");
    await expect(
      work.transition({
        id: forced.id,
        from: "pending",
        to: "terminal",
        now,
      }),
    ).rejects.toThrow("terminal_work_item_requires_error");
    expect(
      await work.transition({
        id: forced.id,
        from: "pending",
        to: "terminal",
        now,
        errorCode: "provider_exhausted",
        errorMessage: "provider retry budget exhausted",
        retentionUntil: "2026-08-10T12:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      await env.DB.prepare(
        `SELECT state, terminal_error_code, retention_until FROM work_items
         WHERE id = ?1`,
      )
        .bind(forced.id)
        .first(),
    ).toEqual({
      state: "terminal",
      terminal_error_code: "provider_exhausted",
      retention_until: "2026-08-10T12:00:00.000Z",
    });
  });
});
