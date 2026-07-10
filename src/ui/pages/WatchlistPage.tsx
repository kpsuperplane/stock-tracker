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
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Could not load watchlist.",
        ),
      )
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
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not add ticker.",
      );
    } finally {
      setBusy(false);
    }
  };

  const update = async (action: () => Promise<void>) => {
    setError(null);
    try {
      await action();
      await load();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Watchlist update failed.",
      );
    }
  };

  return (
    <>
      <header className="page-header">
        <div>
          <p className="eyebrow">Tracked symbols</p>
          <h1>Watchlist</h1>
        </div>
        <span>
          {tickers.filter((ticker) => ticker.active).length}/100 active
        </span>
      </header>
      <form className="admin-form" onSubmit={submit}>
        <label htmlFor="symbol">Yahoo symbol</label>
        <div className="field-row">
          <input
            id="symbol"
            value={symbol}
            onChange={(event) => setSymbol(event.target.value)}
            placeholder="AAPL, SHOP.TO, or WELL.V"
            maxLength={20}
            autoCapitalize="characters"
            required
          />
          <button type="submit" disabled={busy}>
            {busy ? "Validating…" : "Add ticker"}
          </button>
        </div>
        <p className="form-help">
          Symbols are validated against recent Yahoo Finance daily data before
          saving.
        </p>
        {error && <p role="alert">{error}</p>}
      </form>
      {loading && (
        <section className="empty-state" role="status">
          <span className="empty-state__mark" aria-hidden="true">
            ···
          </span>
          <div>
            <strong>Loading watchlist</strong>
            <p>Checking tracked symbols.</p>
          </div>
        </section>
      )}
      {!loading && tickers.length === 0 && !error && (
        <section className="empty-state">
          <span className="empty-state__mark" aria-hidden="true">
            +
          </span>
          <div>
            <strong>Build your coverage list</strong>
            <p>Add a US or Canadian Yahoo symbol to begin tracking it.</p>
          </div>
        </section>
      )}
      <ul className="ticker-list">
        {tickers.map((ticker) => (
          <li key={ticker.id}>
            <div>
              <strong>{ticker.symbol}</strong>
              <small>
                {ticker.companyName} · {ticker.exchange} · {ticker.currency}
              </small>
            </div>
            <div className="field-row">
              <button
                type="button"
                className="button--secondary"
                onClick={() =>
                  void update(() =>
                    api.setTickerActive(ticker.id, !ticker.active),
                  )
                }
              >
                {ticker.active ? "Disable" : "Enable"}
              </button>
              <button
                type="button"
                className="button--danger"
                onClick={() => void update(() => api.removeTicker(ticker.id))}
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
};
