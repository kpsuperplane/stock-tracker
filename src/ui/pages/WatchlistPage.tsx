import { useCallback, useEffect, useState } from "react";
import { api, type Ticker } from "../api";

export const WatchlistPage = () => {
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [symbol, setSymbol] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setTickers((await api.tickers()).tickers);
  }, []);
  useEffect(() => {
    void load()
      .catch(() => setError("无法加载观察列表。"))
      .finally(() => setLoading(false));
  }, [load]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.addTicker(symbol.trim().toUpperCase());
      setSymbol("");
      await load();
    } catch {
      setError("无法添加标的，请检查代码后重试。");
    } finally {
      setBusy(false);
    }
  };

  const update = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
      await load();
    } catch {
      setError("无法更新观察列表。");
    }
  };

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">跟踪标的</p>
          <h1>观察列表</h1>
        </div>
        <span>
          {tickers.filter((ticker) => ticker.active).length}/100 个已启用
        </span>
      </header>
      <form className="admin-form" onSubmit={submit}>
        <label htmlFor="symbol">Yahoo 代码</label>
        <div className="field-row">
          <input
            id="symbol"
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            placeholder="AAPL、SHOP.TO 或 WELL.V"
            maxLength={20}
            autoCapitalize="characters"
            required
          />
          <button type="submit" disabled={busy}>
            {busy ? "正在验证…" : "添加标的"}
          </button>
        </div>
        <p className="form-help">
          保存前会使用 Yahoo Finance 近期日线数据验证代码。
        </p>
        {error && <p role="alert">{error}</p>}
      </form>
      {loading && (
        <section className="empty-state" role="status">
          <span className="empty-state__mark" aria-hidden="true">
            ···
          </span>
          <div>
            <strong>正在加载观察列表</strong>
            <p>正在检查跟踪标的。</p>
          </div>
        </section>
      )}
      {!loading && tickers.length === 0 && !error && (
        <section className="empty-state">
          <span className="empty-state__mark" aria-hidden="true">
            +
          </span>
          <div>
            <strong>建立跟踪范围</strong>
            <p>添加美股或加股的 Yahoo 代码即可开始跟踪。</p>
          </div>
        </section>
      )}
      {tickers.length > 0 && (
        <div className="table-scroll">
          <table
            className="portfolio-table watchlist-table"
            aria-label="观察列表数据"
          >
            <thead>
              <tr>
                <th scope="col">代码</th>
                <th scope="col">公司</th>
                <th scope="col">市场</th>
                <th scope="col">币种</th>
                <th scope="col">状态</th>
                <th scope="col">操作</th>
              </tr>
            </thead>
            <tbody>
              {tickers.map((ticker) => (
                <tr key={ticker.id}>
                  <td className="ticker-cell">
                    <strong>{ticker.symbol}</strong>
                  </td>
                  <td>{ticker.companyName}</td>
                  <td>{ticker.exchange}</td>
                  <td>{ticker.currency}</td>
                  <td>{ticker.active ? "已启用" : "已停用"}</td>
                  <td className="actions-cell">
                    <button
                      type="button"
                      className="button--secondary"
                      onClick={() =>
                        void update(() =>
                          api.setTickerActive(ticker.id, !ticker.active),
                        )
                      }
                    >
                      {ticker.active ? "停用" : "启用"}
                    </button>
                    <button
                      type="button"
                      className="button--danger"
                      onClick={() =>
                        void update(() => api.removeTicker(ticker.id))
                      }
                    >
                      移除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
};
