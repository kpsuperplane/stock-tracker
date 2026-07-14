import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StatusReadModelDto } from "../../shared/contracts";
import { I18nProvider } from "../i18n/I18nProvider";
import { StatusPage, shouldPollStatus, syncHealthFor } from "./StatusPage";

const status: StatusReadModelDto = {
  earningsCoverage: {
    provider: "alpha-vantage-earnings",
    coverageStartDate: "2026-07-01",
    coverageEndDate: "2026-10-01",
    observedAt: "2026-07-13T12:00:00.000Z",
    status: "current",
    errorCode: null,
    errorMessage: null,
    updatedAt: "2026-07-13T12:00:00.000Z",
  },
  reconciliation: {
    stockValues: {
      status: "current",
      total: 8,
      completed: 8,
      pending: 0,
      failed: 0,
      updatedAt: "2026-07-13T12:00:00.000Z",
      errorCode: null,
      errorMessage: null,
    },
    dividends: {
      status: "current",
      total: 2,
      completed: 2,
      pending: 0,
      failed: 0,
      updatedAt: "2026-07-13T12:00:00.000Z",
      errorCode: null,
      errorMessage: null,
    },
    financialReports: {
      status: "current",
      total: 2,
      completed: 2,
      pending: 0,
      failed: 0,
      updatedAt: "2026-07-13T12:00:00.000Z",
      errorCode: null,
      errorMessage: null,
    },
  },
  imports: [
    {
      id: "import-1",
      filename: "portfolio.csv",
      status: "committed",
      processedSymbols: 3,
      totalSymbols: 3,
      failedRows: 0,
      resultPipelineJobId: "job-import-1",
      terminalErrorCode: null,
      terminalErrorMessage: null,
      createdAt: "2026-07-13T11:50:00.000Z",
      updatedAt: "2026-07-13T11:55:00.000Z",
      completedAt: "2026-07-13T11:55:00.000Z",
    },
  ],
  jobs: [
    {
      id: "scheduled:portfolio:2026-07-13",
      triggerType: "scheduled",
      requestedStartDate: "2026-07-12",
      requestedEndDate: "2026-07-13",
      priority: 10,
      status: "complete",
      createdAt: "2026-07-13T11:58:00.000Z",
      updatedAt: "2026-07-13T12:01:00.000Z",
      progress: {
        workTotal: 8,
        workReused: 2,
        workSkipped: 1,
        workFetched: 4,
        workAnalyzed: 1,
        workProcessed: 8,
        workFailed: 0,
      },
      work: [],
      errors: [],
      nextCursor: null,
    },
  ],
  nextCursor: null,
};

describe("StatusPage", () => {
  it("summarizes healthy syncs and shows job outcomes", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <StatusPage initialStatus={status} />
      </I18nProvider>,
    );

    expect(markup).toContain('data-testid="status-page"');
    expect(markup).toContain("Up to date");
    expect(markup).toContain("Earnings calendar");
    expect(markup).toContain("Stock values");
    expect(markup).toContain("Dividends");
    expect(markup).toContain("Financial reports");
    expect(markup).toContain("Portfolio imports");
    expect(markup).toContain("portfolio.csv");
    expect(markup).toContain('href="/events"');
    expect(markup).toContain("job-import-1");
    expect(markup).toContain("8 / 8 facts reconciled");
    expect(markup).toContain("Scheduled sync");
    expect(markup).toContain("8 / 8");
    expect(markup).toContain("<table");
    expect(markup).toContain("status-job-table");
    expect(markup).toContain("Fetched");
    expect(markup).toContain("Failures");
  });

  it("surfaces provider and job errors as needs-attention details", () => {
    const earningsCoverage = status.earningsCoverage;
    const job = status.jobs[0];
    const imported = status.imports[0];
    if (!earningsCoverage || !job || !imported)
      throw new Error("status fixture incomplete");
    const failing: StatusReadModelDto = {
      ...status,
      earningsCoverage: {
        ...earningsCoverage,
        status: "stale",
        errorCode: "provider_rate_limited",
        errorMessage: "Alpha Vantage rate limit reached.",
      },
      imports: [
        {
          ...imported,
          status: "terminal",
          terminalErrorCode: "provider_retry_exhausted",
          terminalErrorMessage: "Provider retries were exhausted.",
          resultPipelineJobId: null,
        },
      ],
      jobs: [
        {
          ...job,
          status: "complete_with_errors",
          progress: { ...job.progress, workFailed: 1 },
          errors: [
            {
              workItemId: "work-1",
              code: "provider_unavailable",
              message: "Price provider unavailable.",
              effectiveDate: "2026-07-12",
            },
          ],
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <StatusPage initialStatus={failing} />
      </I18nProvider>,
    );

    expect(syncHealthFor(failing)).toBe("attention");
    expect(markup).toContain("Needs attention");
    expect(markup).toContain("Alpha Vantage rate limit reached.");
    expect(markup).toContain("Price provider unavailable.");
    expect(markup).toContain("Provider retries were exhausted.");
    expect(markup).toContain("View errors");
    expect(markup).toContain("Complete with errors");
    expect(markup).toContain('colSpan="9"');
  });

  it("gives active jobs precedence while a sync is running", () => {
    const job = status.jobs[0];
    if (!job) throw new Error("status fixture incomplete");
    expect(
      syncHealthFor({
        ...status,
        jobs: [{ ...job, status: "running" }],
      }),
    ).toBe("syncing");
  });

  it("polls and highlights an active localized import", () => {
    const imported = status.imports[0];
    if (!imported) throw new Error("import fixture incomplete");
    const active: StatusReadModelDto = {
      ...status,
      imports: [
        {
          ...imported,
          id: "active-import",
          status: "running",
          processedSymbols: 2,
          totalSymbols: 5,
          resultPipelineJobId: null,
          completedAt: null,
        },
      ],
    };
    expect(shouldPollStatus(active)).toBe(true);
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="cn">
        <StatusPage
          initialStatus={active}
          highlightedImportId="active-import"
        />
      </I18nProvider>,
    );
    expect(markup).toContain("投资组合导入");
    expect(markup).toContain("2 / 5");
    expect(markup).toContain('data-import-highlighted="true"');
  });

  it("surfaces domain reconciliation work in the overall health", () => {
    expect(
      syncHealthFor({
        ...status,
        reconciliation: {
          ...status.reconciliation,
          dividends: {
            ...status.reconciliation.dividends,
            status: "attention",
            failed: 1,
            completed: 1,
          },
        },
      }),
    ).toBe("attention");
  });
});
