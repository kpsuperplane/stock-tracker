import { useI18n } from "../i18n/I18nProvider";
import { CalendarDayCell } from "./CalendarDayCell";
import { shortDayLabel, weekGridDays } from "./dateMath";

import type { CalendarGridProps } from "./MonthGrid";

const weekdayDates = [
  "2026-01-04",
  "2026-01-05",
  "2026-01-06",
  "2026-01-07",
  "2026-01-08",
  "2026-01-09",
  "2026-01-10",
];

export const WeekGrid = ({
  anchorDate,
  today,
  eventsByDate,
  pendingByDate,
  onSelect,
}: CalendarGridProps) => {
  const { locale, t } = useI18n();
  const days = weekGridDays(anchorDate, today);
  return (
    <section
      className="calendar-page__grid"
      aria-label={`${t("week")} ${days[0]?.date ?? anchorDate}`}
    >
      <div className="calendar-grid calendar-grid--week">
        {weekdayDates.map((date) => (
          <div className="calendar-grid__weekday" key={date}>
            {shortDayLabel(date, locale)}
          </div>
        ))}
        {days.map((day) => (
          <CalendarDayCell
            key={day.date}
            day={day}
            events={eventsByDate.get(day.date) ?? []}
            pending={pendingByDate.get(day.date) ?? []}
            locale={locale}
            onSelect={onSelect}
          />
        ))}
      </div>
    </section>
  );
};
