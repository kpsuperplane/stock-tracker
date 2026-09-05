import { D1UsageMeter } from "../services/d1-usage";
import { ReadModelRefreshOutbox } from "../services/read-model-refresh";
import type { ReadModelRefreshMessage } from "../shared/contracts";
import { createApp } from "./app";
import type { Env } from "./env";

const refreshApp = createApp();

export const consumeReadModelRefresh = async (
  env: Env,
  message: ReadModelRefreshMessage,
): Promise<"processed" | "stale"> => {
  const outbox = new ReadModelRefreshOutbox(
    env.DB,
    env.SYNC_FOREGROUND_QUEUE as Queue<ReadModelRefreshMessage>,
  );
  const row = await outbox.claim(message);
  if (!row) return "stale";
  try {
    const targets = await outbox.targets(row.family);
    for (const target of targets) {
      const meter = new D1UsageMeter(env.DB);
      const headers = new Headers({
        "X-Read-Model-Refresh-Key": target.cacheKey,
      });
      const response = await refreshApp.fetch(
        new Request(`https://read-model.internal${target.requestUrl}`, {
          method: "GET",
          headers,
        }),
        { ...env, DB: meter.db },
      );
      if (!response.ok)
        throw new Error(`read_model_refresh_http_${response.status}`);
    }
    if (!(await outbox.complete(row))) {
      await outbox.recover(1);
    }
    return "processed";
  } catch (error) {
    await outbox.retry(
      row,
      /daily_budget/i.test(String(error))
        ? "daily_budget"
        : "storage_unavailable",
    );
    throw error;
  }
};
