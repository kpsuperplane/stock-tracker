import type { CreateRunInput, RunRepository } from "../db/runs";
import type { TickerRecord, TickerRepository } from "../db/tickers";
import type { ScreeningJobMessage } from "../shared/contracts";
import { ApiError } from "../worker/errors";

const dayMs = 86_400_000;

export const weekdaysInRange = (start: string, end: string) => {
  const dates: string[] = [];
  for (
    let time = Date.parse(`${start}T12:00:00Z`);
    time <= Date.parse(`${end}T12:00:00Z`);
    time += dayMs
  ) {
    const date = new Date(time);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6) {
      dates.push(date.toISOString().slice(0, 10));
    }
  }
  return dates;
};

interface RunStore {
  createBackfill(input: {
    startDate: string;
    endDate: string;
    reprocessExisting: boolean;
    now: string;
    datesTotal: number;
  }): Promise<string>;
  hasPublishedDate(date: string): Promise<boolean>;
  createRun(input: CreateRunInput): Promise<{ runId: string }>;
  findScheduledRun(date: string): Promise<string | null>;
  reconcileStaleLeases(cutoff: string): Promise<number>;
  countDispatchedSince(dayStart: string): Promise<number>;
  dispatchPending(
    queue: Queue<ScreeningJobMessage>,
    limit: number,
    now: string,
  ): Promise<number>;
  finalizeRun(runId: string, now: string): Promise<string>;
  pauseRunningBackfills(now: string): Promise<void>;
}

interface TickerStore {
  listActive(): Promise<TickerRecord[]>;
}

export class JobsService {
  constructor(
    private readonly runs: RunStore,
    private readonly tickers: TickerStore,
    private readonly queue: Queue<ScreeningJobMessage>,
  ) {}

  async startScheduled(tradingDate: string, now: string): Promise<string> {
    const existing = await this.runs.findScheduledRun(tradingDate);
    if (existing) return existing;
    const snapshot = await this.tickers.listActive();
    const runId = (
      await this.runs.createRun({
        tradingDate,
        origin: "scheduled",
        backfillJobId: null,
        tickers: snapshot,
        now,
      })
    ).runId;
    if (snapshot.length === 0) await this.runs.finalizeRun(runId, now);
    return runId;
  }

  async createBackfill(
    input: {
      startDate: string;
      endDate: string;
      reprocessExisting: boolean;
    },
    now: string,
  ): Promise<string> {
    const start = Date.parse(`${input.startDate}T00:00:00Z`);
    const end = Date.parse(`${input.endDate}T00:00:00Z`);
    const today = Date.parse(`${now.slice(0, 10)}T00:00:00Z`);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start > end ||
      end > today
    ) {
      throw new ApiError(
        422,
        "backfill_dates",
        "Choose a valid past date range.",
      );
    }
    if ((end - start) / dayMs + 1 > 30) {
      throw new ApiError(
        422,
        "backfill_range",
        "Backfills are limited to 30 calendar days.",
      );
    }
    const dates: string[] = [];
    for (const date of weekdaysInRange(input.startDate, input.endDate)) {
      if (
        input.reprocessExisting ||
        !(await this.runs.hasPublishedDate(date))
      ) {
        dates.push(date);
      }
    }
    const snapshot = await this.tickers.listActive();
    const backfillId = await this.runs.createBackfill({
      ...input,
      now,
      datesTotal: dates.length,
    });
    for (const tradingDate of dates) {
      const runId = (
        await this.runs.createRun({
          tradingDate,
          origin: "backfill",
          backfillJobId: backfillId,
          tickers: snapshot,
          now,
        })
      ).runId;
      if (snapshot.length === 0) await this.runs.finalizeRun(runId, now);
    }
    return backfillId;
  }

  async dispatch(now: string): Promise<number> {
    const cutoff = new Date(Date.parse(now) - 20 * 60_000).toISOString();
    await this.runs.reconcileStaleLeases(cutoff);
    const dayStart = `${now.slice(0, 10)}T00:00:00.000Z`;
    const remaining = Math.max(
      0,
      2_500 - (await this.runs.countDispatchedSince(dayStart)),
    );
    if (remaining === 0) return 0;
    try {
      return await this.runs.dispatchPending(this.queue, remaining, now);
    } catch (error) {
      if (/quota|limit|exceeded|\b429\b/i.test(String(error))) {
        await this.runs.pauseRunningBackfills(now);
        return 0;
      }
      throw error;
    }
  }
}

export const createJobsService = (
  runs: RunRepository,
  tickers: TickerRepository,
  queue: Queue<ScreeningJobMessage>,
) => new JobsService(runs, tickers, queue);
