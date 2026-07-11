import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { JobReadModelDto } from "../../shared/contracts";
import type { BackfillJob } from "../api";
import { I18nProvider } from "../i18n/I18nProvider";
import {
  groupJobs,
  JobProgress,
  jobErrors,
  jobProgressCounts,
  jobTriggerType,
  sortJobsNewestFirst,
  terminalJobStatuses,
} from "./JobProgress";

const backfillJob: BackfillJob = {
  id: "backfill-1",
  pipeline_job_id: "pipeline-1",
  created_at: "2026-07-10T12:00:00.000Z",
  triggerType: "backfill",
  status: "complete_with_errors",
  dates_total: 2,
  dates_processed: 2,
  ticker_jobs_total: 12,
  ticker_jobs_processed: 11,
  ticker_jobs_failed: 1,
  work_reused: 3,
  work_skipped: 2,
  work_fetched: 4,
  work_analyzed: 2,
  work_processed: 11,
  work_failed: 1,
  runs: [
    {
      tradingDate: "2026-07-09",
      status: "complete_with_errors",
      tickersFailed: 1,
    },
  ],
  errors: [
    {
      workItemId: "work-1",
      screeningId: "screening-1",
      symbol: "AAPL",
      tradingDate: "2026-07-09",
      errorCode: "provider_503",
      errorMessage:
        "Provider returned a very long error that should wrap safely.",
      retryable: true,
    },
  ],
};

const automaticJob: JobReadModelDto = {
  id: "pipeline-2",
  triggerType: "ledger_reconciliation",
  requestedStartDate: "2026-07-10",
  requestedEndDate: "2026-07-10",
  priority: 100,
  status: "running",
  createdAt: "2026-07-11T12:00:00.000Z",
  updatedAt: "2026-07-11T12:00:00.000Z",
  progress: {
    workTotal: 10,
    workReused: 4,
    workSkipped: 1,
    workFetched: 2,
    workAnalyzed: 2,
    workProcessed: 4,
    workFailed: 0,
  },
  work: [],
  errors: [],
  nextCursor: null,
};

describe("JobProgress", () => {
  it("renders compact progress counts, partial status, long errors, and retry affordance", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <JobProgress
          job={backfillJob}
          onRetry={() => undefined}
          retryingId="work-1"
        />
      </I18nProvider>,
    );

    expect(markup).toContain("Manual backfills");
    expect(markup).toContain("Complete with errors");
    expect(markup).toContain("Reused: 3");
    expect(markup).toContain("Skipped: 2");
    expect(markup).toContain("Fetched: 4");
    expect(markup).toContain("Analyzed: 2");
    expect(markup).toContain("Processed: 11");
    expect(markup).toContain("Provider returned a very long error");
    expect(markup).toContain("Retrying…");
    expect(markup).toContain('role="progressbar"');
    expect(markup).toContain('role="status" aria-live="polite"');
  });

  it("groups automatic reconciliation jobs and translates static labels", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="cn">
        <JobProgress job={automaticJob} />
      </I18nProvider>,
    );
    expect(markup).toContain("自动对账");
    expect(markup).toContain("复用: 4");
    expect(markup).toContain("已获取: 2");
    expect(markup).not.toContain("Automatic reconciliation");
  });

  it("signals when the work detail page has more items", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <JobProgress job={{ ...automaticJob, nextCursor: "next-work" }} />
      </I18nProvider>,
    );
    expect(markup).toContain("This job has more work items than shown.");
  });

  it("explains when list results intentionally omit row details", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <JobProgress job={{ ...backfillJob, details_truncated: true }} />
      </I18nProvider>,
    );
    expect(markup).toContain(
      "Summary view: run and error details load when you open an active job.",
    );
  });

  it("offers a bounded detail load for summary-only legacy rows", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <JobProgress
          job={{ ...backfillJob, details_truncated: true }}
          onLoadDetails={() => undefined}
        />
      </I18nProvider>,
    );
    expect(markup).toContain("Load details");
    expect(markup).toContain('type="button"');
  });

  it("normalizes job sources and retryable errors", () => {
    expect(jobTriggerType(backfillJob)).toBe("backfill");
    expect(jobTriggerType(automaticJob)).toBe("ledger_reconciliation");
    expect(groupJobs([backfillJob, automaticJob])).toEqual({
      manual: [backfillJob],
      automatic: [automaticJob],
    });
    expect(jobProgressCounts(backfillJob).workReused).toBe(3);
    expect(jobErrors(backfillJob)[0]).toMatchObject({
      id: "work-1",
      retryable: true,
      code: "provider_503",
    });
    expect(jobErrors(automaticJob)).toEqual([]);
    expect(terminalJobStatuses.has("complete_with_errors")).toBe(true);
    expect(terminalJobStatuses.has("skipped")).toBe(true);
    expect(terminalJobStatuses.has("terminal")).toBe(true);
    expect(terminalJobStatuses.has("running")).toBe(false);
  });

  it("sorts mixed job sources newest-first with an id tie-break", () => {
    const tieDate = "2026-07-10T12:00:00.000Z";
    expect(
      sortJobsNewestFirst([
        backfillJob,
        { ...automaticJob, id: "pipeline-a", createdAt: tieDate },
        { ...automaticJob, id: "pipeline-z", createdAt: tieDate },
      ]).map((job) => job.id),
    ).toEqual(["pipeline-z", "pipeline-a", "backfill-1"]);
  });
});
