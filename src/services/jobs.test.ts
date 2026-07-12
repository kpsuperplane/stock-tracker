import { describe, expect, it, vi } from "vitest";
import type { ScreeningJobMessage } from "../shared/contracts";
import { JobsService, weekdaysInRange } from "./jobs";

const repository = () => ({
  createBackfill: vi.fn(async () => "backfill-id"),
  hasPublishedDate: vi.fn(async (_date: string) => false),
  createRun: vi.fn(async () => ({ runId: "run-id", screeningIds: [] })),
  findScheduledRun: vi.fn(async () => null),
  reconcileStaleLeases: vi.fn(async () => 0),
  countDispatchedSince: vi.fn(async () => 0),
  dispatchPending: vi.fn(async () => 0),
  finalizeRun: vi.fn(async () => "no_market_data" as const),
  pauseRunningBackfills: vi.fn(async () => undefined),
});

describe("backfill jobs", () => {
  it("expands an inclusive range to weekdays", () => {
    expect(weekdaysInRange("2026-07-03", "2026-07-09")).toEqual([
      "2026-07-03",
      "2026-07-06",
      "2026-07-07",
      "2026-07-08",
      "2026-07-09",
    ]);
  });

  it("rejects a range longer than 30 calendar days", async () => {
    const service = new JobsService(
      repository(),
      { listActive: vi.fn(async () => []) },
      {} as Queue<ScreeningJobMessage>,
    );
    await expect(
      service.createBackfill(
        {
          startDate: "2026-05-01",
          endDate: "2026-06-01",
          reprocessExisting: false,
        },
        "2026-07-09T22:00:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "backfill_range" });
  });

  it("rejects reversed and future ranges", async () => {
    const service = new JobsService(
      repository(),
      { listActive: vi.fn(async () => []) },
      {} as Queue<ScreeningJobMessage>,
    );
    await expect(
      service.createBackfill(
        {
          startDate: "2026-07-09",
          endDate: "2026-07-08",
          reprocessExisting: false,
        },
        "2026-07-09T22:00:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "backfill_dates" });
    await expect(
      service.createBackfill(
        {
          startDate: "2026-07-09",
          endDate: "2026-07-10",
          reprocessExisting: false,
        },
        "2026-07-09T22:00:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "backfill_dates" });
  });

  it("rejects today's date because the scheduled run owns the current session", async () => {
    const service = new JobsService(
      repository(),
      { listActive: vi.fn(async () => []) },
      {} as Queue<ScreeningJobMessage>,
    );
    await expect(
      service.createBackfill(
        {
          startDate: "2026-07-09",
          endDate: "2026-07-09",
          reprocessExisting: false,
        },
        "2026-07-09T22:00:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "backfill_dates" });
  });

  it("keeps using the Eastern market date after UTC midnight", async () => {
    const service = new JobsService(
      repository(),
      { listActive: vi.fn(async () => []) },
      {} as Queue<ScreeningJobMessage>,
    );
    await expect(
      service.createBackfill(
        {
          startDate: "2026-07-09",
          endDate: "2026-07-09",
          reprocessExisting: false,
        },
        "2026-07-10T00:30:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "backfill_dates" });
  });

  it("skips published dates and snapshots the same active ticker set", async () => {
    const runs = repository();
    runs.hasPublishedDate.mockImplementation(
      async (date) => date === "2026-07-07",
    );
    const tickers = [
      {
        id: "aapl",
        symbol: "AAPL",
        companyName: "Apple Inc.",
        exchange: "NMS",
        currency: "USD",
        active: true,
        deletedAt: null,
      },
    ];
    const service = new JobsService(
      runs,
      { listActive: vi.fn(async () => tickers) },
      {} as Queue<ScreeningJobMessage>,
    );
    await service.createBackfill(
      {
        startDate: "2026-07-06",
        endDate: "2026-07-08",
        reprocessExisting: false,
      },
      "2026-07-09T22:00:00.000Z",
    );
    expect(runs.createBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ datesTotal: 2 }),
    );
    expect(runs.createRun).toHaveBeenCalledTimes(2);
    expect(runs.createRun).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ tradingDate: "2026-07-06", tickers }),
    );
    expect(runs.createRun).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tradingDate: "2026-07-08", tickers }),
    );
  });

  it("plans each exchange only on its own trading days", async () => {
    const runs = repository();
    const usTicker = {
      id: "aapl",
      symbol: "AAPL",
      companyName: "Apple Inc.",
      exchange: "NMS",
      currency: "USD",
      active: true,
      deletedAt: null,
    };
    const canadianTicker = {
      ...usTicker,
      id: "shop",
      symbol: "SHOP.TO",
      companyName: "Shopify Inc.",
      exchange: "TSX",
      currency: "CAD",
    };
    const service = new JobsService(
      runs,
      { listActive: vi.fn(async () => [usTicker, canadianTicker]) },
      {} as Queue<ScreeningJobMessage>,
    );

    await service.createBackfill(
      {
        startDate: "2026-07-01",
        endDate: "2026-07-03",
        reprocessExisting: true,
      },
      "2026-07-09T22:00:00.000Z",
    );

    expect(runs.createBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ datesTotal: 3 }),
    );
    expect(runs.createRun).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tradingDate: "2026-07-01",
        tickers: [usTicker],
      }),
    );
    expect(runs.createRun).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        tradingDate: "2026-07-02",
        tickers: [usTicker, canadianTicker],
      }),
    );
    expect(runs.createRun).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        tradingDate: "2026-07-03",
        tickers: [canadianTicker],
      }),
    );
  });

  it("respects the 2,500-message daily soft ceiling", async () => {
    const runs = repository();
    runs.countDispatchedSince.mockResolvedValue(2_499);
    runs.dispatchPending.mockResolvedValue(1);
    const service = new JobsService(
      runs,
      { listActive: vi.fn(async () => []) },
      {} as Queue<ScreeningJobMessage>,
    );
    expect(await service.dispatch("2026-07-09T22:00:00.000Z")).toBe(1);
    expect(runs.dispatchPending).toHaveBeenCalledWith(
      expect.anything(),
      1,
      "2026-07-09T22:00:00.000Z",
    );
  });

  it("pauses active backfills when the queue reports a quota error", async () => {
    const runs = repository();
    runs.dispatchPending.mockRejectedValue(new Error("queue quota exceeded"));
    const service = new JobsService(
      runs,
      { listActive: vi.fn(async () => []) },
      {} as Queue<ScreeningJobMessage>,
    );
    expect(await service.dispatch("2026-07-09T22:00:00.000Z")).toBe(0);
    expect(runs.pauseRunningBackfills).toHaveBeenCalledWith(
      "2026-07-09T22:00:00.000Z",
    );
  });
});
