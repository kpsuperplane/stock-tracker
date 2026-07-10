import { useEffect, useState } from "react";
import { easternMarketDate, previousCalendarDate } from "../../shared/dates";
import { api, type BackfillJob } from "../api";

const inclusiveDays = (start: string, end: string) =>
  (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
    86_400_000 +
  1;
const terminal = new Set(["complete", "complete_with_errors", "paused"]);

export const BackfillPage = () => {
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [reprocessExisting, setReprocessExisting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<BackfillJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);
  const today = easternMarketDate(new Date());
  const latestDate = previousCalendarDate(today);
  const jobStatus = job?.status;

  useEffect(() => {
    if (!jobId || (jobStatus && terminal.has(jobStatus))) return;
    let active = true;
    const poll = async () => {
      try {
        const result = await api.backfill(jobId);
        if (active) setJob(result.job);
      } catch (cause) {
        if (active) {
          setError(
            cause instanceof Error ? cause.message : "Could not load progress.",
          );
        }
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 5_000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [jobId, jobStatus]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const days = inclusiveDays(startDate, endDate);
    if (
      !startDate ||
      !endDate ||
      endDate > latestDate ||
      days < 1 ||
      days > 30
    ) {
      setError("Choose a past inclusive range of at most 30 calendar days.");
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.startBackfill({
        startDate,
        endDate,
        reprocessExisting,
      });
      setJob(null);
      setJobId(result.id);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not start backfill.",
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Historical processing</p>
          <h1>Backfill</h1>
        </div>
      </header>
      <form className="admin-form" onSubmit={submit}>
        <div className="date-grid">
          <label htmlFor="start-date">
            Start date
            <input
              id="start-date"
              aria-label="Start date"
              type="date"
              max={latestDate}
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              required
            />
          </label>
          <label htmlFor="end-date">
            End date
            <input
              id="end-date"
              aria-label="End date"
              type="date"
              max={latestDate}
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              required
            />
          </label>
        </div>
        <p className="form-help">
          Past dates only · inclusive range · maximum 30 calendar days
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={reprocessExisting}
            onChange={(event) => setReprocessExisting(event.target.checked)}
          />
          Reprocess existing reports
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? "Starting…" : "Start backfill"}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
      {job && (
        <section className="job-status" role="status">
          <div className="page-header">
            <h2>{job.status.replaceAll("_", " ")}</h2>
            <strong>
              {job.dates_processed}/{job.dates_total} dates
            </strong>
          </div>
          <progress
            aria-label="Backfill date progress"
            max={Math.max(job.dates_total, 1)}
            value={job.dates_processed}
          />
          <p>
            {job.ticker_jobs_processed}/{job.ticker_jobs_total} ticker jobs ·{" "}
            {job.ticker_jobs_failed} failed
          </p>
          <ul className="run-list">
            {job.runs.map((run) => (
              <li key={run.tradingDate}>
                <span>{run.tradingDate}</span>
                <span>
                  {run.status.replaceAll("_", " ")}
                  {run.tickersFailed > 0
                    ? ` · ${run.tickersFailed} failed`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
          {job.errors.length > 0 && (
            <div className="job-errors">
              <h3>Errors</h3>
              <ul className="run-list">
                {job.errors.map((jobError) => (
                  <li key={jobError.screeningId}>
                    <span>
                      <strong>{jobError.symbol}</strong> ·{" "}
                      {jobError.tradingDate}
                      <small>
                        {jobError.errorMessage ??
                          jobError.errorCode ??
                          "Screening failed"}
                      </small>
                    </span>
                    {jobError.retryable && (
                      <button
                        type="button"
                        disabled={retrying === jobError.screeningId}
                        onClick={() => {
                          setRetrying(jobError.screeningId);
                          void api
                            .retry(jobError.screeningId)
                            .then(() => setRetrying(null))
                            .catch((cause) => {
                              setRetrying(null);
                              setError(
                                cause instanceof Error
                                  ? cause.message
                                  : "Could not retry analysis.",
                              );
                            });
                        }}
                      >
                        {retrying === jobError.screeningId
                          ? "Retrying…"
                          : "Retry analysis"}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </>
  );
};
