import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ReadModelRefreshOutbox } from "../../src/services/read-model-refresh";
import type { ReadModelRefreshMessage } from "../../src/shared/contracts";

const now = new Date("2026-07-10T12:00:00.000Z");

describe("read-model refresh outbox", () => {
  it("coalesces the same revision while a refresh is already queued", async () => {
    const sent: ReadModelRefreshMessage[] = [];
    let id = 0;
    const outbox = new ReadModelRefreshOutbox(
      env.DB,
      {
        send: vi.fn(async (message: ReadModelRefreshMessage) => {
          sent.push(message);
        }),
      } as unknown as Queue<ReadModelRefreshMessage>,
      () => now,
      () => `refresh-${++id}`,
    );

    expect(await outbox.request("portfolio", "revision-1")).toBe(true);
    expect(await outbox.request("portfolio", "revision-1")).toBe(false);
    expect(sent).toHaveLength(1);
    expect(
      await env.DB.prepare(
        `SELECT state, requested_revision AS revision, attempt_count AS attempts
           FROM read_model_refresh_outbox`,
      ).first(),
    ).toEqual({ state: "queued", revision: "revision-1", attempts: 0 });

    expect(await outbox.request("portfolio", "revision-2")).toBe(true);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.leaseToken).not.toBe(sent[0]?.leaseToken);
  });

  it("leaves a failed send pending for recovery", async () => {
    const outbox = new ReadModelRefreshOutbox(
      env.DB,
      {
        send: vi.fn(async () => {
          throw new Error("queue unavailable");
        }),
      } as unknown as Queue<ReadModelRefreshMessage>,
      () => now,
      () => "refresh-send-failure",
    );

    expect(await outbox.request("status", "revision-1")).toBe(false);
    expect(
      await env.DB.prepare(
        "SELECT state, attempt_count AS attempts FROM read_model_refresh_outbox",
      ).first(),
    ).toEqual({ state: "pending", attempts: 0 });
  });
});
