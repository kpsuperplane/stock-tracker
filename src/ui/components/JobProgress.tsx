import {
  Badge,
  Banner,
  Button,
  Collapsible,
  Heading,
  HStack,
  ProgressBar,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  VStack,
} from "@astryxdesign/core";
import type { JobReadModelDto } from "../../shared/contracts";
import type { BackfillJob } from "../api";
import { useI18n } from "../i18n/I18nProvider";
import { formatDate } from "../system/formatters";

export type JobSource = BackfillJob | JobReadModelDto;

export type JobError = {
  id: string;
  workItemId?: string;
  screeningId?: string;
  symbol: string;
  date: string;
  code: string | null;
  message: string;
  retryable: boolean;
};

export type JobProgressCounts = JobReadModelDto["progress"];

export const isReadModelJob = (job: JobSource): job is JobReadModelDto =>
  "work" in job && Array.isArray(job.work);

export const jobTriggerType = (job: JobSource): string => {
  if (isReadModelJob(job)) return job.triggerType;
  return job.triggerType ?? job.pipeline?.triggerType ?? "backfill";
};

/**
 * Return the persisted creation timestamp used by the two job APIs.  Legacy
 * summary rows may omit it for older data, so an empty string sorts those rows
 * after timestamped jobs without inventing a client-side timestamp.
 */
export const jobCreatedAt = (job: JobSource): string =>
  isReadModelJob(job) ? job.createdAt : (job.created_at ?? "");

/** Stable global ordering for normalized and legacy job pages. */
export const compareJobsNewestFirst = (
  left: JobSource,
  right: JobSource,
): number => {
  const byCreatedAt = jobCreatedAt(right).localeCompare(jobCreatedAt(left));
  return byCreatedAt || right.id.localeCompare(left.id);
};

export const sortJobsNewestFirst = (jobs: JobSource[]): JobSource[] =>
  [...jobs].sort(compareJobsNewestFirst);

export const jobGroup = (job: JobSource): "manual" | "automatic" =>
  ["ledger_reconciliation", "scheduled"].includes(jobTriggerType(job))
    ? "automatic"
    : "manual";

export const groupJobs = (jobs: JobSource[]) => ({
  manual: jobs.filter((job) => jobGroup(job) === "manual"),
  automatic: jobs.filter((job) => jobGroup(job) === "automatic"),
});

export const jobProgressCounts = (job: JobSource): JobProgressCounts => {
  if (isReadModelJob(job)) return job.progress;
  if (job.progress) return job.progress;
  return {
    workTotal: job.ticker_jobs_total,
    workReused: job.work_reused ?? 0,
    workSkipped: job.work_skipped ?? 0,
    workFetched: job.work_fetched ?? 0,
    workAnalyzed: job.work_analyzed ?? 0,
    workProcessed: job.work_processed ?? job.ticker_jobs_processed,
    workFailed: job.work_failed ?? job.ticker_jobs_failed,
  };
};

export const jobErrors = (job: JobSource): JobError[] => {
  if (isReadModelJob(job)) {
    return job.errors.map((error) => {
      const work = job.work.find((item) => item.id === error.workItemId);
      return {
        id: error.workItemId,
        workItemId: error.workItemId,
        screeningId: error.workItemId,
        symbol: work?.instrumentId ?? "—",
        date: error.effectiveDate ?? "—",
        code: error.code,
        message: error.message ?? error.code ?? "—",
        retryable: false,
      };
    });
  }
  return job.errors.map((error, index) => {
    const id =
      error.workItemId ??
      error.screeningId ??
      `${error.symbol}-${error.tradingDate}-${index}`;
    return {
      id,
      ...(error.workItemId ? { workItemId: error.workItemId } : {}),
      ...(error.screeningId ? { screeningId: error.screeningId } : {}),
      symbol: error.symbol,
      date: error.tradingDate,
      code: error.errorCode,
      message: error.errorMessage ?? error.errorCode ?? "—",
      retryable: error.retryable,
    };
  });
};

type StatusCopyKey =
  | "pending"
  | "queued"
  | "running"
  | "processing"
  | "complete"
  | "completeWithErrors"
  | "failed"
  | "paused"
  | "skipped"
  | "terminal"
  | "planning"
  | "noMarketData"
  | "unknownStatus";

