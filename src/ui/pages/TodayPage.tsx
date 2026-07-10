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
        setError(
          cause instanceof Error ? cause.message : "Could not load report.",
        );
        timer = window.setTimeout(load, 15_000);
      }
    };
    void load();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, []);
  if (error)
    return (
      <section className="state-panel state-panel--error" role="alert">
        <p className="eyebrow">Report unavailable</p>
        <h1>Couldn’t load the daily brief</h1>
        <p>{error}</p>
      </section>
    );
  if (payload === undefined)
    return (
      <section className="state-panel state-panel--loading" role="status">
        <p className="eyebrow">Preparing brief</p>
        <h1>Loading report</h1>
        <div className="skeleton" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      </section>
    );
  if (payload.report === null && payload.currentRun === null) {
    return (
      <section className="state-panel state-panel--spacious">
        <p className="eyebrow">Daily report</p>
        <h1>No reports yet</h1>
        <p>The first brief appears after a completed market-day run.</p>
        <a className="text-link" href="#/watchlist">
          Review watchlist
        </a>
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
        <section className="empty-state">
          <span className="empty-state__mark" aria-hidden="true">
            ±
          </span>
          <div>
            <strong>A quiet close</strong>
            <p>No tracked ticker moved beyond the 5% threshold.</p>
          </div>
        </section>
      )}
      <section className="mover-grid" aria-label="Qualifying movers">
        {payload.report?.movers.map((mover) => (
          <MoverCard key={mover.screeningId} mover={mover} />
        ))}
      </section>
    </>
  );
};
