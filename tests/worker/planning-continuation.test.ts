import { describe, expect, it } from "vitest";
import { shouldEnqueuePlanningContinuation } from "../../src/worker/planning";

describe("planning queue continuation", () => {
  it("does not self-enqueue while a phase is waiting for materialized work", () => {
    expect(
      shouldEnqueuePlanningContinuation({
        active: true,
        paused: true,
        dispatchedBatches: 0,
      }),
    ).toBe(false);
  });

  it("continues immediately while planning has another actionable page", () => {
    expect(
      shouldEnqueuePlanningContinuation({
        active: true,
        paused: false,
        dispatchedBatches: 0,
      }),
    ).toBe(true);
  });

  it("drains another bounded dispatch page after planning completes", () => {
    expect(
      shouldEnqueuePlanningContinuation({
        active: false,
        paused: false,
        dispatchedBatches: 8,
      }),
    ).toBe(true);
  });
});
