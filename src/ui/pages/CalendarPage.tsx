import {
  Banner,
  Button,
  ButtonGroup,
  Heading,
  HStack,
  Icon,
  Popover,
  VStack,
} from "@astryxdesign/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CalendarReadModelDto } from "../../shared/contracts";
import { useAccountScope } from "../accounts/AccountScopeContext";
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
import { usePageActions } from "../system/PageActionsContext";

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

export const calendarConflictBannerStatus = (
  conflicts: CalendarReadModelDto["conflicts"],
): "warning" | "error" =>
  conflicts.some(({ code }) =>
    /(^|_)(error|invalid|unavailable)(_|$)/i.test(code),
  )
    ? "error"
    : "warning";

export const calendarLoadMoreDisabled = (
  loading: boolean,
  refreshing: boolean,
  loadingMore: boolean,
  hasError = false,
): boolean => loading || refreshing || loadingMore || hasError;

const mergeUnique = <T,>(
  first: T[],
  second: T[],
  key: (value: T) => string,
): T[] => {
  const merged = new Map<string, T>();
  for (const value of [...first, ...second]) merged.set(key(value), value);
  return [...merged.values()];
};

export const mergeCalendarPages = (
  current: CalendarReadModelDto,
  next: CalendarReadModelDto,
): CalendarReadModelDto => ({
  ...next,
  actualTradingDates: [
    ...new Set([...current.actualTradingDates, ...next.actualTradingDates]),
  ].sort(),
  movers: mergeUnique(current.movers, next.movers, (value) => value.id),
  dividends: mergeUnique(
    current.dividends,
    next.dividends,
    (value) => value.id,
  ),
  earnings: mergeUnique(current.earnings, next.earnings, (value) => value.id),
  events: mergeUnique(
    current.events,
    next.events,
    (value) => `${value.kind}:${value.id}`,
  ),
  pending: mergeUnique(
    current.pending,
    next.pending,
    (value) =>
      `${value.kind}:${value.instrumentId ?? "all"}:${value.date ?? "range"}:${value.status}:${value.message}`,
  ),
  pendingFacts: mergeUnique(
    current.pendingFacts,
    next.pendingFacts,
    (value) =>
      `${value.kind}:${value.instrumentId ?? "all"}:${value.date ?? "range"}:${value.status}:${value.message}`,
  ),
  splitReview: mergeUnique(
    current.splitReview,
    next.splitReview,
    (value) =>
      `${value.kind}:${value.instrumentId ?? "all"}:${value.date ?? "range"}:${value.status}:${value.message}`,
  ),
  conflicts: mergeUnique(
    current.conflicts,
    next.conflicts,
    (value) =>
      `${value.code}:${value.instrumentId ?? "all"}:${value.effectiveDate ?? "range"}:${value.message}`,
  ),
});

