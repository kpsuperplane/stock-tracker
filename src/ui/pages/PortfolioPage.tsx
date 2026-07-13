import {
  Banner,
  Button,
  Heading,
  Icon,
  Link,
  VStack,
} from "@astryxdesign/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PortfolioHistoryReadModelDto,
  PortfolioRangePreset,
} from "../../shared/contracts";
import { useAccountScope } from "../accounts/AccountScopeContext";
import { ApiClientError } from "../api";
import { RefreshIcon } from "../components/ProductIcons";
import { useI18n } from "../i18n/I18nProvider";
import { downloadPortfolioPoints } from "../portfolio/download";
import {
  type PortfolioHistoryApiClient,
  portfolioHistoryApi,
} from "../portfolio/history-api";
import { PortfolioHoldingsTable } from "../portfolio/PortfolioHoldingsTable";
import { PortfolioPerformanceChart } from "../portfolio/PortfolioPerformanceChart";
import { PortfolioRangeControls } from "../portfolio/PortfolioRangeControls";
import { PortfolioSkeleton } from "../portfolio/PortfolioSkeleton";
import { PortfolioSummaryStrip } from "../portfolio/PortfolioSummaryStrip";
import {
  type PortfolioUrlState,
  parsePortfolioUrlState,
  writePortfolioUrlState,
} from "../portfolio/state";
import { usePageActions } from "../system/PageActionsContext";

export interface PortfolioPageProps {
  apiClient?: PortfolioHistoryApiClient;
  initialHistory?: PortfolioHistoryReadModelDto;
  initialState?: PortfolioUrlState;
}

export const portfolioHistoryErrorMessageKey = (
  error: unknown,
): "portfolioHistoryDisabled" | "portfolioHistoryLoadError" =>
  error instanceof ApiClientError &&
  (error.code === "portfolio_history_disabled" ||
    error.code === "read_model_disabled")
    ? "portfolioHistoryDisabled"
    : "portfolioHistoryLoadError";

const currenciesFor = (
  history: PortfolioHistoryReadModelDto | null,
): ("CAD" | "USD")[] =>
  history?.currencies.map((result) => result.currency) ?? [];

