import { useState } from "react";
import type { MoverDto } from "../../shared/contracts";
import { api } from "../api";

export const MoverCard = ({ mover }: { mover: MoverDto }) => {
  const [expanded, setExpanded] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [retryMessage, setRetryMessage] = useState<string | null>(null);
  const gain = mover.changePct !== null && mover.changePct >= 0;
  const qualified = mover.qualified === true;
  const sourceLabel = `${expanded ? "收起" : "查看"} ${mover.sources.length} 条来源`;
  const unavailable = qualified && mover.analysisStatus === "unavailable";

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
          {mover.currentPrice === null ? "—" : mover.currentPrice.toFixed(2)}
          {mover.currentPrice !== null && <small>{mover.currency}</small>}
        </td>
        <td className="number-cell">
          {mover.changePct === null ? (
            <span className="muted-value">—</span>
          ) : (
            <strong className={gain ? "move move--up" : "move move--down"}>
              {gain ? "↑ +" : "↓ "}
              {mover.changePct.toFixed(2)}%
            </strong>
          )}
          {mover.changeAmount !== null && (
            <small>
              {gain ? "+" : ""}
              {mover.changeAmount.toFixed(2)}
            </small>
          )}
        </td>
        <td className="explanation-cell">
          {!qualified ? (
            <span className="muted-value">—</span>
          ) : unavailable ? (
            <span className="explanation--unavailable">暂无异动说明</span>
          ) : (
            <span lang="zh-CN">{mover.explanationZhCn ?? "暂无异动说明"}</span>
          )}
        </td>
        <td className="actions-cell">
          {!qualified && <span className="muted-value">—</span>}
          {qualified && mover.sources.length === 0 && (
            <span className="state-label">未找到相关来源</span>
          )}
          {qualified && mover.sources.length > 0 && (
            <button
              type="button"
              className="link-button"
              aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}
            >
              {sourceLabel}
            </button>
          )}
          {qualified && unavailable && (
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
          <td colSpan={5}>
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