export const CalendarPage = ({
  apiClient = calendarApi,
  initialCalendar,
  today,
  initialView = "month",
  initialAnchorDate,
}: CalendarPageProps) => {
  const { locale, t } = useI18n();
  const { selection: scopeSelection } = useAccountScope();
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [readModelDisabled, setReadModelDisabled] = useState(false);
  const [selection, setSelection] = useState<CalendarSelection | null>(null);

  useEffect(() => {
    calendarRef.current = calendar;
  }, [calendar]);

  const load = useCallback(
    async (cursor?: string) => {
      const requestId = ++requestIdRef.current;
      const isLoadingMore = cursor !== undefined;
      const hadCachedCalendar = calendarRef.current !== null;
      setLoading(isLoadingMore ? false : !hadCachedCalendar);
      setRefreshing(isLoadingMore ? false : hadCachedCalendar);
      setLoadingMore(isLoadingMore);
      setFailedCursor(null);
      setError(null);
      setReadModelDisabled(false);
      const range = rangeForView(anchorDate, view);
      const options: CalendarReadOptions = {
        locale,
        scope: scopeSelection,
        view,
        startDate: range.startDate,
        endDate: range.endDate,
        asOfDate: todayDate,
        ...(cursor ? { cursor } : {}),
      };
      try {
        const result = await apiClient.read(options);
        if (requestId !== requestIdRef.current) return;
        if (result.calendar) {
          const nextCalendar =
            isLoadingMore && calendarRef.current
              ? mergeCalendarPages(calendarRef.current, result.calendar)
              : result.calendar;
          calendarRef.current = nextCalendar;
          setCalendar(nextCalendar);
        }
      } catch (caught) {
        if (requestId === requestIdRef.current) {
          const messageKey = calendarErrorMessageKey(caught);
          setReadModelDisabled(messageKey === "calendarReadModelDisabled");
          setFailedCursor(isLoadingMore ? (cursor ?? null) : null);
          setError(t(messageKey));
        }
      } finally {
        if (requestId === requestIdRef.current) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [apiClient, anchorDate, locale, scopeSelection, t, todayDate, view],
  );

  const loadMore = useCallback(() => {
    const cursor = calendarRef.current?.nextCursor;
    if (
      !cursor ||
      calendarLoadMoreDisabled(loading, refreshing, loadingMore, error !== null)
    )
      return;
    void load(cursor);
  }, [error, load, loading, loadingMore, refreshing]);

  const retry = useCallback(() => {
    void load(failedCursor ?? undefined);
  }, [failedCursor, load]);

  useEffect(() => {
    void load();
  }, [load]);

  const pendingWithoutDate = useMemo(
    () => calendar?.pending.filter((item) => !item.date) ?? [],
    [calendar],
  );
  const loadingCalendar = useMemo<CalendarReadModelDto>(() => {
    const range = rangeForView(anchorDate, view);
    return {
      ...range,
      asOfDate: todayDate,
      locale,
      actualTradingDates: [],
      movers: [],
      dividends: [],
      earnings: [],
      events: [],
      pending: [],
      pendingFacts: [],
      splitReview: [],
      futureDividendStatus: "known",
      earningsCoverageStatus: "current",
      conflicts: [],
      nextCursor: null,
    };
  }, [anchorDate, locale, todayDate, view]);
  const displayedCalendar = calendar ?? (loading ? loadingCalendar : null);
  const calendarBusy = loading || refreshing;

  const pageActions = useMemo(
    () =>
      calendar ? (
        <HStack gap={1} wrap="nowrap">
          <ButtonGroup label={t("calendarView")} size="sm">
            <Button
              label={t("month")}
              variant={view === "month" ? "secondary" : "ghost"}
              aria-pressed={view === "month"}
              onClick={() => setView("month")}
            />
            <Button
              label={t("week")}
              variant={view === "week" ? "secondary" : "ghost"}
              aria-pressed={view === "week"}
              onClick={() => setView("week")}
            />
          </ButtonGroup>
          {calendar.futureDividendStatus === "not_currently_known" && (
            <Popover
              label={t("futureDividendsUnknown")}
              width="min(22rem, calc(100vw - 2rem))"
              content={
                <VStack gap={1}>
                  <strong>{t("futureDividendsUnknown")}</strong>
                  <div>{t("futureDividendsUnknownDescription")}</div>
                </VStack>
              }
            >
              <Button
                variant="ghost"
                size="sm"
                label={t("futureDividendsUnknown")}
                tooltip={t("futureDividendsUnknown")}
                icon={<Icon icon="warning" color="warning" size="sm" />}
                isIconOnly
              />
            </Popover>
          )}
          {calendar.earningsCoverageStatus !== "current" && (
            <Popover
              label={t("earningsCoverageUnknown")}
              width="min(22rem, calc(100vw - 2rem))"
              content={
                <VStack gap={1}>
                  <strong>{t("earningsCoverageUnknown")}</strong>
                  <div>{t("earningsCoverageUnknownDescription")}</div>
                </VStack>
              }
            >
              <Button
                variant="ghost"
                size="sm"
                label={t("earningsCoverageUnknown")}
                tooltip={t("earningsCoverageUnknown")}
                icon={<Icon icon="warning" color="warning" size="sm" />}
                isIconOnly
              />
            </Popover>
          )}
          {calendar.conflicts.length > 0 && (
            <Popover
              label={t("calendarConflict")}
              width="min(28rem, calc(100vw - 2rem))"
              content={
                <VStack gap={1}>
                  <strong>{t("calendarConflict")}</strong>
                  {calendar.conflicts.map((conflict, index) => (
                    <div
                      key={`${conflict.code}-${conflict.instrumentId ?? index}`}
                    >
                      {conflict.message}
                    </div>
                  ))}
                </VStack>
              }
            >
              <Button
                variant="ghost"
                size="sm"
                label={t("calendarConflict")}
                tooltip={t("calendarConflict")}
                icon={
                  <Icon
                    icon={
                      calendarConflictBannerStatus(calendar.conflicts) ===
                      "error"
                        ? "error"
                        : "warning"
                    }
                    color={
                      calendarConflictBannerStatus(calendar.conflicts) ===
                      "error"
                        ? "error"
                        : "warning"
                    }
                    size="sm"
                  />
                }
                isIconOnly
              />
            </Popover>
          )}
          {pendingWithoutDate.length > 0 && (
            <Popover
              label={t("calendarPending")}
              width="min(28rem, calc(100vw - 2rem))"
              content={
                <VStack gap={1}>
                  <strong>{t("calendarPending")}</strong>
                  {pendingWithoutDate.map((item, index) => (
                    <div key={`${item.kind}-${item.instrumentId ?? index}`}>
                      {item.kind === "split_review"
                        ? t("pendingSplitReview")
                        : t("pendingMarketData")}
                      {item.message ? `: ${item.message}` : ""}
                    </div>
                  ))}
                </VStack>
              }
            >
              <Button
                variant="ghost"
                size="sm"
                label={t("calendarPending")}
                tooltip={t("calendarPending")}
                icon={<Icon icon="info" color="accent" size="sm" />}
                isIconOnly
              />
            </Popover>
          )}
        </HStack>
      ) : null,
    [calendar, pendingWithoutDate, t, view],
  );
  const hasTopNavActions = usePageActions(pageActions);

  return (
    <VStack gap={3} data-testid="calendar-page">
      <HStack gap={2} justify="between" align="center">
        <Heading level={1} className="product-page-title-hidden">
          {t("calendarHeading")}
        </Heading>
        {!hasTopNavActions && pageActions}
      </HStack>

      {error && (
        <Banner
          status="error"
          title={error}
          {...(readModelDisabled
            ? { description: t("calendarReadModelDisabledDescription") }
            : {})}
          endContent={
            <Button variant="ghost" label={t("retry")} onClick={retry} />
          }
        />
      )}

      {calendarBusy && (
        <span
          className="product-page-title-hidden"
          role="status"
          aria-live="polite"
        >
          {calendar ? t("calendarRefreshing") : t("calendarLoading")}
        </span>
      )}

      {displayedCalendar && (
        <div
          className={`calendar-page__content${calendarBusy ? " calendar-page__content--loading" : ""}`}
          aria-busy={calendarBusy}
          inert={calendarBusy ? true : undefined}
        >
          <VStack gap={3}>
            {calendar && calendar.earningsCoverageStatus !== "current" && (
              <Banner
                status="warning"
                title={t("earningsCoverageUnknown")}
                description={t("earningsCoverageUnknownDescription")}
              />
            )}
            {calendar &&
              calendar.events.length === 0 &&
              calendar.pending.length === 0 && (
                <Banner status="info" title={t("noCalendarEvents")} />
              )}
            <MarketCalendar
              calendar={displayedCalendar}
              view={view}
              anchorDate={anchorDate}
              today={todayDate}
              onNavigate={setAnchorDate}
              onSelect={setSelection}
            />
            {calendar?.nextCursor && (
              <HStack gap={2} align="center" wrap="wrap">
                <Button
                  variant="secondary"
                  label={
                    loadingMore
                      ? t("calendarLoadingMore")
                      : t("calendarLoadMore")
                  }
                  isLoading={loadingMore}
                  isDisabled={calendarLoadMoreDisabled(
                    loading,
                    refreshing,
                    loadingMore,
                    error !== null,
                  )}
                  onClick={loadMore}
                />
                <span>{t("calendarMoreAvailable")}</span>
              </HStack>
            )}
          </VStack>
        </div>
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
