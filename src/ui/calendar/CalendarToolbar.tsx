import { Button, Heading, HStack } from "@astryxdesign/core";
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

export const CalendarToolbar = ({
  view,
  anchorDate,
  today,
  onNavigate,
}: CalendarToolbarProps) => {
  const { locale, t } = useI18n();
  const range = rangeForView(anchorDate, view);
  const title =
    view === "month"
      ? monthLabel(anchorDate, locale)
      : `${formatDate(range.startDate, locale)} – ${formatDate(
          range.endDate,
          locale,
        )}`;
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
        variant="ghost"
        size="sm"
        label={t("today")}
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
      <Heading level={2} className="calendar-toolbar__title">
        {title}
      </Heading>
    </HStack>
  );
};
