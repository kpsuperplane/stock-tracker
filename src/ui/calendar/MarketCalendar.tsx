import type { CalendarReadModelDto } from "../../shared/contracts";
import {
  type CalendarEvent,
  type CalendarSelection,
  eventDate,
} from "./CalendarEvent";
import { CalendarToolbar } from "./CalendarToolbar";
import { type CalendarView, rangeForView } from "./dateMath";
import { MonthGrid } from "./MonthGrid";
import { PeriodDividendSummary } from "./PeriodDividendSummary";
import { WeekGrid } from "./WeekGrid";

export interface MarketCalendarProps {
  calendar: CalendarReadModelDto;
  view: CalendarView;
  anchorDate: string;
  today: string;
  onNavigate: (date: string) => void;
  onSelect: (selection: CalendarSelection) => void;
}

const groupEvents = (events: CalendarEvent[]) => {
  const grouped = new Map<string, CalendarEvent[]>();
  for (const event of events) {
    const date = eventDate(event);
    const bucket = grouped.get(date) ?? [];
    bucket.push(event);
    grouped.set(date, bucket);
  }
  return grouped;
};

const groupPending = (calendar: CalendarReadModelDto) => {
  const grouped = new Map<string, CalendarReadModelDto["pending"]>();
  for (const item of calendar.pending) {
    if (!item.date) continue;
    const bucket = grouped.get(item.date) ?? [];
    bucket.push(item);
    grouped.set(item.date, bucket);
  }
  return grouped;
};

export const MarketCalendar = ({
  calendar,
  view,
  anchorDate,
  today,
  onNavigate,
  onSelect,
}: MarketCalendarProps) => {
  const eventsByDate = groupEvents(calendar.events);
  const pendingByDate = groupPending(calendar);
  const visibleRange = rangeForView(anchorDate, view);
  return (
    <>
      <CalendarToolbar
        view={view}
        anchorDate={anchorDate}
        today={today}
        onNavigate={onNavigate}
        endContent={
          <PeriodDividendSummary
            dividends={calendar.dividends}
            view={view}
            startDate={visibleRange.startDate}
            endDate={visibleRange.endDate}
          />
        }
      />
      {view === "month" ? (
        <MonthGrid
          anchorDate={anchorDate}
          today={today}
          eventsByDate={eventsByDate}
          pendingByDate={pendingByDate}
          onSelect={onSelect}
        />
      ) : (
        <WeekGrid
          anchorDate={anchorDate}
          today={today}
          eventsByDate={eventsByDate}
          pendingByDate={pendingByDate}
          onSelect={onSelect}
        />
      )}
    </>
  );
};
