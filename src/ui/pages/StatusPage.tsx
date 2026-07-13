import {
  Badge,
  Button,
  EmptyState,
  Heading,
  HStack,
  Skeleton,
  StatusDot,
} from "@astryxdesign/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  JobReadModelDto,
  StatusReadModelDto,
} from "../../shared/contracts";
import { api } from "../api";
import type { MessageKey } from "../i18n/catalog";
import { useI18n } from "../i18n/I18nProvider";
import { formatDate, formatDateTime } from "../system/formatters";
import { usePageActions } from "../system/PageActionsContext";

export type SyncHealth = "healthy" | "syncing" | "attention" | "unknown";

const activeJobStatuses = new Set(["pending", "planning", "running"]);

export const syncHealthFor = (status: StatusReadModelDto): SyncHealth => {
  if (status.jobs.some((job) => activeJobStatuses.has(job.status))) {
    return "syncing";
  }
  const latestJob = status.jobs[0];
  if (
    status.earningsCoverage?.status === "stale" ||
    status.earningsCoverage?.status === "unavailable" ||
    latestJob?.status === "complete_with_errors" ||
    latestJob?.status === "terminal"
  ) {
    return "attention";
  }
  if (
    status.earningsCoverage?.status === "current" ||
    latestJob?.status === "complete"
  ) {
    return "healthy";
  }
  return "unknown";
};

const healthCopy: Record<
  SyncHealth,
  { label: MessageKey; description: MessageKey }
> = {
  healthy: { label: "syncUpToDate", description: "syncUpToDateDescription" },
  syncing: {
    label: "syncInProgress",
    description: "syncInProgressDescription",
  },
  attention: {
    label: "syncNeedsAttention",
    description: "syncNeedsAttentionDescription",
  },
  unknown: { label: "syncUnknown", description: "syncUnknownDescription" },
};

const healthVariant = (health: SyncHealth) => {
  switch (health) {
    case "healthy":
      return "success" as const;
    case "syncing":
      return "accent" as const;
    case "attention":
      return "error" as const;
    default:
      return "neutral" as const;
  }
};

const jobBadgeVariant = (status: string) => {
  switch (status) {
    case "complete":
      return "success" as const;
    case "complete_with_errors":
      return "warning" as const;
    case "terminal":
      return "error" as const;
    case "pending":
    case "planning":
    case "running":
      return "info" as const;
    default:
      return "neutral" as const;
  }
};

const jobStatusKey = (status: string): MessageKey => {
  switch (status) {
    case "pending":
      return "pending";
    case "planning":
      return "planning";
    case "running":
      return "running";
    case "complete":
      return "complete";
    case "complete_with_errors":
      return "completeWithErrors";
    case "terminal":
      return "terminal";
    default:
      return "unknownStatus";
  }
};

const jobTriggerKey = (triggerType: string): MessageKey => {
  switch (triggerType) {
    case "scheduled":
      return "scheduledSync";
    case "ledger_reconciliation":
      return "ledgerReconciliation";
    case "backfill":
      return "backfillSync";
    default:
      return "syncJob";
  }
};

const latestSuccessfulJob = (jobs: JobReadModelDto[]) =>
  jobs.find((job) => job.status === "complete") ?? null;

const jobRange = (job: JobReadModelDto, locale: "en" | "cn") => {
  if (!job.requestedStartDate && !job.requestedEndDate) return null;
  const start = job.requestedStartDate
    ? formatDate(job.requestedStartDate, locale)
    : "-";
  const end = job.requestedEndDate
    ? formatDate(job.requestedEndDate, locale)
    : start;
  return start === end ? start : `${start} - ${end}`;
};

interface StatusApiClient {
  read: (
    limit?: number,
    cursor?: string,
  ) => Promise<{ status: StatusReadModelDto }>;
}

const defaultStatusApi: StatusApiClient = {
  read: (limit, cursor) => api.status(limit, cursor),
};

export interface StatusPageProps {
  apiClient?: StatusApiClient;
  initialStatus?: StatusReadModelDto;
}

const StatusLoadingState = ({ label }: { label: string }) => (
  <div className="status-page__loading" role="status" aria-label={label}>
    <Skeleton width="32%" height={28} index={0} />
    <Skeleton width="100%" height={112} index={1} />
    <Skeleton width="100%" height={176} index={2} />
  </div>
);

