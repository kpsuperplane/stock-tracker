import { useEffect, useState } from "react";
import type { ReportDto, ReportSummaryDto } from "../../shared/contracts";
import { api } from "../api";
import { MoverTable } from "../components/MoverTable";

const formatTimelineDate = (date: string) => {
  const [year, month, day] = date.split("-");
  return {
    full: `${year}年${Number(month)}月${Number(day)}日`,
    monthDay: `${Number(month)}月${Number(day)}日`,
    year: `${year}年`,
  };
};

export const HistoryPage = () => {
  const [dates, setDates] = useState<ReportSummaryDto[]>([]);
  const [report, setReport] = useState<ReportDto | null>(null);
  const [selectedDate, setSelectedDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void api
      .history()
      .then(async ({ reports }) => {
        if (!active) return;
        setDates(reports);
        if (reports[0]) {
          setSelectedDate(reports[0].tradingDate);
          const value = await api.report(reports[0].tradingDate);
          if (active) setReport(value.report);
        }
      })
      .catch(() => {
        if (active) {
          setError("无法加载历史报告。");
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const selectDate = async (date: string) => {
    setSelectedDate(date);
    setLoading(true);
    setError(null);
    try {
      setReport((await api.report(date)).report);
    } catch {
      setError("无法加载报告。");
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <div>
          <h1>历史报告</h1>
        </div>
      </header>
      {dates.length > 0 && (
        <ol className="history-timeline" aria-label="历史报告时间线">
          {dates.map((run) => (
            <li key={run.id}>
              <button
                type="button"
                className="timeline-day"
                aria-label={`${formatTimelineDate(run.tradingDate).full}，${run.tickersQualified} 个异动`}
                aria-pressed={selectedDate === run.tradingDate}
                onClick={() => void selectDate(run.tradingDate)}
              >
                <span className="timeline-date">
                  <strong>
                    {formatTimelineDate(run.tradingDate).monthDay}
                  </strong>
                  <small>{formatTimelineDate(run.tradingDate).year}</small>
                </span>
                <strong>{run.tickersQualified}</strong>
                <small>个异动</small>
              </button>
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p className="inline-alert" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <section className="state-panel state-panel--loading" role="status">
          <h2>正在加载历史报告</h2>
          <div className="skeleton" aria-hidden="true">
            <span />
            <span />
          </div>
        </section>
      )}
      {!loading && dates.length === 0 && (
        <section className="empty-state">
          <span className="empty-state__mark" aria-hidden="true">
            00
          </span>
          <div>
            <strong>暂无已发布报告</strong>
            <p>已完成的每日简报将显示在这里。</p>
          </div>
        </section>
      )}
      {report && report.movers.length > 0 && (
        <MoverTable label="每日行情" movers={report.movers} />
      )}
    </>
  );
};
