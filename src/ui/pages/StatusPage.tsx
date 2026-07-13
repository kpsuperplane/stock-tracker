import {
  Badge,
  Button,
  EmptyState,
  Heading,
  Skeleton,
  StatusDot,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import type {
  JobReadModelDto,
  StatusReadModelDto,
} from "../../shared/contracts";
import { api } from "../api";
import type { MessageKey } from "../i18n/catalog";
import { useI18n } from "../i18n/I18nProvider";
import { formatDate, formatDateTime } from "../system/formatters";

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
      else if (!statusRef.current) setLoading(true);
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

  if (loading && !status)
    return <StatusLoadingState label={t("loadingStatus")} />;

  const health = status ? syncHealthFor(status) : "unknown";
  const healthText = healthCopy[health];
  const latestSuccess = status ? latestSuccessfulJob(status.jobs) : null;
  const latestActivity =
    status?.jobs[0]?.updatedAt ?? status?.earningsCoverage?.updatedAt ?? null;

  return (
    <main className="status-page" data-testid="status-page">
      <Heading level={1} className="product-page-title-hidden">
        {t("statusHeading")}
      </Heading>

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
          <Table
            tableProps={{ className: "status-job-table" }}
            density="compact"
            dividers="rows"
            textOverflow="truncate"
            aria-label={t("recentJobs")}
          >
            <TableHeader>
              <TableRow isHeaderRow>
                <TableHeaderCell>{t("syncJob")}</TableHeaderCell>
                <TableHeaderCell>{t("status")}</TableHeaderCell>
                <TableHeaderCell className="status-job-table__number-cell">
                  {t("workProgress")}
                </TableHeaderCell>
                <TableHeaderCell className="status-job-table__number-cell">
                  {t("fetched")}
                </TableHeaderCell>
                <TableHeaderCell className="status-job-table__number-cell">
                  {t("analyzed")}
                </TableHeaderCell>
                <TableHeaderCell className="status-job-table__number-cell">
                  {t("reused")}
                </TableHeaderCell>
                <TableHeaderCell className="status-job-table__number-cell">
                  {t("skipped")}
                </TableHeaderCell>
                <TableHeaderCell className="status-job-table__number-cell">
                  {t("failures")}
                </TableHeaderCell>
                <TableHeaderCell>{t("lastActivity")}</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {status.jobs.map((job) => {
                const range = jobRange(job, locale);
                const progress = job.progress;
                return (
                  <Fragment key={job.id}>
                    <TableRow>
                      <TableCell>
                        <div className="status-job-table__identity">
                          <strong>{t(jobTriggerKey(job.triggerType))}</strong>
                          <span className="status-job-table__identity-meta">
                            <span
                              className="status-job-table__id"
                              title={job.id}
                            >
                              {job.id}
                            </span>
                            {range && (
                              <span className="status-job-table__range">
                                {range}
                              </span>
                            )}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={jobBadgeVariant(job.status)}
                          label={t(jobStatusKey(job.status))}
                        />
                      </TableCell>
                      <TableCell className="status-job-table__number-cell">
                        {progress.workProcessed} / {progress.workTotal}
                      </TableCell>
                      <TableCell className="status-job-table__number-cell">
                        {progress.workFetched}
                      </TableCell>
                      <TableCell className="status-job-table__number-cell">
                        {progress.workAnalyzed}
                      </TableCell>
                      <TableCell className="status-job-table__number-cell">
                        {progress.workReused}
                      </TableCell>
                      <TableCell className="status-job-table__number-cell">
                        {progress.workSkipped}
                      </TableCell>
                      <TableCell className="status-job-table__number-cell">
                        {progress.workFailed}
                      </TableCell>
                      <TableCell>
                        <time
                          className="status-job-table__updated"
                          dateTime={job.updatedAt}
                        >
                          {formatDateTime(job.updatedAt, locale)}
                        </time>
                      </TableCell>
                    </TableRow>
                    {job.errors.length > 0 && (
                      <TableRow className="status-job-table__error-row">
                        <TableCell colSpan={9}>
                          <div className="status-job-table__errors">
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
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
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
