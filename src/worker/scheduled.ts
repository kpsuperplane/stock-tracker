import { RunRepository } from "../db/runs";
import { TickerRepository } from "../db/tickers";
import { JobsService } from "../services/jobs";
import type { Env } from "./env";
import { logEvent } from "./log";

export const handleScheduled = async (
  controller: ScheduledController,
  env: Env,
) => {
  const now = new Date(controller.scheduledTime).toISOString();
  const jobs = new JobsService(
    new RunRepository(env.DB),
    new TickerRepository(env.DB),
    env.SCREENING_QUEUE,
  );
  const runId = await jobs.startScheduled(now.slice(0, 10), now);
  const dispatched = await jobs.dispatch(now);
  logEvent("scheduled_dispatch", {
    runId,
    tradingDate: now.slice(0, 10),
    dispatched,
  });
};
