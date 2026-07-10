import { useEffect, useState } from "react";
import { Nav } from "./components/Nav";
import { BackfillPage } from "./pages/BackfillPage";
import { HistoryPage } from "./pages/HistoryPage";
import { TodayPage } from "./pages/TodayPage";
import { WatchlistPage } from "./pages/WatchlistPage";

const route = () => window.location.hash.replace("#/", "") || "today";

export const App = () => {
  const [current, setCurrent] = useState(route());
  useEffect(() => {
    const listener = () => setCurrent(route());
    window.addEventListener("hashchange", listener);
    return () => window.removeEventListener("hashchange", listener);
  }, []);
  const page =
    current === "history" ? (
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
      <main className="shell">{page}</main>
      <footer className="site-footer">
        Personal research aid · Not investment advice
      </footer>
      <Nav current={current} />
    </>
  );
};
