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

const dateParts = (date: string) => {
  const value = dateAtNoonUtc(date);
  return {
    year: value.getUTCFullYear(),
    month: value.getUTCMonth() + 1,
    day: value.getUTCDate(),
  };
};

const shortYear = (year: number): string => String(year).slice(-2);

const shortMonthName = (date: string, locale: "en" | "cn") =>
  new Intl.DateTimeFormat(locale === "cn" ? "zh-CN" : "en-US", {
    month: "short",
    timeZone: "UTC",
  }).format(dateAtNoonUtc(date));

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

export const monthLabel = (date: string, locale: "en" | "cn"): string => {
  const parts = dateParts(date);
  return locale === "cn"
    ? `${shortYear(parts.year)}年${parts.month}月`
    : `${shortMonthName(date, locale)} ${shortYear(parts.year)}`;
};

export const weekLabel = (
  startDate: string,
  endDate: string,
  locale: "en" | "cn",
): string => {
  const start = dateParts(startDate);
  const end = dateParts(endDate);

  if (locale === "cn") {
    if (start.year === end.year && start.month === end.month) {
      return `${shortYear(start.year)}年${start.month}月${start.day}–${end.day}日`;
    }
    if (start.year === end.year) {
      return `${shortYear(start.year)}年${start.month}月${start.day}日–${end.month}月${end.day}日`;
    }
    return `${shortYear(start.year)}年${start.month}月${start.day}日–${shortYear(end.year)}年${end.month}月${end.day}日`;
  }

  const startMonth = shortMonthName(startDate, locale);
  const endMonth = shortMonthName(endDate, locale);
  if (start.year === end.year && start.month === end.month) {
    return `${startMonth} ${start.day}–${end.day}, ${shortYear(end.year)}`;
  }
  if (start.year === end.year) {
    return `${startMonth} ${start.day}–${endMonth} ${end.day}, ${shortYear(end.year)}`;
  }
  return `${startMonth} ${start.day}, ${shortYear(start.year)}–${endMonth} ${end.day}, ${shortYear(end.year)}`;
};

export const shortDayLabel = (date: string, locale: "en" | "cn"): string =>
  new Intl.DateTimeFormat(locale === "cn" ? "zh-CN" : "en-US", {
    weekday: "short",
    timeZone: "UTC",
  }).format(dateAtNoonUtc(date));