export const PortfolioPage = ({
  apiClient = portfolioHistoryApi,
  initialHistory,
  initialState,
}: PortfolioPageProps) => {
  const { locale, t } = useI18n();
  const { selection } = useAccountScope();
  const [state, setState] = useState<PortfolioUrlState>(
    initialState ?? parsePortfolioUrlState,
  );
  const [history, setHistory] = useState<PortfolioHistoryReadModelDto | null>(
    initialHistory ?? null,
  );
  const historyRef = useRef(history);
  const requestId = useRef(0);
  const [loading, setLoading] = useState(initialHistory === undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [disabled, setDisabled] = useState(false);

  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    if (initialState || typeof window === "undefined") return;
    const onPopState = () => setState(parsePortfolioUrlState());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [initialState]);

  const canLoad =
    state.range !== "custom" || Boolean(state.startDate && state.endDate);

  const load = useCallback(async () => {
    if (!canLoad) {
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const currentRequest = ++requestId.current;
    const hasCachedHistory = historyRef.current !== null;
    setLoading(!hasCachedHistory);
    setRefreshing(hasCachedHistory);
    setError(null);
    setDisabled(false);
    try {
      const result = await apiClient.read({
        locale,
        scope: selection,
        range: state.range,
        ...(state.range === "custom" && state.startDate && state.endDate
          ? { startDate: state.startDate, endDate: state.endDate }
          : {}),
      });
      if (currentRequest !== requestId.current) return;
      if (result.history) {
        historyRef.current = result.history;
        setHistory(result.history);
      }
    } catch (caught) {
      if (currentRequest !== requestId.current) return;
      const key = portfolioHistoryErrorMessageKey(caught);
      setDisabled(key === "portfolioHistoryDisabled");
      setError(t(key));
    } finally {
      if (currentRequest === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [
    apiClient,
    canLoad,
    locale,
    selection,
    state.endDate,
    state.range,
    state.startDate,
    t,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateState = useCallback(
    (next: PortfolioUrlState, mode: "push" | "replace" = "push") => {
      setState(next);
      writePortfolioUrlState(next, mode);
    },
    [],
  );

  const currencies = currenciesFor(history);
  const selectedCurrency =
    (state.currency && currencies.includes(state.currency)
      ? state.currency
      : currencies.includes("CAD")
        ? "CAD"
        : currencies[0]) ?? null;

  useEffect(() => {
    if (selectedCurrency && selectedCurrency !== state.currency) {
      updateState({ ...state, currency: selectedCurrency }, "replace");
    }
  }, [selectedCurrency, state, updateState]);

  const currencyResult =
    history?.currencies.find(
      (result) => result.currency === selectedCurrency,
    ) ?? null;

  const downloadCurrentData = useCallback(() => {
    if (!currencyResult) return;
    downloadPortfolioPoints({
      points: currencyResult.points,
      metric: state.metric,
      startDate: history?.startDate ?? "start",
      endDate: history?.endDate ?? "end",
    });
  }, [currencyResult, history?.endDate, history?.startDate, state.metric]);

  const retry = useCallback(() => void load(), [load]);
  const pageActions = useMemo(
    () => (
      <Button
        variant="secondary"
        size="sm"
        label={refreshing ? t("portfolioHistoryRefreshing") : t("refresh")}
        tooltip={refreshing ? t("portfolioHistoryRefreshing") : t("refresh")}
        icon={<Icon icon={RefreshIcon} size="sm" />}
        isIconOnly
        isLoading={refreshing}
        onClick={retry}
      />
    ),
    [refreshing, retry, t],
  );
  const hasTopNavActions = usePageActions(pageActions);

  const eventsHref = useMemo(() => {
    const query = new URLSearchParams();
    if (selection.scopeType !== "all") {
      query.set("scopeType", selection.scopeType);
      if (selection.scopeId) query.set("scopeId", selection.scopeId);
    }
    const suffix = query.toString();
    return `/events${suffix ? `?${suffix}` : ""}`;
  }, [selection]);

  const changeRange = useCallback(
    (range: PortfolioRangePreset) => {
      updateState({
        metric: state.metric,
        range,
        ...(state.currency ? { currency: state.currency } : {}),
        ...(range === "custom" && state.startDate && state.endDate
          ? { startDate: state.startDate, endDate: state.endDate }
          : {}),
      });
    },
    [state, updateState],
  );

  return (
    <VStack gap={3} data-testid="portfolio-page">
      <Heading level={1} className="product-page-title-hidden">
        {t("portfolioHeading")}
      </Heading>
      {!hasTopNavActions && (
        <div className="portfolio-page-actions">{pageActions}</div>
      )}

      <PortfolioRangeControls
        state={state}
        currencies={currencies}
        coverage={currencyResult?.coverage ?? null}
        canDownload={Boolean(currencyResult?.points.length)}
        onDownload={downloadCurrentData}
        onRangeChange={changeRange}
        onCustomRangeChange={(startDate, endDate) =>
          updateState({ ...state, range: "custom", startDate, endDate })
        }
        onCurrencyChange={(currency) => updateState({ ...state, currency })}
      />

      {error && (
        <Banner
          status="error"
          title={error}
          {...(disabled
            ? { description: t("portfolioHistoryDisabledDescription") }
            : {})}
          endContent={
            <Button variant="ghost" label={t("retry")} onClick={retry} />
          }
        />
      )}

      {!canLoad && <Banner status="info" title={t("chooseCustomDateRange")} />}

      {loading && !history && (
        <div role="status" aria-live="polite">
          <span className="product-page-title-hidden">
            {t("portfolioHistoryLoading")}
          </span>
          <PortfolioSkeleton />
        </div>
      )}

      {refreshing && (
        <span
          className="product-page-title-hidden"
          role="status"
          aria-live="polite"
        >
          {t("portfolioHistoryRefreshing")}
        </span>
      )}

      {!loading && history && history.currencies.length === 0 && (
        <Banner
          status="info"
          title={t("noPortfolioTransactions")}
          description={t("noPortfolioTransactionsDescription")}
          endContent={
            <Link href={eventsHref} weight="semibold" hasUnderline>
              {t("openEvents")}
            </Link>
          }
        />
      )}

      {canLoad && currencyResult && (
        <div
          className={
            refreshing ? "portfolio-content is-refreshing" : "portfolio-content"
          }
        >
          <PortfolioSummaryStrip
            currency={currencyResult}
            selectedMetric={state.metric}
            onSelectMetric={(metric) => updateState({ ...state, metric })}
          />
          <PortfolioPerformanceChart
            points={currencyResult.points}
            metric={state.metric}
            currency={currencyResult.currency}
          />
          {currencyResult.positions.length > 0 && (
            <PortfolioHoldingsTable positions={currencyResult.positions} />
          )}
        </div>
      )}
    </VStack>
  );
};
