export type CalendarView = "month" | "week";

export interface CalendarDay {
  date: string;
  outsideMonth: boolean;
  isToday: boolean;
}

const isoPattern = /^\d{4}-\d{2}-\d{2}$/;

const dateAtNoonUtc = (date: string): Date => {
  if (!isoPattern.test(date)) throw new Error("Invalid ISO date");
  const parsed = new Date(`${date}T12:00:00.000Z`);
  if (
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== date
  )
    throw new Error("Invalid ISO date");
  return parsed;
};

export const addDays = (date: string, days: number): string => {
  const value = dateAtNoonUtc(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

/** Move a calendar date by whole months while clamping the day-of-month. */
export const shiftMonth = (date: string, months: number): string => {
  const parsed = dateAtNoonUtc(date);
  const day = parsed.getUTCDate();
  const shifted = new Date(
    Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth() + months + 1, 0, 12),
  );
  const lastDay = shifted.getUTCDate();
  shifted.setUTCDate(Math.min(day, lastDay));
  return shifted.toISOString().slice(0, 10);
};

export const dayOfWeek = (date: string): number =>
  dateAtNoonUtc(date).getUTCDay();

export const startOfWeekSunday = (date: string): string =>
  addDays(date, -dayOfWeek(date));

export const endOfWeekSaturday = (date: string): string =>
  addDays(date, 6 - dayOfWeek(date));

export const monthRange = (
  date: string,
): { startDate: string; endDate: string } => {
  const parsed = dateAtNoonUtc(date);
  const year = parsed.getUTCFullYear();
  const month = parsed.getUTCMonth();
  const startDate = `${year.toString().padStart(4, "0")}-${(month + 1)
    .toString()
    .padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month + 1, 0, 12));
  return {
    startDate,
    endDate: lastDay.toISOString().slice(0, 10),
  };
};

export const weekRange = (
  date: string,
): { startDate: string; endDate: string } => {
  const startDate = startOfWeekSunday(date);
  return { startDate, endDate: addDays(startDate, 6) };
};

export const rangeForView = (
  date: string,
  view: CalendarView,
): { startDate: string; endDate: string } =>
  view === "month" ? monthRange(date) : weekRange(date);

export const monthGridDays = (date: string, today: string): CalendarDay[] => {
  const { startDate: monthStart, endDate: monthEnd } = monthRange(date);
  const startDate = startOfWeekSunday(monthStart);
  const endDate = endOfWeekSaturday(monthEnd);
  const days: CalendarDay[] = [];
  for (let cursor = startDate; cursor <= endDate; cursor = addDays(cursor, 1)) {
    days.push({
      date: cursor,
      outsideMonth: cursor < monthStart || cursor > monthEnd,
      isToday: cursor === today,
    });
  }
  return days;
};

export const weekGridDays = (date: string, today: string): CalendarDay[] => {
  const { startDate } = weekRange(date);
  return Array.from({ length: 7 }, (_, index) => {
    const value = addDays(startDate, index);
    return { date: value, outsideMonth: false, isToday: value === today };
  });
};

export const todayInToronto = (now = new Date()): string => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
};

export const monthLabel = (date: string, locale: "en" | "cn"): string =>
  new Intl.DateTimeFormat(locale === "cn" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(dateAtNoonUtc(date));

export const shortDayLabel = (date: string, locale: "en" | "cn"): string =>
  new Intl.DateTimeFormat(locale === "cn" ? "zh-CN" : "en-US", {
    weekday: "short",
    timeZone: "UTC",
  }).format(dateAtNoonUtc(date));
