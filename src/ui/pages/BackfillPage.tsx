import type { ISODateString } from "@astryxdesign/core";
import {
  Banner,
  Button,
  CheckboxInput,
  DateInput,
  FormLayout,
  Heading,
  HStack,
  VStack,
} from "@astryxdesign/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { easternMarketDate, previousCalendarDate } from "../../shared/dates";
import { ApiClientError, api, type BackfillJob } from "../api";
import {
  groupJobs,
  isReadModelJob,
  type JobError,
  JobProgress,
  type JobSource,
  sortJobsNewestFirst,
  terminalJobStatuses,
} from "../components/JobProgress";
import { useI18n } from "../i18n/I18nProvider";

export const inclusiveDays = (start: string, end: string) =>
  (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
    86_400_000 +
  1;
const terminal = terminalJobStatuses;

export type BackfillValidationKey =
  | "backfillRangeRequired"
  | "backfillRangeReversed"
  | "backfillRangeFuture"
  | "backfillRangeTooLong";

export const validateBackfillRange = (
  start: string,
  end: string,
  latestDate: string,
): BackfillValidationKey | null => {
  if (!start || !end) return "backfillRangeRequired";
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || start > end) {
    return "backfillRangeReversed";
  }
  if (end > latestDate) return "backfillRangeFuture";
  if (inclusiveDays(start, end) > 30) return "backfillRangeTooLong";
  return null;
};

export const isJobReadModelDisabledError = (error: unknown): boolean =>
  error instanceof ApiClientError &&
  error.status === 404 &&
  error.code === "read_model_disabled";

export interface BackfillPageApiClient {
  startBackfill: typeof api.startBackfill;
  backfill: typeof api.backfill;
  backfills: typeof api.backfills;
  jobs: typeof api.jobs;
  job: typeof api.job;
  retryBackfill: typeof api.retryBackfill;
  retry: typeof api.retry;
}

const defaultBackfillApiClient: BackfillPageApiClient = {
  startBackfill: api.startBackfill,
  backfill: api.backfill,
  backfills: api.backfills,
  jobs: api.jobs,
  job: api.job,
  retryBackfill: api.retryBackfill,
  retry: api.retry,
};

export interface BackfillPageProps {
  apiClient?: BackfillPageApiClient;
  initialJobs?: JobSource[];
  today?: string;
}

