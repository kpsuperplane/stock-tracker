import { createApp } from "./app";
import type { Env } from "./env";

const app = createApp();

export default {
  fetch: app.fetch,
  async scheduled(): Promise<void> {},
  async queue(): Promise<void> {},
} satisfies ExportedHandler<Env>;
