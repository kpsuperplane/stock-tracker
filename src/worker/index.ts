import { D1UsageMeter } from "../services/d1-usage";
import type { QueueMessage } from "../shared/contracts";
import { createApp } from "./app";
import type { Env } from "./env";
import { handleQueue } from "./queue";
import { handleScheduled } from "./scheduled";

const app = createApp();

export default {
  async fetch(request, env, executionCtx): Promise<Response> {
    const meter = new D1UsageMeter(env.DB);
    return app.fetch(request, { ...env, DB: meter.db }, executionCtx);
  },
  async scheduled(controller, env): Promise<void> {
    await handleScheduled(controller, env);
  },
  async queue(batch, env): Promise<void> {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env, QueueMessage>;
