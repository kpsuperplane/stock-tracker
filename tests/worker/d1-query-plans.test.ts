import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

interface QueryPlanRow {
  detail: string;
}

const queryPlan = async (
  sql: string,
  ...bindings: Array<string | number>
): Promise<string> => {
  const rows = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .bind(...bindings)
    .all<QueryPlanRow>();
  return rows.results.map((row) => row.detail).join("\n");
};

describe("D1 hot-path query plans", () => {
  it("uses bounded indexes for settlement, lease recovery, and retention", async () => {
    const unsettled = await queryPlan(
      `SELECT * FROM dispatch_batches
        WHERE state IN ('complete', 'terminal') AND settled_at IS NULL
        ORDER BY completed_at, id
        LIMIT ?1`,
      25,
    );
    expect(unsettled).toContain("dispatch_batches_unsettled_idx");
    expect(unsettled).not.toContain("SCAN dispatch_batches");

    const orphanedDispatch = await queryPlan(
      `SELECT work.id, work.dispatch_lease_until
         FROM work_items work
        WHERE work.scope = 'global_fact'
          AND work.state = 'dispatching'
          AND work.dispatch_lease_until IS NOT NULL
          AND work.dispatch_lease_until <= ?1
          AND NOT EXISTS (
            SELECT 1 FROM dispatch_batch_items item
             WHERE item.work_item_id = work.id
          )
        ORDER BY work.dispatch_lease_until, work.id
        LIMIT ?2`,
      "2026-07-10T21:00:00.000Z",
      100,
    );
    expect(orphanedDispatch).toContain("work_items_expired_dispatch_idx");
    expect(orphanedDispatch).not.toContain("SCAN work");

    const completedRetention = await queryPlan(
      `SELECT work.rowid FROM work_items work
        WHERE work.state = 'complete' AND work.completed_at <= ?1
          AND NOT EXISTS (
            SELECT 1 FROM job_work_items link
             WHERE link.work_item_id = work.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM dispatch_batch_items item
             WHERE item.work_item_id = work.id
          )
        ORDER BY work.completed_at, work.id
        LIMIT ?2`,
      "2026-04-01T00:00:00.000Z",
      100,
    );
    expect(completedRetention).toContain("work_items_state_completed_idx");
    expect(completedRetention).not.toContain("SCAN work");

    const reservationRecovery = await queryPlan(
      `SELECT reservation.rowid
         FROM dispatch_provider_reservations reservation
        WHERE reservation.expires_at <= ?1
          AND NOT EXISTS (
            SELECT 1 FROM dispatch_batches batch
             WHERE batch.id = reservation.dispatch_batch_id
          )
        ORDER BY reservation.expires_at, reservation.dispatch_batch_id
        LIMIT ?2`,
      "2026-07-10T21:00:00.000Z",
      100,
    );
    expect(reservationRecovery).toContain(
      "dispatch_provider_reservations_expiry_idx",
    );
    expect(reservationRecovery).not.toContain("SCAN reservation");

    const processingRecovery = await queryPlan(
      `SELECT id, processing_lease_until
         FROM dispatch_batches
        WHERE state = 'processing' AND processing_lease_until IS NOT NULL
          AND processing_lease_until <= ?1
        ORDER BY processing_lease_until, id
        LIMIT ?2`,
      "2026-07-10T21:00:00.000Z",
      100,
    );
    expect(processingRecovery).toContain(
      "dispatch_batches_processing_lease_idx",
    );
    expect(processingRecovery).not.toContain("SCAN dispatch_batches");

    const batchRetention = await queryPlan(
      `SELECT rowid FROM dispatch_batches
        WHERE state = 'complete' AND completed_at <= ?1
        ORDER BY completed_at, id
        LIMIT ?2`,
      "2026-04-01T00:00:00.000Z",
      100,
    );
    expect(batchRetention).toContain("dispatch_batches_state_completed_idx");
    expect(batchRetention).not.toContain("SCAN dispatch_batches");

    const dividendKeyset = await queryPlan(
      `SELECT DISTINCT event.instrument_id, event.ex_date
         FROM json_each(?1) interval
         JOIN dividend_events event
           ON event.instrument_id =
                json_extract(interval.value, '$.instrumentId')
          AND event.ex_date >= json_extract(interval.value, '$.startDate')
          AND event.ex_date <= json_extract(interval.value, '$.endDate')
        WHERE event.status = 'active'
          AND (
            ?2 IS NULL
            OR event.instrument_id > ?2
            OR (event.instrument_id = ?2 AND event.ex_date > ?3)
          )
        ORDER BY event.instrument_id, event.ex_date
        LIMIT ?4`,
      JSON.stringify([
        {
          instrumentId: "instrument-1",
          startDate: "2026-01-01",
          endDate: "2026-07-10",
        },
      ]),
      "instrument-1",
      "2026-02-01",
      101,
    );
    expect(dividendKeyset).toContain("dividend_events_instrument_ex_date_idx");
    expect(dividendKeyset).not.toContain("SCAN event");
  });
});