export const StatusPage = ({
  apiClient = defaultStatusApi,
  initialStatus,
}: StatusPageProps) => {
  const { locale, t } = useI18n();
  const [status, setStatus] = useState<StatusReadModelDto | null>(
    initialStatus ?? null,
  );
  const [loading, setLoading] = useState(initialStatus === undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const statusRef = useRef(status);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const load = useCallback(
    async (cursor?: string) => {
      const id = ++requestId.current;
      const appending = cursor !== undefined;
      setError(null);
      if (appending) setLoadingMore(true);
      else if (statusRef.current) setRefreshing(true);
      else setLoading(true);
      try {
        const result = (await apiClient.read(25, cursor)).status;
        if (id !== requestId.current) return;
        setStatus((current) =>
          appending && current
            ? {
                ...result,
                jobs: [
                  ...current.jobs,
                  ...result.jobs.filter(
                    (job) => !current.jobs.some(({ id }) => id === job.id),
                  ),
                ],
              }
            : result,
        );
      } catch {
        if (id === requestId.current) setError(t("statusLoadError"));
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
      }
    },
    [apiClient, t],
  );

  useEffect(() => {
    if (initialStatus === undefined) void load();
  }, [initialStatus, load]);

  const hasActiveJob =
    status?.jobs.some((job) => activeJobStatuses.has(job.status)) ?? false;
  useEffect(() => {
    if (!hasActiveJob) return;
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [hasActiveJob, load]);

  const refreshAction = useMemo(
    () => (
      <Button
        size="sm"
        variant="secondary"
        label={t("refresh")}
        isLoading={refreshing}
        onClick={() => void load()}
      />
    ),
    [load, refreshing, t],
  );
  const hasTopNavActions = usePageActions(refreshAction);

  if (loading && !status)
    return <StatusLoadingState label={t("loadingStatus")} />;

  const health = status ? syncHealthFor(status) : "unknown";
  const healthText = healthCopy[health];
  const latestSuccess = status ? latestSuccessfulJob(status.jobs) : null;
  const latestActivity =
    status?.jobs[0]?.updatedAt ?? status?.earningsCoverage?.updatedAt ?? null;

  return (
    <main className="status-page" data-testid="status-page">
      <HStack gap={2} justify="between" align="center">
        <Heading level={1} className="product-page-title-hidden">
          {t("statusHeading")}
        </Heading>
        {!hasTopNavActions && refreshAction}
      </HStack>

      {error && (
        <div className="status-page__error" role="alert">
          <span>{error}</span>
          <Button
            variant="ghost"
            label={t("retry")}
            onClick={() => void load()}
          />
        </div>
      )}

      <section className="status-summary" aria-labelledby="sync-status-title">
        <div className="status-summary__state">
          <StatusDot
            variant={healthVariant(health)}
            label={t(healthText.label)}
            isPulsing={health === "syncing"}
          />
          <div>
            <Heading level={2} id="sync-status-title">
              {t(healthText.label)}
            </Heading>
            <p>{t(healthText.description)}</p>
          </div>
        </div>
        <dl className="status-summary__meta">
          <div>
            <dt>{t("lastSuccessfulSync")}</dt>
            <dd>
              {latestSuccess
                ? formatDateTime(latestSuccess.updatedAt, locale)
                : t("notAvailable")}
            </dd>
          </div>
          <div>
            <dt>{t("lastActivity")}</dt>
            <dd>
              {latestActivity
                ? formatDateTime(latestActivity, locale)
                : t("notAvailable")}
            </dd>
          </div>
        </dl>
      </section>

      <section className="status-sources" aria-labelledby="data-sync-title">
        <div className="status-section-heading">
          <div>
            <Heading level={2} id="data-sync-title">
              {t("dataSync")}
            </Heading>
          </div>
        </div>
        <div className="status-source-row">
          <div className="status-source-row__identity">
            <StatusDot
              variant={
                status?.earningsCoverage?.status === "current"
                  ? "success"
                  : status?.earningsCoverage
                    ? "error"
                    : "neutral"
              }
              label={
                status?.earningsCoverage?.status === "current"
                  ? t("syncUpToDate")
                  : status?.earningsCoverage
                    ? t("syncNeedsAttention")
                    : t("syncUnknown")
              }
            />
            <div>
              <strong>{t("earningsCalendarSync")}</strong>
              <span className="status-source-row__provider">
                {status?.earningsCoverage?.provider ?? "Alpha Vantage"}
              </span>
            </div>
          </div>
          <div className="status-source-row__details">
            <span>
              {status?.earningsCoverage?.coverageStartDate &&
              status.earningsCoverage.coverageEndDate
                ? `${formatDate(status.earningsCoverage.coverageStartDate, locale)} - ${formatDate(status.earningsCoverage.coverageEndDate, locale)}`
                : t("coverageUnknown")}
            </span>
            <time dateTime={status?.earningsCoverage?.updatedAt ?? undefined}>
              {status?.earningsCoverage?.updatedAt
                ? formatDateTime(status.earningsCoverage.updatedAt, locale)
                : t("notAvailable")}
            </time>
          </div>
          {(status?.earningsCoverage?.errorMessage ||
            status?.earningsCoverage?.errorCode) && (
            <div className="status-source-row__error" role="alert">
              {status.earningsCoverage.errorMessage ??
                status.earningsCoverage.errorCode}
              {status.earningsCoverage.errorMessage &&
              status.earningsCoverage.errorCode
                ? ` (${status.earningsCoverage.errorCode})`
                : ""}
            </div>
          )}
        </div>
      </section>

      <section className="status-jobs" aria-labelledby="recent-jobs-title">
        <div className="status-section-heading">
          <div>
            <Heading level={2} id="recent-jobs-title">
              {t("recentJobs")}
            </Heading>
          </div>
          <span className="status-jobs__count">
            {status?.jobs.length ?? 0} {t("jobs")}
          </span>
        </div>

        {status && status.jobs.length > 0 ? (
          <div className="status-job-list">
            <div className="status-job-list__header" aria-hidden="true">
              <span>{t("syncJob")}</span>
              <span>{t("status")}</span>
              <span>{t("workProgress")}</span>
              <span>{t("fetched")}</span>
              <span>{t("analyzed")}</span>
              <span>{t("reused")}</span>
              <span>{t("skipped")}</span>
              <span>{t("failures")}</span>
              <span>{t("lastActivity")}</span>
            </div>
            {status.jobs.map((job) => {
              const range = jobRange(job, locale);
              const progress = job.progress;
              return (
                <article className="status-job" key={job.id}>
                  <div className="status-job__main">
                    <div className="status-job__identity">
                      <strong>{t(jobTriggerKey(job.triggerType))}</strong>
                      <span className="status-job__identity-meta">
                        <span className="status-job__id" title={job.id}>
                          {job.id}
                        </span>
                        {range && (
                          <span className="status-job__range">{range}</span>
                        )}
                      </span>
                    </div>
                    <div className="status-job__state">
                      <Badge
                        variant={jobBadgeVariant(job.status)}
                        label={t(jobStatusKey(job.status))}
                      />
                    </div>
                    <dl className="status-job__metrics">
                      <div>
                        <dt>{t("workProgress")}</dt>
                        <dd className="status-job__progress">
                          {progress.workProcessed} / {progress.workTotal}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("fetched")}</dt>
                        <dd>{progress.workFetched}</dd>
                      </div>
                      <div>
                        <dt>{t("analyzed")}</dt>
                        <dd>{progress.workAnalyzed}</dd>
                      </div>
                      <div>
                        <dt>{t("reused")}</dt>
                        <dd>{progress.workReused}</dd>
                      </div>
                      <div>
                        <dt>{t("skipped")}</dt>
                        <dd>{progress.workSkipped}</dd>
                      </div>
                      <div>
                        <dt>{t("failures")}</dt>
                        <dd>{progress.workFailed}</dd>
                      </div>
                    </dl>
                    <time
                      className="status-job__updated"
                      dateTime={job.updatedAt}
                    >
                      {formatDateTime(job.updatedAt, locale)}
                    </time>
                  </div>
                  {job.errors.length > 0 && (
                    <div className="status-job__errors">
                      <strong>{t("jobErrors")}</strong>
                      <ul>
                        {job.errors.map((jobError) => (
                          <li key={jobError.workItemId}>
                            {jobError.effectiveDate
                              ? `${formatDate(jobError.effectiveDate, locale)} - `
                              : ""}
                            {jobError.message ??
                              jobError.code ??
                              t("unknownStatus")}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyState
            isCompact
            title={t("noJobs")}
            description={t("noJobsDescription")}
          />
        )}

        {status?.nextCursor && (
          <Button
            variant="secondary"
            label={t("loadMoreJobs")}
            isLoading={loadingMore}
            isDisabled={loadingMore}
            onClick={() => void load(status.nextCursor ?? undefined)}
          />
        )}
      </section>
    </main>
  );
};
