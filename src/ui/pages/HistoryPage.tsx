import { useEffect, useState } from "react";
import type { ReportDto, ReportSummaryDto } from "../../shared/contracts";
import { api } from "../api";
import { MoverCard } from "../components/MoverCard";
import { RunSummary } from "../components/RunSummary";

export const HistoryPage = () => {
  const [dates, setDates] = useState<ReportSummaryDto[]>([]);
  const [report, setReport] = useState<ReportDto | null>(null);
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
          const value = await api.report(reports[0].tradingDate);
          if (active) setReport(value.report);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(
            cause instanceof Error ? cause.message : "Could not load history.",
          );
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
    setLoading(true);
    setError(null);
    try {
      setReport((await api.report(date)).report);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not load report.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Published reports</p>
          <h1>History</h1>
        </div>
        {dates.length > 0 && (
          <select
            aria-label="Report date"
            value={report?.run.tradingDate ?? dates[0]?.tradingDate ?? ""}
            onChange={(event) => void selectDate(event.target.value)}
          >
            {dates.map((run) => (
              <option key={run.id} value={run.tradingDate}>
                {run.tradingDate}
              </option>
            ))}
          </select>
        )}
      </header>
      {error && (
        <p className="inline-alert" role="alert">
          {error}
        </p>
      )}
      {loading && (
        <section className="state-panel state-panel--loading" role="status">
          <p className="eyebrow">Archive</p>
          <h2>Loading history</h2>
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
            <strong>No published reports</strong>
            <p>Completed daily briefs will collect here.</p>
          </div>
        </section>
      )}
      {report && <RunSummary run={report.run} />}
      <section className="mover-grid" aria-label="Historical movers">
        {report?.movers.map((mover) => (
          <MoverCard key={mover.screeningId} mover={mover} />
        ))}
      </section>
    </>
  );
};
