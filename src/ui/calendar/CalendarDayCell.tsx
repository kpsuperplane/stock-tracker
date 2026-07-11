import type { CalendarPendingDto } from "../../shared/contracts";
import { useI18n } from "../i18n/I18nProvider";
import { formatDate } from "../system/formatters";
import {
  type CalendarEvent,
  CalendarEventChip,
  type CalendarSelection,
} from "./CalendarEvent";
import type { CalendarDay } from "./dateMath";

export interface CalendarDayCellProps {
  day: CalendarDay;
  events: CalendarEvent[];
  pending: CalendarPendingDto[];
  locale: "en" | "cn";
  onSelect: (selection: CalendarSelection) => void;
}

export const CalendarDayCell = ({
  day,
  events,
  pending,
  locale,
  onSelect,
}: CalendarDayCellProps) => {
  const { t } = useI18n();
  const visibleEvents = events.slice(0, 3);
  const outsideLabel = day.outsideMonth ? ` · ${t("outsideMonth")}` : "";
  return (
    <div
      className={`calendar-day${day.outsideMonth ? " calendar-day--outside" : ""}${
        day.isToday ? " calendar-day--today" : ""
      }`}
      title={`${formatDate(day.date, locale)}${outsideLabel}`}
    >
      <div className="calendar-day__header">
        <time className="calendar-day__date" dateTime={day.date}>
          {day.date.slice(-2).replace(/^0/, "")}
        </time>
      </div>
      <div className="calendar-day__events">
        {visibleEvents.map((event) => (
          <CalendarEventChip
            key={`${event.kind}-${event.id}`}
            event={event}
            locale={locale}
            onSelect={onSelect}
          />
        ))}
        {events.length > visibleEvents.length && (
          <button
            type="button"
            className="calendar-more"
            aria-haspopup="dialog"
            onClick={() => onSelect({ kind: "more", date: day.date, events })}
          >
            +{events.length - visibleEvents.length} {t("moreEvents")}
          </button>
        )}
      </div>
      {pending.slice(0, 2).map((item) => (
        <div
          className="calendar-pending"
          key={`${item.kind}-${item.instrumentId ?? "all"}-${item.date ?? "range"}-${item.status}-${item.message}`}
          role="status"
        >
          {item.kind === "split_review"
            ? t("pendingSplitReview")
            : t("pendingMarketData")}
          {item.message ? `: ${item.message}` : ""}
        </div>
      ))}
    </div>
  );
};
