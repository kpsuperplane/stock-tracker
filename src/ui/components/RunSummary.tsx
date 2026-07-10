import type { ReportSummaryDto } from "../../shared/contracts";

export const RunSummary = ({ run }: { run: ReportSummaryDto }) => {
  const running = run.status === "pending" || run.status === "running";
  return (
    <section className="run-summary" aria-label="报告摘要">
      <div className="summary-metric">
        <span>异动标的</span>
        <strong>{run.tickersQualified}</strong>
      </div>
      <div className="summary-metric">
        <span>跟踪标的</span>
        <strong>{run.tickersTotal}</strong>
      </div>
      <div className="summary-metric summary-metric--status">
        <span>运行状态</span>
        <strong role={running ? "status" : undefined}>
          {running
            ? `${run.tickersProcessed}/${run.tickersTotal} 已处理`
            : run.status === "complete_with_errors"
              ? `已完成 · ${run.tickersFailed} 个失败`
              : "已完成"}
        </strong>
      </div>
      <div className="summary-metric">
        <span>筛选阈值</span>
        <strong>±5%</strong>
      </div>
    </section>
  );
};
