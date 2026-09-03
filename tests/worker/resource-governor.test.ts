import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type ResourceEnvelope,
  ResourceGovernor,
} from "../../src/services/resource-governor";

const now = new Date("2026-07-10T12:00:00.000Z");
const envelope: ResourceEnvelope = {
  lane: "availability",
  operationType: "concurrency_test",
  items: [{ resourceType: "d1_rows_read", units: 600_000 }],
};

describe("resource governor", () => {
  it("atomically prevents concurrent dispatchers from exceeding a lane", async () => {
    const governor = new ResourceGovernor(env.DB, () => now);
    const results = await Promise.all([
      governor.reserve("concurrent-a", envelope),
      governor.reserve("concurrent-b", envelope),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await env.DB.prepare(
        `SELECT reserved_units AS reserved FROM resource_budget_days
          WHERE usage_date = '2026-07-10' AND lane = 'availability'
            AND resource_type = 'd1_rows_read' AND resource_key = ''`,
      ).first<{ reserved: number }>(),
    ).toEqual({ reserved: 600_000 });
  });

  it("makes duplicate reservations idempotent and restores released capacity", async () => {
    const governor = new ResourceGovernor(env.DB, () => now);
    const first = await governor.reserve("same-operation", envelope);
    const duplicate = await governor.reserve("same-operation", envelope);
    expect(first).not.toBeNull();
    expect(duplicate).not.toBeNull();
    expect(first?.id).toBe(duplicate?.id);
    expect(await governor.find("same-operation")).toMatchObject({
      id: first?.id,
      state: "reserved",
    });

    expect(await governor.release(first?.id ?? "")).toBe(true);
    const releasedBudget = await env.DB.prepare(
      `SELECT reserved_units AS reserved FROM resource_budget_days
        WHERE usage_date = '2026-07-10' AND lane = 'availability'
          AND resource_type = 'd1_rows_read' AND resource_key = ''`,
    ).first<{ reserved: number }>();
    expect(releasedBudget?.reserved).toBe(0);

    const retried = await governor.reserve("same-operation", envelope);
    expect(retried?.id).toBe(first?.id);
    expect(retried?.state).toBe("reserved");
  });

  it("raises future envelopes to the observed seven-day p99 plus headroom", async () => {
    const governor = new ResourceGovernor(env.DB, () => now);
    const small: ResourceEnvelope = {
      lane: "availability",
      operationType: "adaptive_test",
      items: [{ resourceType: "d1_rows_read", units: 100_000 }],
    };
    const first = await governor.reserve("adaptive-first", small);
    if (!first) throw new Error("initial reservation failed");
    await governor.consume(first.id, [
      { resourceType: "d1_rows_read", units: 700_000 },
    ]);

    const next = await governor.reserve("adaptive-next", small);
    if (!next) throw new Error("adaptive reservation failed");
    expect(
      await env.DB.prepare(
        `SELECT reserved_units AS units
           FROM resource_reservation_items WHERE reservation_id = ?1`,
      )
        .bind(next.id)
        .first(),
    ).toEqual({ units: 875_000 });
  });
});
