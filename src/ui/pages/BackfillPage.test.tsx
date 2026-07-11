import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n/I18nProvider";
import {
  BackfillPage,
  inclusiveDays,
  validateBackfillRange,
} from "./BackfillPage";

describe("backfill range validation", () => {
  it("validates inclusive past ranges and the 30-day limit", () => {
    expect(inclusiveDays("2026-07-01", "2026-07-03")).toBe(3);
    expect(validateBackfillRange("", "2026-07-03", "2026-07-11")).toBe(
      "backfillRangeRequired",
    );
    expect(
      validateBackfillRange("2026-07-04", "2026-07-03", "2026-07-11"),
    ).toBe("backfillRangeReversed");
    expect(
      validateBackfillRange("2026-07-01", "2026-07-12", "2026-07-11"),
    ).toBe("backfillRangeFuture");
    expect(
      validateBackfillRange("2026-06-01", "2026-07-01", "2026-07-11"),
    ).toBe("backfillRangeTooLong");
    expect(
      validateBackfillRange("2026-07-01", "2026-07-10", "2026-07-11"),
    ).toBe(null);
  });
});

describe("BackfillPage", () => {
  it("renders ASTRYX controls, background continuation, and grouped jobs", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <BackfillPage
          today="2026-07-11"
          initialJobs={[
            {
              id: "manual-1",
              status: "running",
              dates_total: 1,
              dates_processed: 0,
              ticker_jobs_total: 1,
              ticker_jobs_processed: 0,
              ticker_jobs_failed: 0,
              runs: [],
              errors: [],
            },
          ]}
        />
      </I18nProvider>,
    );
    expect(markup).toContain('data-testid="backfill-page"');
    expect(markup).toContain("Backfill and reconciliation");
    expect(markup).toContain("Start date");
    expect(markup).toContain("Reprocess existing facts");
    expect(markup).toContain("Processing continues in the background.");
    expect(markup).toContain("Manual backfills");
    expect(markup).toContain('role="progressbar"');
  });

  it("preserves the legacy page behind the legacy prop", () => {
    const markup = renderToStaticMarkup(<BackfillPage legacy />);
    expect(markup).toContain("历史回补");
    expect(markup).not.toContain("Backfill and reconciliation");
  });
});
