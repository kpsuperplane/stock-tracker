import type { QueueMessage } from "../shared/contracts";
import { createApp } from "./app";
import type { Env } from "./env";
import { handleQueue } from "./queue";
import { handleScheduled } from "./scheduled";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(controller, env): Promise<void> {
    await handleScheduled(controller, env);
  },
  async queue(batch, env): Promise<void> {
    await handleQueue(batch, env);
  },
} satisfies ExportedHandler<Env, QueueMessage>;