const ProductBackfillPage = ({
  apiClient = defaultBackfillApiClient,
  initialJobs = [],
  today,
}: BackfillPageProps) => {
  const { t } = useI18n();
  const todayDate = today ?? easternMarketDate(new Date());
  const latestDate = previousCalendarDate(todayDate);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reprocessExisting, setReprocessExisting] = useState(false);
  const [jobs, setJobs] = useState<JobSource[]>(() =>
    sortJobsNewestFirst(initialJobs),
  );
  const jobsRef = useRef(jobs);
  const [jobsCursor, setJobsCursor] = useState<string | null>(null);
  const [legacyJobsCursor, setLegacyJobsCursor] = useState<string | null>(null);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [loadingMoreJobs, setLoadingMoreJobs] = useState(false);
  const [loadingDetailsJobId, setLoadingDetailsJobId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const invalidatedJobsRef = useRef(new Set<string>());

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  const mergeJobs = useCallback((loadedJobs: JobSource[]) => {
    setJobs((currentJobs) => {
      const merged = new Map(currentJobs.map((job) => [job.id, job]));
      for (const job of loadedJobs) {
        // Both endpoints can expose the same pipeline-backed backfill. Keep a
        // single row while allowing a later page to replace stale progress.
        merged.set(job.id, job);
      }
      return sortJobsNewestFirst([...merged.values()]);
    });
  }, []);

  useEffect(() => {
    let active = true;
    setLoadingJobs(true);
    void Promise.allSettled([apiClient.jobs(25), apiClient.backfills(25)])
      .then(([pipelineResult, legacyResult]) => {
        if (!active) return;
        let hasError = false;
        if (pipelineResult.status === "fulfilled") {
          mergeJobs(pipelineResult.value.jobs);
          setJobsCursor(pipelineResult.value.nextCursor);
        } else if (!isJobReadModelDisabledError(pipelineResult.reason)) {
          hasError = true;
          setJobsCursor(null);
        } else {
          setJobsCursor(null);
        }
        if (legacyResult.status === "fulfilled") {
          mergeJobs(legacyResult.value.jobs);
          setLegacyJobsCursor(legacyResult.value.nextCursor);
        } else {
          hasError = true;
          setLegacyJobsCursor(null);
        }
        if (hasError) setError(t("backfillLoadError"));
        else setError(null);
        setPollError(null);
      })
      .finally(() => {
        if (active) setLoadingJobs(false);
      });
    return () => {
      active = false;
    };
  }, [apiClient, mergeJobs, t]);

  const loadMoreJobs = useCallback(async () => {
    if ((!jobsCursor && !legacyJobsCursor) || loadingMoreJobs) return;
    setLoadingMoreJobs(true);
    try {
      const requests = await Promise.allSettled([
        jobsCursor ? apiClient.jobs(25, jobsCursor) : null,
        legacyJobsCursor ? apiClient.backfills(25, legacyJobsCursor) : null,
      ]);
      let hasError = false;
      const pipelineResult = requests[0];
      if (pipelineResult.status === "fulfilled" && pipelineResult.value) {
        mergeJobs(pipelineResult.value.jobs);
        setJobsCursor(pipelineResult.value.nextCursor);
      } else if (
        pipelineResult.status === "rejected" &&
        !isJobReadModelDisabledError(pipelineResult.reason)
      ) {
        hasError = true;
      } else if (pipelineResult.status === "rejected") {
        setJobsCursor(null);
      } else if (pipelineResult.status === "fulfilled") {
        setJobsCursor(null);
      }
      const legacyResult = requests[1];
      if (legacyResult.status === "fulfilled" && legacyResult.value) {
        mergeJobs(legacyResult.value.jobs);
        setLegacyJobsCursor(legacyResult.value.nextCursor);
      } else if (legacyResult.status === "rejected") {
        hasError = true;
      }
      if (hasError) setError(t("backfillLoadError"));
      else setError(null);
      setPollError(null);
    } catch (caught: unknown) {
      if (isJobReadModelDisabledError(caught)) {
        setJobsCursor(null);
        setError(null);
        return;
      }
      setError(t("backfillLoadError"));
    } finally {
      setLoadingMoreJobs(false);
    }
  }, [apiClient, jobsCursor, legacyJobsCursor, loadingMoreJobs, mergeJobs, t]);

  const refreshJob = useCallback(
    async (job: JobSource): Promise<JobSource> => {
      if (isReadModelJob(job)) return (await apiClient.job(job.id)).job;
      return (await apiClient.backfill(job.id)).job;
    },
    [apiClient],
  );

  const loadJobDetails = useCallback(
    async (job: JobSource) => {
      setLoadingDetailsJobId(job.id);
      setError(null);
      try {
        const detail = isReadModelJob(job)
          ? (await apiClient.job(job.id)).job
          : (await apiClient.backfill(job.id)).job;
        setJobs((currentJobs) =>
          currentJobs.map((candidate) =>
            candidate.id === job.id ? detail : candidate,
          ),
        );
      } catch {
        setError(t("backfillLoadError"));
      } finally {
        setLoadingDetailsJobId(null);
      }
    },
    [apiClient, t],
  );

  const activeJobIds = jobs
    .filter((job) => !terminal.has(job.status))
    .map((job) => job.id)
    .sort()
    .join("|");

  useEffect(() => {
    if (!activeJobIds) return;
    const ids = activeJobIds.split("|");
    let active = true;
    const poll = async () => {
      const current = jobsRef.current;
      const results = await Promise.allSettled(
        ids.map(async (id) => {
          const existing = current.find((job) => job.id === id);
          if (!existing) return null;
          return [id, await refreshJob(existing)] as const;
        }),
      );
      if (!active) return;
      const replacements = new Map<string, JobSource>();
      let failed = false;
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          replacements.set(result.value[0], result.value[1]);
        } else if (result.status === "rejected") {
          failed = true;
        }
      }
      if (replacements.size > 0) {
        setJobs((currentJobs) =>
          currentJobs.map((job) => replacements.get(job.id) ?? job),
        );
      }
      if (failed) setPollError(t("backfillLoadError"));
      else setPollError(null);
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [activeJobIds, refreshJob, t]);

  useEffect(() => {
    let newlyTerminal = false;
    for (const job of jobs) {
      if (!terminal.has(job.status) || invalidatedJobsRef.current.has(job.id)) {
        continue;
      }
      invalidatedJobsRef.current.add(job.id);
      newlyTerminal = true;
    }
    if (newlyTerminal) {
      api.portfolio.clearCache?.();
      api.calendar.clearCache?.();
    }
  }, [jobs]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validationError = validateBackfillRange(
      startDate,
      endDate,
      latestDate,
    );
    if (validationError) {
      setError(t(validationError));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await apiClient.startBackfill({
        startDate,
        endDate,
        reprocessExisting,
      });
      const pendingJob: BackfillJob = {
        id: result.id,
        created_at: new Date().toISOString(),
        status: "queued",
        dates_total: inclusiveDays(startDate, endDate),
        dates_processed: 0,
        ticker_jobs_total: 0,
        ticker_jobs_processed: 0,
        ticker_jobs_failed: 0,
        runs: [],
        errors: [],
        pipeline_job_id: result.id,
        reprocess_existing: reprocessExisting,
      };
      setJobs((current) =>
        sortJobsNewestFirst([
          pendingJob,
          ...current.filter((job) => job.id !== result.id),
        ]),
      );
    } catch {
      setError(t("backfillStartError"));
    } finally {
      setSubmitting(false);
    }
  };

  const retry = async (job: JobSource, jobError: JobError) => {
    if (!jobError.retryable || isReadModelJob(job)) return;
    const retryKey = `${job.id}:${jobError.id}`;
    setRetrying(retryKey);
    setError(null);
    try {
      if (job.pipeline_job_id && jobError.workItemId) {
        await apiClient.retryBackfill(job.pipeline_job_id, jobError.workItemId);
      } else if (jobError.screeningId) {
        await apiClient.retry(jobError.screeningId);
      } else {
        throw new Error("retry_unavailable");
      }
      invalidatedJobsRef.current.delete(job.id);
      setJobs((current) =>
        current.map((candidate) =>
          candidate.id === job.id
            ? { ...candidate, status: "running" }
            : candidate,
        ),
      );
    } catch {
      setError(t("backfillRetryError"));
    } finally {
      setRetrying(null);
    }
  };

  const groups = groupJobs(jobs);
  const hasActiveJobs = jobs.some((job) => !terminal.has(job.status));
  const isoDate = (value: string) => value as ISODateString;
  const renderGroup = (title: string, group: JobSource[]) =>
    group.length > 0 ? (
      <section aria-labelledby={`${title}-heading`}>
        <VStack gap={2}>
          <Heading level={2} id={`${title}-heading`}>
            {title === "manual"
              ? t("manualBackfills")
              : t("automaticReconciliation")}
          </Heading>
          {group.map((job, index) => (
            <JobProgress
              key={job.id}
              job={job}
              defaultIsOpen={index === 0}
              onRetry={(jobError) => void retry(job, jobError)}
              {...(!isReadModelJob(job) && job.details_truncated
                ? {
                    onLoadDetails: () => void loadJobDetails(job),
                    loadingDetails: loadingDetailsJobId === job.id,
                  }
                : {})}
              retryingId={
                retrying?.startsWith(`${job.id}:`)
                  ? retrying.slice(job.id.length + 1)
                  : null
              }
            />
          ))}
        </VStack>
      </section>
    ) : null;

  return (
    <VStack gap={3} data-testid="backfill-page">
      <VStack gap={0.5}>
        <Heading level={1}>{t("backfillHeading")}</Heading>
      </VStack>

      <form onSubmit={(event) => void submit(event)}>
        <VStack gap={3}>
          <FormLayout direction="horizontal" className="backfill-date-layout">
            <DateInput
              label={t("backfillStartDate")}
              placeholder={t("datePlaceholder")}
              {...(startDate ? { value: isoDate(startDate) } : {})}
              onChange={(value) => setStartDate(value ?? "")}
              isRequired
              max={isoDate(latestDate)}
              size="sm"
            />
            <DateInput
              label={t("backfillEndDate")}
              placeholder={t("datePlaceholder")}
              {...(endDate ? { value: isoDate(endDate) } : {})}
              onChange={(value) => setEndDate(value ?? "")}
              isRequired
              max={isoDate(latestDate)}
              size="sm"
            />
          </FormLayout>
          <div>{t("backfillDateHelp")}</div>
          <HStack gap={2} align="center" wrap="wrap">
            <CheckboxInput
              label={t("backfillReprocessMode")}
              description={t("backfillReprocessDescription")}
              value={reprocessExisting}
              onChange={setReprocessExisting}
              size="sm"
            />
          </HStack>
          <Button
            type="submit"
            variant="primary"
            label={submitting ? t("startingBackfill") : t("startBackfill")}
            isLoading={submitting}
          />
        </VStack>
      </form>

      {(error ?? pollError) && (
        <Banner status="error" title={error ?? pollError ?? ""} />
      )}
      {hasActiveJobs && (
        <Banner
          status="info"
          title={t("backgroundContinuation")}
          description={t("backgroundContinuationDescription")}
        />
      )}
      {loadingJobs && jobs.length === 0 && (
        <Banner status="info" title={t("loadingBackfillJobs")} />
      )}
      {!loadingJobs && jobs.length === 0 && (
        <Banner status="info" title={t("backfillNoJobs")} />
      )}
      {renderGroup("manual", groups.manual)}
      {renderGroup("automatic", groups.automatic)}
      {(jobsCursor || legacyJobsCursor) && (
        <HStack gap={2} align="center" wrap="wrap">
          <span>{t("backfillMoreJobs")}</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            label={
              loadingMoreJobs
                ? t("loadingMoreBackfillJobs")
                : t("loadMoreBackfillJobs")
            }
            isLoading={loadingMoreJobs}
            onClick={() => void loadMoreJobs()}
          />
        </HStack>
      )}
    </VStack>
  );
};

export const BackfillPage = (props: BackfillPageProps) => (
  <ProductBackfillPage {...props} />
);
