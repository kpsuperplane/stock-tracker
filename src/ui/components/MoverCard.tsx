import { useState } from "react";
import type { MoverDto } from "../../shared/contracts";
import { api } from "../api";

const confidenceLabel = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
} as const;

export const MoverCard = ({ mover }: { mover: MoverDto }) => {
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const gain = mover.changePct >= 0;
  const sourceLabel = `${expanded ? "Hide" : "Show"} ${mover.sources.length} source${mover.sources.length === 1 ? "" : "s"}`;
  const unavailable = mover.analysisStatus === "unavailable";

  const retry = async () => {
    setRetrying(true);
    setRetryMessage(null);
    try {
      await api.retry(mover.screeningId);
      setRetryMessage("Retry queued");
    } catch (error) {
      setRetryMessage(error instanceof Error ? error.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <article className="mover-card">
      <header className="mover-card__header">
        <div>
          <h2>{mover.symbol}</h2>
          <p>
            {mover.companyName} · {mover.exchange} · {mover.currency}
          </p>
        </div>
        <strong className={gain ? "move move--up" : "move move--down"}>
          {gain ? "↑ +" : "↓ "}
          {mover.changePct.toFixed(2)}%
        </strong>
      </header>
      <p className="price">
        Close {mover.currentPrice.toFixed(2)} {mover.currency}
        <span>
          {gain ? "+" : ""}
          {mover.changeAmount.toFixed(2)}
        </span>
      </p>
      {unavailable ? (
        <p className="explanation explanation--unavailable">
          Explanation unavailable
        </p>
      ) : (
        <p lang="zh-CN" className="explanation">
          {mover.explanationZhCn ?? "暂时无法确定本次价格变动的明确催化因素。"}
        </p>
      )}
      <div className="card-meta">
        {mover.confidence && (
          <span className={`confidence confidence--${mover.confidence}`}>
            {confidenceLabel[mover.confidence]}
          </span>
        )}
        {mover.sources.length === 0 && (
          <span className="state-label">No relevant sources found</span>
        )}
        {mover.sources.length > 0 && mover.clearCatalyst === false && (
          <span className="state-label">No clear catalyst found</span>
        )}
        {mover.sources.length > 0 && (
          <button
            type="button"
            className="link-button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {sourceLabel}
          </button>
        )}
        {unavailable && (
          <button
            type="button"
            disabled={retrying}
            onClick={() => void retry()}
          >
            {retrying ? "Retrying…" : "Retry explanation"}
          </button>
        )}
      </div>
      {retryMessage && <p role="status">{retryMessage}</p>}
      {expanded && (
        <ul className="sources">
          {mover.sources.map((source) => (
            <li key={`${source.url}-${source.title}`}>
              <a href={source.url} target="_blank" rel="noreferrer noopener">
                {source.title}
              </a>
              <small>
                {source.publisher} ·{" "}
                {new Date(source.publishedAt).toLocaleString()}
                {source.cited ? " · cited" : ""}
              </small>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
};
