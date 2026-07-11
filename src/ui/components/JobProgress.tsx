import {
  Badge,
  Banner,
  Button,
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
  onRetry?: (error: JobError) => void;
  retryingId?: string | null;
}

export const JobProgress = ({
  job,
  onRetry,
  retryingId = null,
}: JobProgressProps) => {
  const { t } = useI18n();
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
  const statusKey = statusCopyKey(job.status);
  const hasMoreWork = isReadModelJob(job) && job.nextCursor !== null;
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
            <span>{job.id}</span>
          </VStack>
          <Badge variant={statusVariant(job.status)} label={t(statusKey)} />
        </HStack>

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
        <HStack gap={1} wrap="wrap">
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
            <Table density="compact" dividers="rows" textOverflow="wrap">
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
        ) : (
          <span>{t("noRunHistory")}</span>
        )}

        {errors.length > 0 && (
          <Banner
            status="error"
            title={`${t("jobErrors")} (${errors.length})`}
            defaultIsExpanded
          >
            <Table density="compact" dividers="rows" textOverflow="wrap">
              <TableHeader>
                <TableRow isHeaderRow>
                  <TableHeaderCell>{t("instrument")}</TableHeaderCell>
                  <TableHeaderCell>{t("date")}</TableHeaderCell>
                  <TableHeaderCell>{t("errors")}</TableHeaderCell>
                  {onRetry && <TableHeaderCell>{t("actions")}</TableHeaderCell>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {errors.map((error) => (
                  <TableRow key={error.id}>
                    <TableCell>{error.symbol}</TableCell>
                    <TableCell>{error.date}</TableCell>
                    <TableCell style={{ overflowWrap: "anywhere" }}>
                      {error.message}
                      {error.code ? ` (${error.code})` : ""}
                    </TableCell>
                    {onRetry && (
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
                            onClick={() => onRetry(error)}
                          />
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Banner>
        )}
        {hasMoreWork && <Banner status="info" title={t("moreWorkItems")} />}
      </VStack>
    </section>
  );
};
