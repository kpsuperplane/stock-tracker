import { Button, HStack } from "@astryxdesign/core";
import type { Locale } from "../i18n/catalog";
import { useI18n } from "../i18n/I18nProvider";
import { formatDate } from "../system/formatters";
import {
  addDays,
  type CalendarView,
  monthLabel,
  rangeForView,
  shiftMonth,
} from "./dateMath";

export interface CalendarToolbarProps {
  view: CalendarView;
  anchorDate: string;
  today: string;
  onNavigate: (date: string) => void;
}

export const calendarPeriodTitle = (
  view: CalendarView,
  anchorDate: string,
  locale: Locale,
): string => {
  const range = rangeForView(anchorDate, view);
  return view === "month"
    ? monthLabel(anchorDate, locale)
    : `${formatDate(range.startDate, locale)} – ${formatDate(
        range.endDate,
        locale,
      )}`;
};

export const CalendarToolbar = ({
  view,
  anchorDate,
  today,
  onNavigate,
}: CalendarToolbarProps) => {
  const { locale, t } = useI18n();
  const title = calendarPeriodTitle(view, anchorDate, locale);
  return (
    <HStack className="calendar-toolbar" gap={1} align="center" wrap="wrap">
      <Button
        variant="ghost"
        size="sm"
        label={t("previousPeriod")}
        aria-label={t("previousPeriod")}
        isIconOnly
        icon={<span aria-hidden="true">←</span>}
        onClick={() =>
          onNavigate(
            view === "month"
              ? shiftMonth(anchorDate, -1)
              : addDays(anchorDate, -7),
          )
        }
      />
      <Button
        className="calendar-toolbar__date"
        variant="ghost"
        size="sm"
        label={title}
        aria-label={`${title}, ${t("today")}`}
        onClick={() => onNavigate(today)}
      />
      <Button
        variant="ghost"
        size="sm"
        label={t("nextPeriod")}
        aria-label={t("nextPeriod")}
        isIconOnly
        icon={<span aria-hidden="true">→</span>}
        onClick={() =>
          onNavigate(
            view === "month"
              ? shiftMonth(anchorDate, 1)
              : addDays(anchorDate, 7),
          )
        }
      />
    </HStack>
  );
};