const statusCopyKey = (status: string): StatusCopyKey => {
  switch (status) {
    case "pending":
    case "queued":
    case "running":
    case "processing":
    case "planning":
    case "complete":
    case "failed":
    case "paused":
    case "skipped":
    case "terminal":
      return status;
    case "complete_with_errors":
      return "completeWithErrors";
    case "no_market_data":
      return "noMarketData";
    default:
      return "unknownStatus";
  }
};

const statusVariant = (
  status: string,
): "neutral" | "success" | "warning" | "error" => {
  switch (status) {
    case "complete":
      return "success";
    case "complete_with_errors":
    case "paused":
    case "skipped":
    case "no_market_data":
      return "warning";
    case "failed":
    case "terminal":
      return "error";
    default:
      return "neutral";
  }
};

export const terminalJobStatuses = new Set([
  "complete",
  "complete_with_errors",
  "failed",
  "paused",
  "terminal",
  "no_market_data",
  "skipped",
]);

export interface JobProgressProps {
  job: JobSource;
  defaultIsOpen?: boolean;
  onRetry?: (error: JobError) => void;
  retryingId?: string | null;
  onLoadDetails?: () => void;
  loadingDetails?: boolean;
}

export const JobProgress = ({
  job,
  defaultIsOpen = true,
  onRetry,
  retryingId = null,
  onLoadDetails,
  loadingDetails = false,
}: JobProgressProps) => {
  const { locale, t } = useI18n();
  const counts = jobProgressCounts(job);
  const errors = jobErrors(job);
  const triggerType = jobTriggerType(job);
  const triggerLabel =
    triggerType === "ledger_reconciliation"
      ? t("automaticReconciliation")
      : triggerType === "scheduled"
        ? t("scheduledJobs")
        : triggerType === "backfill"
          ? t("manualBackfills")
          : t("pipelineJob");
  const datesTotal = "dates_total" in job ? job.dates_total : null;
  const datesProcessed = "dates_processed" in job ? job.dates_processed : null;
  const runs = "runs" in job ? job.runs : [];
  const detailsTruncated =
    "details_truncated" in job && job.details_truncated === true;
  const runsTotal = "runs_total" in job ? (job.runs_total ?? 0) : 0;
  const errorsTotal = "errors_total" in job ? (job.errors_total ?? 0) : 0;
  const statusKey = statusCopyKey(job.status);
  const hasMoreWork = isReadModelJob(job) && job.nextCursor !== null;
  const requestedStartDate = isReadModelJob(job)
    ? job.requestedStartDate
    : (job.start_date ?? null);
  const requestedEndDate = isReadModelJob(job)
    ? job.requestedEndDate
    : (job.end_date ?? null);
  const createdAt = jobCreatedAt(job);
  const createdAtText = createdAt
    ? new Intl.DateTimeFormat(locale === "cn" ? "zh-CN" : "en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(createdAt))
    : null;
  const hasRetryableErrors = Boolean(
    onRetry && errors.some((error) => error.retryable),
  );
  return (
    <section
      data-testid={`job-progress-${job.id}`}
      aria-labelledby={`job-${job.id}-heading`}
    >
      <VStack gap={3}>
        <HStack gap={2} justify="between" align="start" wrap="wrap">
          <VStack gap={0.5}>
            <Heading level={3} id={`job-${job.id}-heading`}>
              {triggerLabel}
            </Heading>
            <span title={job.id}>{job.id.slice(0, 12)}</span>
            {(requestedStartDate || requestedEndDate || createdAtText) && (
              <span>
                {requestedStartDate && requestedEndDate
                  ? `${t("requestedRange")}: ${formatDate(requestedStartDate, locale)} – ${formatDate(requestedEndDate, locale)}`
                  : null}
                {requestedStartDate && requestedEndDate && createdAtText
                  ? " · "
                  : null}
                {createdAtText
                  ? `${t("jobCreatedAt")}: ${createdAtText}`
                  : null}
              </span>
            )}
          </VStack>
          <span role="status" aria-live="polite">
            <Badge variant={statusVariant(job.status)} label={t(statusKey)} />
          </span>
        </HStack>
        <Collapsible
          trigger={`${t("jobProgress")}: ${triggerLabel}`}
          defaultIsOpen={defaultIsOpen}
        >
          <VStack gap={3}>
            {datesTotal !== null && datesProcessed !== null && (
              <ProgressBar
                label={t("datesProgress")}
                value={datesProcessed}
                max={Math.max(datesTotal, 1)}
                hasValueLabel
                formatValueLabel={(value, max) => `${value}/${max}`}
              />
            )}
            <ProgressBar
              label={t("workProgress")}
              value={counts.workProcessed}
              max={Math.max(counts.workTotal, 1)}
              hasValueLabel
              formatValueLabel={(value, max) => `${value}/${max}`}
              variant={statusVariant(job.status)}
            />
            <HStack gap={1} wrap="wrap" role="status" aria-live="polite">
              <Badge label={`${t("workReused")}: ${counts.workReused}`} />
              <Badge label={`${t("workSkipped")}: ${counts.workSkipped}`} />
              <Badge label={`${t("workFetched")}: ${counts.workFetched}`} />
              <Badge label={`${t("workAnalyzed")}: ${counts.workAnalyzed}`} />
              <Badge label={`${t("workProcessed")}: ${counts.workProcessed}`} />
              <Badge
                variant={counts.workFailed > 0 ? "error" : "neutral"}
                label={`${t("workFailed")}: ${counts.workFailed}`}
              />
            </HStack>

            {runs.length > 0 ? (
              <VStack gap={1}>
                <Heading level={4}>{t("runHistory")}</Heading>
                <Table
                  density="compact"
                  dividers="rows"
                  textOverflow="wrap"
                  aria-label={t("runHistory")}
                >
                  <TableHeader>
                    <TableRow isHeaderRow>
                      <TableHeaderCell>{t("date")}</TableHeaderCell>
                      <TableHeaderCell>{t("status")}</TableHeaderCell>
                      <TableHeaderCell>{t("workFailed")}</TableHeaderCell>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {runs.map((run) => (
                      <TableRow key={run.tradingDate}>
                        <TableCell>{run.tradingDate}</TableCell>
                        <TableCell>{t(statusCopyKey(run.status))}</TableCell>
                        <TableCell>{run.tickersFailed}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </VStack>
            ) : !detailsTruncated ? (
              <span>{t("noRunHistory")}</span>
            ) : null}

            {detailsTruncated && (
              <Banner
                status="info"
                title={t("jobDetailsSummary")}
                description={`${t("runHistory")}: ${runsTotal} · ${t("jobErrors")}: ${errorsTotal}`}
                {...(onLoadDetails
                  ? {
                      endContent: (
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          label={
                            loadingDetails
                              ? t("loadingJobDetails")
                              : t("loadJobDetails")
                          }
                          isLoading={loadingDetails}
                          onClick={onLoadDetails}
                        />
                      ),
                    }
                  : {})}
              />
            )}

            {errors.length > 0 && (
              <VStack gap={1}>
                <Banner
                  status="error"
                  title={`${t("jobErrors")} (${errors.length})`}
                />
                <Table
                  density="compact"
                  dividers="rows"
                  textOverflow="wrap"
                  aria-label={t("jobErrors")}
                >
                  <TableHeader>
                    <TableRow isHeaderRow>
                      <TableHeaderCell>{t("instrument")}</TableHeaderCell>
                      <TableHeaderCell>{t("date")}</TableHeaderCell>
                      <TableHeaderCell>{t("errors")}</TableHeaderCell>
                      {hasRetryableErrors && (
                        <TableHeaderCell>{t("actions")}</TableHeaderCell>
                      )}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.map((error) => (
                      <TableRow key={error.id}>
                        <TableCell>{error.symbol}</TableCell>
                        <TableCell>{error.date}</TableCell>
                        <TableCell style={{ overflowWrap: "anywhere" }}>
                          {error.code === "market_bar_missing"
                            ? t("marketBarMissing")
                            : error.message}
                          {error.code && error.code !== "market_bar_missing"
                            ? ` (${error.code})`
                            : ""}
                        </TableCell>
                        {hasRetryableErrors && (
                          <TableCell>
                            {error.retryable && (
                              <Button
                                size="sm"
                                variant="ghost"
                                label={
                                  retryingId === error.id
                                    ? t("retryingWork")
                                    : t("retryWork")
                                }
                                isLoading={retryingId === error.id}
                                onClick={() => onRetry?.(error)}
                              />
                            )}
                            {!error.retryable && (
                              <span>{t("retryUnavailable")}</span>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </VStack>
            )}
            {hasMoreWork && <Banner status="info" title={t("moreWorkItems")} />}
          </VStack>
        </Collapsible>
      </VStack>
    </section>
  );
};
