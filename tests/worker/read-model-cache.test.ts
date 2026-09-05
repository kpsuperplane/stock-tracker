import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { D1UsageMeter } from "../../src/services/d1-usage";
import {
  cacheableReadModelFamily,
  ReadModelSnapshotStore,
} from "../../src/services/read-model-cache";
import { createApp } from "../../src/worker/app";
import type { Env } from "../../src/worker/env";

describe("read-model availability cache", () => {
  it("isolates account scopes and normalizes equivalent query parameters", async () => {
    const store = new ReadModelSnapshotStore(env.DB, env.READ_MODEL_CACHE);
    const first = new Request(
      "https://example.test/api/portfolio?locale=en&scopeType=account&scopeId=a",
      { headers: { "Cf-Access-Authenticated-User-Email": "one@example.test" } },
    );
    const reordered = new Request(
      "https://example.test/api/portfolio?scopeId=a&scopeType=account&locale=en",
      { headers: { "Cf-Access-Authenticated-User-Email": "one@example.test" } },
    );
    const otherUser = new Request(reordered, {
      headers: { "Cf-Access-Authenticated-User-Email": "two@example.test" },
    });

    expect(await store.keyFor(first)).toBe(await store.keyFor(reordered));
    expect(await store.keyFor(first)).not.toBe(await store.keyFor(otherUser));
  });

  it("writes unchanged content to KV once and exposes stale freshness", async () => {
    let current = new Date("2026-07-10T12:00:00.000Z");
    const values = new Map<string, string>();
    const kv = {
      get: vi.fn(async (key: string) => {
        const value = values.get(key);
        return value ? JSON.parse(value) : null;
      }),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    } as unknown as KVNamespace;
    const store = new ReadModelSnapshotStore(env.DB, kv, () => current);
    const request = new Request("https://example.test/api/status?limit=10");
    const cacheKey = await store.keyFor(request);
    const response = Response.json(
      { status: { jobs: [] } },
      { headers: { ETag: '"status-r1"' } },
    );
    const first = await store.publish({
      cacheKey,
      family: "status",
      requestUrl: "/api/status?limit=10",
      response,
    });
    current = new Date("2026-07-10T12:00:30.000Z");
    await store.publish({
      cacheKey,
      family: "status",
      requestUrl: "/api/status?limit=10",
      response,
      previous: first,
    });
    expect(kv.put).toHaveBeenCalledTimes(1);
    if (!first) throw new Error("snapshot was not published");

    current = new Date("2026-07-10T12:02:00.000Z");
    const stale = store.toResponse(first, {
      stale: true,
      reason: "storage_unavailable",
    });
    expect(stale.headers.get("X-Data-Stale")).toBe("true");
    expect(await stale.json()).toMatchObject({
      status: { jobs: [] },
      freshness: {
        state: "stale",
        asOf: "2026-07-10T12:00:00.000Z",
        sourceRevision: '"status-r1"',
        reason: "storage_unavailable",
      },
    });
  });

  it("keeps idle status snapshots stable and active status responsive", async () => {
    const current = new Date("2026-07-10T12:00:00.000Z");
    const values = new Map<string, string>();
    const kv = {
      get: vi.fn(async () => null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, value);
      }),
    } as unknown as KVNamespace;
    const store = new ReadModelSnapshotStore(env.DB, kv, () => current);
    const idle = await store.publish({
      cacheKey: "idle-status",
      family: "status",
      requestUrl: "/api/status",
      response: Response.json({
        reconciliation: { stockValues: { status: "waiting" } },
      }),
    });
    const active = await store.publish({
      cacheKey: "active-status",
      family: "status",
      requestUrl: "/api/status",
      response: Response.json({
        reconciliation: { stockValues: { status: "syncing" } },
      }),
    });

    expect(idle?.validUntil).toBe("2026-07-10T12:05:00.000Z");
    expect(active?.validUntil).toBe("2026-07-10T12:00:30.000Z");
  });

  it("never treats a custom history query as a canonical snapshot", () => {
    expect(
      cacheableReadModelFamily(
        new Request(
          "https://example.test/api/portfolio/history?range=custom&startDate=2020-01-01&endDate=2020-02-01",
        ),
      ),
    ).toBeNull();
    expect(
      cacheableReadModelFamily(
        new Request(
          "https://example.test/api/portfolio/history?range=1y&locale=en",
        ),
      ),
    ).toBe("portfolio_history");
  });

  it("serves a fresh canonical route snapshot without rereading D1", async () => {
    const testEnv = {
      ...env,
      READ_MODEL_CACHE_ENABLED: "true",
      READ_MODEL_PUBLISH_ENABLED: "false",
    } as unknown as Env;
    const request = () =>
      new Request("https://example.test/api/accounts", {
        headers: {
          "Cf-Access-Authenticated-User-Email": "cache-route@example.test",
        },
      });
    const app = createApp();
    const first = await app.fetch(request(), testEnv, {} as ExecutionContext);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Read-Model-Cache")).toBe("hit");
    expect(await first.json()).toMatchObject({
      categories: [{ accounts: [{ name: "Default Account" }] }],
      freshness: { state: "fresh" },
    });

    await env.DB.prepare(
      `UPDATE accounts SET name = 'Changed after snapshot'
        WHERE id = 'account-default'`,
    ).run();
    const second = await app.fetch(request(), testEnv, {} as ExecutionContext);
    expect(second.headers.get("X-Read-Model-Cache")).toBe("hit");
    expect(await second.json()).toMatchObject({
      categories: [{ accounts: [{ name: "Default Account" }] }],
      freshness: { state: "fresh" },
    });
  });

  it("settles a cache fill to D1 metadata instead of its full estimate", async () => {
    const meter = new D1UsageMeter(env.DB);
    const testEnv = {
      ...env,
      DB: meter.db,
      READ_MODEL_CACHE_ENABLED: "true",
      READ_MODEL_PUBLISH_ENABLED: "false",
    } as unknown as Env;
    const response = await createApp().fetch(
      new Request("https://example.test/api/accounts", {
        headers: {
          "Cf-Access-Authenticated-User-Email":
            "measured-cache-fill@example.test",
        },
      }),
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    const budget = await env.DB.prepare(
      `SELECT reserved_units AS reserved, actual_units AS actual
         FROM resource_budget_days
        WHERE lane = 'availability' AND resource_type = 'd1_rows_read'
          AND resource_key = ''`,
    ).first<{ reserved: number; actual: number }>();
    expect(budget?.actual).toBeGreaterThan(0);
    expect(budget?.reserved).toBe(budget?.actual);
    expect(budget?.reserved).toBeLessThan(100_000);
  });

  it("serves an explicit stale snapshot while D1 is unavailable", async () => {
    const snapshotTime = new Date("2026-07-10T12:00:00.000Z");
    const request = new Request("https://example.test/api/accounts", {
      headers: {
        "Cf-Access-Authenticated-User-Email": "outage@example.test",
      },
    });
    const store = new ReadModelSnapshotStore(
      env.DB,
      env.READ_MODEL_CACHE,
      () => snapshotTime,
    );
    const cacheKey = await store.keyFor(request);
    await store.publish({
      cacheKey,
      family: "accounts",
      requestUrl: "/api/accounts",
      response: Response.json({ categories: [{ name: "Cached accounts" }] }),
    });
    const unavailableDb = new Proxy(env.DB, {
      get() {
        throw new Error("database temporarily unavailable");
      },
    });
    const testEnv = {
      ...env,
      DB: unavailableDb,
      READ_MODEL_CACHE_ENABLED: "true",
      READ_MODEL_PUBLISH_ENABLED: "false",
    } as unknown as Env;
    const waitUntil = vi.fn((promise: Promise<unknown>) => {
      void promise.catch(() => undefined);
    });

    const response = await createApp().fetch(request, testEnv, {
      waitUntil,
    } as unknown as ExecutionContext);
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Data-Stale")).toBe("true");
    expect(await response.json()).toMatchObject({
      categories: [{ name: "Cached accounts" }],
      freshness: {
        state: "stale",
        asOf: "2026-07-10T12:00:00.000Z",
        reason: "refresh_delayed",
      },
    });
    expect(waitUntil).toHaveBeenCalledOnce();
  });

  it("returns snapshot_unavailable for an uncached custom query", async () => {
    const unavailableDb = new Proxy(env.DB, {
      get() {
        throw new Error("database temporarily unavailable");
      },
    });
    const testEnv = {
      ...env,
      DB: unavailableDb,
      READ_MODEL_CACHE_ENABLED: "true",
    } as unknown as Env;
    const response = await createApp().fetch(
      new Request(
        "https://example.test/api/portfolio/history?range=custom&startDate=2020-01-01&endDate=2020-02-01",
      ),
      testEnv,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "snapshot_unavailable",
        message: "This custom view is not cached while storage is unavailable.",
      },
    });
  });
});
