import type { CalendarReadModelDto } from "../shared/contracts";

export type CalendarEventDto = CalendarReadModelDto["events"][number];

export interface CalendarEventCursor {
  date: string;
  kind: string;
  id: string;
}

export const calendarEventDate = (event: CalendarEventDto): string => {
  switch (event.kind) {
    case "mover":
      return event.tradingDate;
    case "dividend":
      return event.exDate;
    case "earnings":
      return event.reportDate;
  }
};

export const paginateCalendarEvents = (input: {
  events: CalendarEventDto[];
  cursor?: CalendarEventCursor | null;
  limit?: number;
}): { events: CalendarEventDto[]; nextCursor: string | null } => {
  const ordered = [...input.events].sort(
    (left, right) =>
      calendarEventDate(left).localeCompare(calendarEventDate(right)) ||
      left.kind.localeCompare(right.kind) ||
      left.id.localeCompare(right.id),
  );
  const cursor = input.cursor;
  const startIndex = cursor
    ? ordered.findIndex((event) => {
        const date = calendarEventDate(event);
        return (
          date > cursor.date ||
          (date === cursor.date &&
            (event.kind > cursor.kind ||
              (event.kind === cursor.kind && event.id > cursor.id)))
        );
      })
    : 0;
  const offset = startIndex < 0 ? ordered.length : startIndex;
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 500);
  const events = ordered.slice(offset, offset + limit);
  const last = events.at(-1);
  const nextCursor =
    last && offset + events.length < ordered.length
      ? btoa(
          JSON.stringify({
            date: calendarEventDate(last),
            kind: last.kind,
            id: last.id,
          }),
        )
      : null;
  return { events, nextCursor };
};
