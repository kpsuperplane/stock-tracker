import { useEffect, useState } from "react";
import { Nav } from "./components/Nav";
import { BackfillPage } from "./pages/BackfillPage";
import { HistoryPage } from "./pages/HistoryPage";
import { TodayPage } from "./pages/TodayPage";
import { WatchlistPage } from "./pages/WatchlistPage";

const route = () => window.location.hash.replace("#/", "") || "today";
const routes = new Set(["today", "history", "watchlist", "backfill"]);

const NotFoundPage = () => (
  <section className="state-panel state-panel--spacious">
    <p className="eyebrow">Unknown route</p>
    <h1>Page not found</h1>
    <p>This view does not exist in the market brief.</p>
    <a className="text-link" href="#/today">
      Return to today
    </a>
  </section>
);

export const App = () => {
  const [current, setCurrent] = useState(route());
  useEffect(() => {
    const listener = () => setCurrent(route());
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  const page = !routes.has(current) ? (
    <NotFoundPage />
  ) : current === "history" ? (
    <HistoryPage />
  ) : current === "watchlist" ? (
    <WatchlistPage />
  ) : current === "backfill" ? (
    <BackfillPage />
  ) : (
    <TodayPage />
  );
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to report
      </a>
      <Nav current={current} />
      <main id="main-content" className="shell" tabIndex={-1}>
        {page}
      </main>
      <footer className="site-footer">
        <span className="site-footer__brand">Close Move</span>
        <span>Personal research aid · Not investment advice</span>
      </footer>
    </>
  );
};
