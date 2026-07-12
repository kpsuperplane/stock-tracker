const easternDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const easternMarketDate = (timestamp: string | Date) => {
  const instant = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const parts = easternDateFormatter.formatToParts(instant);
  const value = (type: "year" | "month" | "day") =>
    parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
};

/** Return the Toronto market close instant for an ISO calendar date. */
export const easternCloseUtc = (date: string): string => {
  const noonUtc = new Date(`${date}T12:00:00Z`);
  const zoneName =
    new Intl.DateTimeFormat("en", {
      timeZone: "America/Toronto",
      timeZoneName: "shortOffset",
    })
      .formatToParts(noonUtc)
      .find((part) => part.type === "timeZoneName")?.value ?? "GMT-4";
  const match = zoneName.match(/GMT([+-])(\d{1,2})/);
  const offsetHours = match
    ? (match[1] === "+" ? 1 : -1) * Number(match[2])
    : -4;
  return new Date(
    Date.UTC(
      noonUtc.getUTCFullYear(),
      noonUtc.getUTCMonth(),
      noonUtc.getUTCDate(),
      16 - offsetHours,
    ),
  ).toISOString();
};

export const previousCalendarDate = (date: string) =>
  new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
