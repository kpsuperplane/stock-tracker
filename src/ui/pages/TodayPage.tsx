import { useEffect, useState } from "react";
import type { ReportDto, ReportSummaryDto } from "../../shared/contracts";
import { api } from "../api";
import { MoverTable } from "../components/MoverTable";
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
      } catch {
        if (!active) return;
        setError("无法加载报告。");
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
        <p className="eyebrow">报告暂不可用</p>
        <h1>无法加载今日简报</h1>
        <p>{error}</p>
      </section>
    );
  if (payload === undefined)
    return (
      <section className="state-panel state-panel--loading" role="status">
        <p className="eyebrow">正在准备简报</p>
        <h1>正在加载报告</h1>
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
        <p className="eyebrow">每日简报</p>
        <h1>暂无报告</h1>
        <p>首次市场日处理完成后，简报将显示在这里。</p>
        <a className="text-link" href="#watchlist">
          查看观察列表
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
          <p className="eyebrow">每日简报</p>
          <h1>{displayedDate}</h1>
          {payload.currentRun && payload.report && (
            <p className="subtle">
              最新已发布报告：{payload.report.run.tradingDate}
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
            <strong>收盘平静</strong>
            <p>没有观察标的的涨跌幅超过 5%。</p>
          </div>
        </section>
      )}
      {payload.report && payload.report.movers.length > 0 && (
        <MoverTable label="今日异动" movers={payload.report.movers} />
      )}
    </>
  );
};
