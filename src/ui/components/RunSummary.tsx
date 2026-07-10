import type { ReportSummaryDto } from "../../shared/contracts";

export const RunSummary = ({ run }: { run: ReportSummaryDto }) => {
  const running = run.status === "pending" || run.status === "running";
  return (
    <section className="run-summary" aria-label="Report summary">
      <div>
        <strong>{run.tickersQualified}</strong>
        <span>of {run.tickersTotal} tickers moved ≥5%</span>
      </div>
      <p role={running ? "status" : undefined}>
        {running
          ? `${run.tickersProcessed}/${run.tickersTotal} processed`
          : run.status === "complete_with_errors"
            ? `Complete · ${run.tickersFailed} failed`
            : "Complete"}
      </p>
    </section>
  );
};
