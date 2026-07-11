import { describe, expect, it } from "vitest";
import {
  addDays,
  endOfWeekSaturday,
  monthGridDays,
  monthRange,
  rangeForView,
  shiftMonth,
  startOfWeekSunday,
  todayInToronto,
  weekGridDays,
  weekRange,
} from "./dateMath";

describe("calendar date math", () => {
  it("uses Sunday-start weeks and includes outside month days", () => {
    expect(startOfWeekSunday("2026-03-01")).toBe("2026-03-01");
    expect(endOfWeekSaturday("2026-03-01")).toBe("2026-03-07");
    expect(monthRange("2026-03-15")).toEqual({
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    const days = monthGridDays("2026-03-15", "2026-03-15");
    expect(days[0]).toMatchObject({ date: "2026-03-01", outsideMonth: false });
    expect(days.at(-1)).toMatchObject({
      date: "2026-04-04",
      outsideMonth: true,
    });
    expect(days.find((day) => day.isToday)?.date).toBe("2026-03-15");
  });

  it("handles leap years and week crossings without local timezone drift", () => {
    expect(monthRange("2024-02-20").endDate).toBe("2024-02-29");
    expect(weekRange("2025-12-31")).toEqual({
      startDate: "2025-12-28",
      endDate: "2026-01-03",
    });
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
    expect(shiftMonth("2026-03-31", -1)).toBe("2026-02-28");
    expect(shiftMonth("2024-03-31", -1)).toBe("2024-02-29");
    expect(shiftMonth("2026-01-15", 1)).toBe("2026-02-15");
    expect(weekGridDays("2025-12-31", "2025-12-31")).toHaveLength(7);
    expect(rangeForView("2026-03-31", "month")).toEqual({
      startDate: "2026-03-01",
      endDate: "2026-03-31",
    });
    expect(rangeForView("2025-12-31", "week")).toEqual({
      startDate: "2025-12-28",
      endDate: "2026-01-03",
    });
  });

  it("derives Toronto calendar dates across DST transitions", () => {
    expect(todayInToronto(new Date("2026-03-08T04:30:00.000Z"))).toBe(
      "2026-03-07",
    );
    expect(todayInToronto(new Date("2026-03-08T05:30:00.000Z"))).toBe(
      "2026-03-08",
    );
    expect(todayInToronto(new Date("2026-11-01T05:30:00.000Z"))).toBe(
      "2026-11-01",
    );
  });
});
