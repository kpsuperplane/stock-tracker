import { useState } from "react";
import type { MoverDto } from "../../shared/contracts";
import { api } from "../api";

const confidenceLabel = {
  high: "高",
  medium: "中",
  low: "低",
} as const;

export const MoverCard = ({ mover }: { mover: MoverDto }) => {
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const gain = mover.changePct >= 0;
  const sourceLabel = `${expanded ? "收起" : "查看"} ${mover.sources.length} 条来源`;
  const unavailable = mover.analysisStatus === "unavailable";

  const retry = async () => {
    setRetrying(true);
    setRetryMessage(null);
    try {
      await api.retry(mover.screeningId);
      setRetryMessage("重试已加入队列");
    } catch {
      setRetryMessage("重试失败");
    } finally {
      setRetrying(false);
    }
  };

  return (
    <>
      <tr className="mover-row">
        <td className="ticker-cell">
          <strong>{mover.symbol}</strong>
          <small>
            {mover.companyName} · {mover.exchange}
          </small>
        </td>
        <td className="number-cell">
          {mover.currentPrice.toFixed(2)}
          <small>{mover.currency}</small>
        </td>
        <td className="number-cell">
          <strong className={gain ? "move move--up" : "move move--down"}>
            {gain ? "↑ +" : "↓ "}
            {mover.changePct.toFixed(2)}%
          </strong>
          <small>
            {gain ? "+" : ""}
            {mover.changeAmount.toFixed(2)}
          </small>
        </td>
        <td>
          {mover.confidence ? (
            <span className={`confidence confidence--${mover.confidence}`}>
              {confidenceLabel[mover.confidence]}
            </span>
          ) : (
            <span className="muted-value">—</span>
          )}
        </td>
        <td className="explanation-cell">
          {unavailable ? (
            <span className="explanation--unavailable">暂无异动说明</span>
          ) : (
            <span lang="zh-CN">
              {mover.explanationZhCn ?? "暂时无法确定明确催化因素。"}
            </span>
          )}
        </td>
        <td className="actions-cell">
          {mover.sources.length === 0 && (
            <span className="state-label">未找到相关来源</span>
          )}
          {mover.sources.length > 0 && mover.clearCatalyst === false && (
            <span className="state-label">无明确催化因素</span>
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
              className="button--secondary"
              disabled={retrying}
              onClick={() => void retry()}
            >
              {retrying ? "正在重试…" : "重试生成说明"}
            </button>
          )}
          {retryMessage && <span role="status">{retryMessage}</span>}
        </td>
      </tr>
      {expanded && (
        <tr className="sources-row">
          <td colSpan={6}>
            <ul className="sources">
              {mover.sources.map((source) => (
                <li key={`${source.url}-${source.title}`}>
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {source.title}
                  </a>
                  <small>
                    {source.publisher} ·{" "}
                    {new Date(source.publishedAt).toLocaleString("zh-CN")}
                    {source.cited ? " · 已引用" : ""}
                  </small>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  );
};
