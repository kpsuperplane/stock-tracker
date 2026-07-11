import { Banner, Button, Heading, VStack } from "@astryxdesign/core";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CalendarReadModelDto } from "../../shared/contracts";
import {
  ApiClientError,
  type CalendarApiClient,
  type CalendarReadOptions,
  calendarApi,
} from "../api";
import type { CalendarSelection } from "../calendar/CalendarEvent";
import {
  type CalendarView,
  rangeForView,
  todayInToronto,
} from "../calendar/dateMath";
import { MarketCalendar } from "../calendar/MarketCalendar";
import { MoverDialog } from "../calendar/MoverDialog";
import { useI18n } from "../i18n/I18nProvider";
import { formatDate } from "../system/formatters";

export interface CalendarPageProps {
  apiClient?: CalendarApiClient;
  initialCalendar?: CalendarReadModelDto;
  today?: string;
  initialView?: CalendarView;
  initialAnchorDate?: string;
}

const calendarErrorMessageKey = (
  error: unknown,
): "calendarReadModelDisabled" | "calendarLoadError" =>
  error instanceof ApiClientError && error.code === "read_model_disabled"
    ? "calendarReadModelDisabled"
    : "calendarLoadError";

export { calendarErrorMessageKey };

export const CalendarPage = ({
  apiClient = calendarApi,
  initialCalendar,
  today,
  initialView = "month",
  initialAnchorDate,
}: CalendarPageProps) => {
  const { locale, t } = useI18n();
  const todayDate = today ?? todayInToronto();
  const [view, setView] = useState<CalendarView>(initialView);
  const [anchorDate, setAnchorDate] = useState(
    initialAnchorDate ?? initialCalendar?.startDate ?? todayDate,
  );
  const [calendar, setCalendar] = useState<CalendarReadModelDto | null>(
    initialCalendar ?? null,
  );
  const calendarRef = useRef<CalendarReadModelDto | null>(calendar);
  const requestIdRef = useRef(0);
  const [loading, setLoading] = useState(initialCalendar === undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [readModelDisabled, setReadModelDisabled] = useState(false);
  const [selection, setSelection] = useState<CalendarSelection | null>(null);

  useEffect(() => {
    calendarRef.current = calendar;
  }, [calendar]);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    const hadCachedCalendar = calendarRef.current !== null;
    setLoading(!hadCachedCalendar);
    setRefreshing(hadCachedCalendar);
    setError(null);
    setReadModelDisabled(false);
    const range = rangeForView(anchorDate, view);
    const options: CalendarReadOptions = {
      locale,
      view,
      startDate: range.startDate,
      endDate: range.endDate,
      asOfDate: todayDate,
    };
    try {
      const result = await apiClient.read(options);
      if (requestId !== requestIdRef.current) return;
      if (result.calendar) {
        calendarRef.current = result.calendar;
        setCalendar(result.calendar);
      }
    } catch (caught) {
      if (requestId === requestIdRef.current) {
        const messageKey = calendarErrorMessageKey(caught);
        setReadModelDisabled(messageKey === "calendarReadModelDisabled");
        setError(t(messageKey));
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [apiClient, anchorDate, locale, t, todayDate, view]);

  useEffect(() => {
    void load();
  }, [load]);

  const range = rangeForView(anchorDate, view);
  const pendingWithoutDate =
    calendar?.pending.filter((item) => !item.date) ?? [];

  return (
    <VStack gap={4} data-testid="calendar-page">
      <VStack gap={1}>
        <Heading level={1}>{t("calendarHeading")}</Heading>
        <div>{t("calendarIntro")}</div>
        <div>
          {formatDate(range.startDate, locale)} –{" "}
          {formatDate(range.endDate, locale)}
        </div>
      </VStack>

      {error && (
        <Banner
          status="error"
          title={error}
          {...(readModelDisabled
            ? { description: t("calendarReadModelDisabledDescription") }
            : {})}
          endContent={
            <Button
              variant="ghost"
              label={t("retry")}
              onClick={() => void load()}
            />
          }
        />
      )}

      {loading && !calendar && (
        <Banner status="info" title={t("calendarLoading")} />
      )}
      {refreshing && calendar && (
        <Banner status="info" title={t("calendarRefreshing")} />
      )}

      {calendar && (
        <VStack gap={3}>
          {calendar.futureDividendStatus === "not_currently_known" && (
            <Banner
              status="warning"
              title={t("futureDividendsUnknown")}
              description={t("futureDividendsUnknownDescription")}
            />
          )}
          {calendar.conflicts.length > 0 && (
            <Banner
              status="warning"
              title={t("calendarConflict")}
              defaultIsExpanded
            >
              <VStack gap={1}>
                {calendar.conflicts.map((conflict, index) => (
                  <div
                    key={`${conflict.code}-${conflict.instrumentId ?? index}`}
                  >
                    {conflict.message}
                  </div>
                ))}
              </VStack>
            </Banner>
          )}
          {pendingWithoutDate.length > 0 && (
            <Banner
              status="info"
              title={t("calendarPending")}
              defaultIsExpanded
            >
              <VStack gap={1}>
                {pendingWithoutDate.map((item, index) => (
                  <div key={`${item.kind}-${item.instrumentId ?? index}`}>
                    {item.kind === "split_review"
                      ? t("pendingSplitReview")
                      : t("pendingMarketData")}
                    {item.message ? `: ${item.message}` : ""}
                  </div>
                ))}
              </VStack>
            </Banner>
          )}
          {calendar.events.length === 0 && calendar.pending.length === 0 && (
            <Banner status="info" title={t("noCalendarEvents")} />
          )}
          <MarketCalendar
            calendar={calendar}
            view={view}
            anchorDate={anchorDate}
            today={todayDate}
            onViewChange={setView}
            onNavigate={setAnchorDate}
            onSelect={setSelection}
          />
        </VStack>
      )}

      <MoverDialog
        selection={selection}
        onOpenChange={(isOpen) => {
          if (!isOpen) setSelection(null);
        }}
        onSelect={setSelection}
      />
    </VStack>
  );
};
