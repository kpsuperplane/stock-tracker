import { useEffect, useState } from "react";
import { easternMarketDate, previousCalendarDate } from "../../shared/dates";
import { api, type BackfillJob } from "../api";

const inclusiveDays = (start: string, end: string) =>
  (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
    86_400_000 +
  1;
const terminal = new Set([
  "complete",
  "complete_with_errors",
  "failed",
  "paused",
]);
const statusLabels: Record<string, string> = {
  pending: "待处理",
  queued: "已排队",
  running: "进行中",
  processing: "处理中",
  complete: "已完成",
  complete_with_errors: "已完成（有错误）",
  paused: "已暂停",
  failed: "失败",
};
const statusLabel = (status: string) => statusLabels[status] ?? "未知状态";

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
      } catch {
        if (active) {
          setError("无法加载处理进度。");
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
      setError("请选择过去日期，起止日期均计入且最多 30 个日历日。");
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
    } catch {
      setError("无法启动历史回补。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1>历史回补</h1>
        </div>
      </header>
      <form className="admin-form" onSubmit={submit}>
        <div className="date-grid">
          <label htmlFor="start-date">
            开始日期
            <input
              id="start-date"
              aria-label="开始日期"
              type="date"
              max={latestDate}
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              required
            />
          </label>
          <label htmlFor="end-date">
            结束日期
            <input
              id="end-date"
              aria-label="结束日期"
              type="date"
              max={latestDate}
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              required
            />
          </label>
        </div>
        <p className="form-help">
          仅限过去日期 · 包含起止日 · 最多 30 个日历日
        </p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={reprocessExisting}
            onChange={(event) => setReprocessExisting(event.target.checked)}
          />
          重新处理已有报告
        </label>
        <button type="submit" disabled={submitting}>
          {submitting ? "正在启动…" : "开始回补"}
        </button>
        {error && <p role="alert">{error}</p>}
      </form>
      {job && (
        <section className="job-status" role="status">
          <div className="page-header">
            <h2>{statusLabel(job.status)}</h2>
            <strong>
              {job.dates_processed}/{job.dates_total} 个日期
            </strong>
          </div>
          <progress
            aria-label="历史回补日期进度"
            max={Math.max(job.dates_total, 1)}
            value={job.dates_processed}
          />
          <p>
            {job.ticker_jobs_processed}/{job.ticker_jobs_total} 个标的任务 ·{" "}
            {job.ticker_jobs_failed} 个失败
          </p>
          <div className="table-scroll">
            <table
              className="portfolio-table job-table"
              aria-label="回补运行记录"
            >
              <thead>
                <tr>
                  <th scope="col">日期</th>
                  <th scope="col">状态</th>
                  <th scope="col">失败数</th>
                </tr>
              </thead>
              <tbody>
                {job.runs.map((run) => (
                  <tr key={run.tradingDate}>
                    <td>{run.tradingDate}</td>
                    <td>{statusLabel(run.status)}</td>
                    <td>{run.tickersFailed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {job.errors.length > 0 && (
            <div className="job-errors">
              <h3>错误</h3>
              <div className="table-scroll">
                <table
                  className="portfolio-table error-table"
                  aria-label="回补错误"
                >
                  <thead>
                    <tr>
                      <th scope="col">标的</th>
                      <th scope="col">日期</th>
                      <th scope="col">错误</th>
                      <th scope="col">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job.errors.map((jobError) => (
                      <tr key={jobError.workItemId ?? jobError.screeningId}>
                        <td>
                          <strong>{jobError.symbol}</strong>
                        </td>
                        <td>{jobError.tradingDate}</td>
                        <td>
                          {jobError.errorMessage ??
                            jobError.errorCode ??
                            "筛选失败"}
                        </td>
                        <td>
                          {jobError.retryable && (
                            <button
                              type="button"
                              disabled={
                                retrying ===
                                (jobError.workItemId ?? jobError.screeningId)
                              }
                              onClick={() => {
                                const retryId =
                                  jobError.workItemId ?? jobError.screeningId;
                                setRetrying(retryId);
                                const retryRequest =
                                  job.pipeline_job_id && jobError.workItemId
                                    ? api.retryBackfill(
                                        job.pipeline_job_id,
                                        jobError.workItemId,
                                      )
                                    : api.retry(jobError.screeningId);
                                void retryRequest
                                  .then(() => setRetrying(null))
                                  .catch(() => {
                                    setRetrying(null);
                                    setError("无法重试分析。");
                                  });
                              }}
                            >
                              {retrying ===
                              (jobError.workItemId ?? jobError.screeningId)
                                ? "正在重试…"
                                : "重试分析"}
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
      )}
    </>
  );
};
