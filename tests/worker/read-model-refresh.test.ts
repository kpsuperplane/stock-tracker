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

  it("coalesces stale refreshes by exact snapshot key", async () => {
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
      () => `targeted-refresh-${++id}`,
    );

    expect(await outbox.request("calendar", "r1", "calendar-july")).toBe(true);
    expect(await outbox.request("calendar", "r1", "calendar-july")).toBe(false);
    expect(await outbox.request("calendar", "r1", "calendar-august")).toBe(
      true,
    );
    expect(sent).toHaveLength(2);
  });

  it("selects one canonical target per family or one exact stale key", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO read_model_publications
         (cache_key, family, request_url, source_revision, content_hash,
          generated_at, valid_until, updated_at)
         VALUES ('calendar-old', 'calendar', '/api/calendar?month=old', 'r1',
                 'h1', ?1, ?1, ?1)`,
      ).bind("2026-07-10T10:00:00.000Z"),
      env.DB.prepare(
        `INSERT INTO read_model_publications
         (cache_key, family, request_url, source_revision, content_hash,
          generated_at, valid_until, updated_at)
         VALUES ('calendar-new', 'calendar', '/api/calendar?month=new', 'r2',
                 'h2', ?1, ?1, ?1)`,
      ).bind("2026-07-10T11:00:00.000Z"),
      env.DB.prepare(
        `INSERT INTO read_model_publications
         (cache_key, family, request_url, source_revision, content_hash,
          generated_at, valid_until, updated_at)
         VALUES ('portfolio-new', 'portfolio', '/api/portfolio', 'r3', 'h3',
                 ?1, ?1, ?1)`,
      ).bind("2026-07-10T11:30:00.000Z"),
    ]);
    const outbox = new ReadModelRefreshOutbox(
      env.DB,
      { send: vi.fn() } as unknown as Queue<ReadModelRefreshMessage>,
      () => now,
    );

    expect(await outbox.targets("all")).toEqual([
      {
        cacheKey: "portfolio-new",
        family: "portfolio",
        requestUrl: "/api/portfolio",
      },
      {
        cacheKey: "calendar-new",
        family: "calendar",
        requestUrl: "/api/calendar?month=new",
      },
    ]);
    expect(await outbox.targets("calendar", 50, "calendar-old")).toEqual([
      {
        cacheKey: "calendar-old",
        family: "calendar",
        requestUrl: "/api/calendar?month=old",
      },
    ]);
  });
});
