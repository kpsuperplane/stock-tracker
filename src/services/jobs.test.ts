import { describe, expect, it, vi } from "vitest";
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
      {} as Queue<{ screeningId: string }>,
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
      {} as Queue<{ screeningId: string }>,
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

  it("skips published dates and snapshots the same active ticker set", async () => {
    const runs = repository();
    runs.hasPublishedDate.mockImplementation(async (date) => date === "2026-07-07");
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
      {} as Queue<{ screeningId: string }>,
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

  it("respects the 2,500-message daily soft ceiling", async () => {
    const runs = repository();
    runs.countDispatchedSince.mockResolvedValue(2_499);
    runs.dispatchPending.mockResolvedValue(1);
    const service = new JobsService(
      runs,
      { listActive: vi.fn(async () => []) },
      {} as Queue<{ screeningId: string }>,
    );
    expect(await service.dispatch("2026-07-09T22:00:00.000Z")).toBe(1);
    expect(runs.dispatchPending).toHaveBeenCalledWith(
      expect.anything(),
      1,
      "2026-07-09T22:00:00.000Z",
    );
  });
});
