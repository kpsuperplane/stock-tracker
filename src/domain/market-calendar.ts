const dateAtNoonUtc = (date: string): Date => new Date(`${date}T12:00:00.000Z`);

const formatDate = (value: Date): string => value.toISOString().slice(0, 10);

const addDays = (date: string, days: number): string =>
  formatDate(new Date(dateAtNoonUtc(date).getTime() + days * 86_400_000));

const nthWeekday = (
  year: number,
  month: number,
  weekday: number,
  occurrence: number,
): string => {
  const first = new Date(Date.UTC(year, month - 1, 1, 12));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return formatDate(
    new Date(first.getTime() + (offset + (occurrence - 1) * 7) * 86_400_000),
  );
};

const lastWeekday = (year: number, month: number, weekday: number): string => {
  const last = new Date(Date.UTC(year, month, 0, 12));
  const offset = (last.getUTCDay() - weekday + 7) % 7;
  return formatDate(new Date(last.getTime() - offset * 86_400_000));
};

const observedFixedHoliday = (date: string): string[] => {
  const day = dateAtNoonUtc(date).getUTCDay();
  if (day === 6) return [addDays(date, -1)];
  if (day === 0) return [addDays(date, 1)];
  return [date];
};

const canadianObservedFixedHoliday = (date: string): string[] => {
  const day = dateAtNoonUtc(date).getUTCDay();
  if (day === 6) return [addDays(date, 2)];
  if (day === 0) return [addDays(date, 1)];
  return [date];
};

const canadianChristmasClosures = (year: number): string[] => {
  const holidays = [`${year}-12-25`, `${year}-12-26`];
  const closures: string[] = [];
  for (const holiday of holidays) {
    let candidate = holiday;
    const day = dateAtNoonUtc(holiday).getUTCDay();
    if (day === 6) candidate = addDays(holiday, 2);
    if (day === 0) candidate = addDays(holiday, 1);
    while (closures.includes(candidate)) candidate = addDays(candidate, 1);
    closures.push(candidate);
  }
  return closures;
};

const goodFriday = (year: number): string => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (a * 19 + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + e * 2 + i * 2 - h - k) % 7;
  const m = Math.floor((a + h * 11 + l * 22) / 451);
  const easterMonth = Math.floor((h + l - m * 7 + 114) / 31);
  const easterDay = ((h + l - m * 7 + 114) % 31) + 1;
  return formatDate(
    new Date(Date.UTC(year, easterMonth - 1, easterDay - 2, 12)),
  );
};

const victoriaDay = (year: number): string => {
  const fourthMonday = nthWeekday(year, 5, 1, 4);
  return fourthMonday > `${year}-05-24`
    ? nthWeekday(year, 5, 1, 3)
    : fourthMonday;
};

export const isUsMarketHoliday = (date: string): boolean => {
  const year = dateAtNoonUtc(date).getUTCFullYear();
  return new Set([
    ...observedFixedHoliday(`${year}-01-01`),
    ...observedFixedHoliday(`${year}-07-04`),
    ...observedFixedHoliday(`${year}-06-19`),
    ...observedFixedHoliday(`${year}-12-25`),
    goodFriday(year),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    lastWeekday(year, 5, 1),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
  ]).has(date);
};

export const isCanadianMarketHoliday = (date: string): boolean => {
  const year = dateAtNoonUtc(date).getUTCFullYear();
  return new Set([
    ...canadianObservedFixedHoliday(`${year}-01-01`),
    ...canadianObservedFixedHoliday(`${year}-07-01`),
    ...canadianChristmasClosures(year),
    goodFriday(year),
    nthWeekday(year, 2, 1, 3),
    victoriaDay(year),
    nthWeekday(year, 8, 1, 1),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 10, 1, 2),
  ]).has(date);
};

export const isTorontoMarketHoliday = (date: string): boolean =>
  isUsMarketHoliday(date) || isCanadianMarketHoliday(date);

const isCanadianExchange = (exchange: string): boolean =>
  /(?:TSX|TOR|VENTURE|TSXV|CDNX|CVE|NEO|CSE)/i.test(exchange);

export const isMarketHolidayForExchange = (
  date: string,
  exchange: string,
): boolean =>
  isCanadianExchange(exchange)
    ? isCanadianMarketHoliday(date)
    : isUsMarketHoliday(date);

export const isMarketTradingDayForExchange = (
  date: string,
  exchange: string,
): boolean => {
  const weekday = dateAtNoonUtc(date).getUTCDay();
  return (
    weekday !== 0 &&
    weekday !== 6 &&
    !isMarketHolidayForExchange(date, exchange)
  );
};
