import { Button, ButtonGroup, Heading, HStack } from "@astryxdesign/core";
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
  onViewChange: (view: CalendarView) => void;
  onNavigate: (date: string) => void;
}

export const CalendarToolbar = ({
  view,
  anchorDate,
  today,
  onViewChange,
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
    <HStack gap={2} justify="between" align="center" wrap="wrap">
      <HStack gap={2} align="center" wrap="wrap">
        <Button
          variant="ghost"
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
          label={t("today")}
          onClick={() => onNavigate(today)}
        />
        <Button
          variant="ghost"
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
        <Heading level={2}>{title}</Heading>
      </HStack>
      <ButtonGroup label={t("calendarView")} size="sm">
        <Button
          label={t("month")}
          variant={view === "month" ? "secondary" : "ghost"}
          aria-pressed={view === "month"}
          onClick={() => onViewChange("month")}
        />
        <Button
          label={t("week")}
          variant={view === "week" ? "secondary" : "ghost"}
          aria-pressed={view === "week"}
          onClick={() => onViewChange("week")}
        />
      </ButtonGroup>
    </HStack>
  );
};
