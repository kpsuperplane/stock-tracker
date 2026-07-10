// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackfillPage } from "./BackfillPage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BackfillPage", () => {
  it("prevents the current Eastern market date from being submitted", () => {
    vi.useFakeTimers({ now: new Date("2026-07-10T00:30:00.000Z") });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("request should not be sent"));
    render(<BackfillPage />);

    fireEvent.change(screen.getByLabelText("Start date"), {
      target: { value: "2026-07-09" },
    });
    fireEvent.change(screen.getByLabelText("End date"), {
      target: { value: "2026-07-09" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start backfill" }));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText("End date").getAttribute("max")).toBe(
      "2026-07-08",
    );
  });
});
