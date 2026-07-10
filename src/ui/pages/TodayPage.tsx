import { useEffect, useState } from "react";
import type { ReportDto, ReportSummaryDto } from "../../shared/contracts";
import { api } from "../api";
import { MoverCard } from "../components/MoverCard";
import { RunSummary } from "../components/RunSummary";

type LatestPayload = {
  report: ReportDto | null;
  currentRun: ReportSummaryDto | null;
};

export const TodayPage = () => {
  const [payload, setPayload] = useState<LatestPayload>();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const load = async () => {
      try {
        const value = await api.latest();
        if (!active) return;
        setPayload(value);
        setError(null);
        if (value.currentRun) timer = window.setTimeout(load, 15_000);
      } catch (cause) {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : "Could not load report.");
        timer = window.setTimeout(load, 15_000);
      }
    };
    void load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (payload === undefined) return <p role="status">Loading report…</p>;
  if (payload.report === null && payload.currentRun === null) {
    return (
      <section className="empty-state">
        <h1>Daily movers</h1>
        <p>No completed reports yet.</p>
      </section>
    );
  }
  const displayedDate =
    payload.currentRun?.tradingDate ?? payload.report?.run.tradingDate;
  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Daily report</p>
          <h1>{displayedDate}</h1>
          {payload.currentRun && payload.report && (
            <p className="subtle">
              Latest published: {payload.report.run.tradingDate}
            </p>
          )}
        </div>
      </header>
      {payload.currentRun ? (
        <RunSummary run={payload.currentRun} />
      ) : payload.report ? (
        <RunSummary run={payload.report.run} />
      ) : null}
      {payload.report && payload.report.movers.length === 0 && (
        <p className="empty-state">No movers met the 5% threshold.</p>
      )}
      <section className="mover-grid" aria-label="Qualifying movers">
        {payload.report?.movers.map((mover) => (
          <MoverCard key={mover.screeningId} mover={mover} />
        ))}
      </section>
    </>
  );
};
