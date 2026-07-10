import { useEffect } from "react";
import { Nav } from "./components/Nav";
import { BackfillPage } from "./pages/BackfillPage";
import { HistoryPage } from "./pages/HistoryPage";
import { TodayPage } from "./pages/TodayPage";
import { WatchlistPage } from "./pages/WatchlistPage";

export const App = () => {
  useEffect(() => {
    const sections = document.querySelectorAll<HTMLElement>(".reveal");
    if (!("IntersectionObserver" in window)) {
      sections.forEach((section) => {
        section.classList.add("is-visible");
      });
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8%", threshold: 0.08 },
    );
    sections.forEach((section) => {
      observer.observe(section);
    });
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to report
      </a>
      <Nav />
      <main id="main-content" className="dashboard" tabIndex={-1}>
        <section
          id="today"
          className="dashboard-section dashboard-section--today reveal"
        >
          <TodayPage />
        </section>
        <section id="history" className="dashboard-section reveal">
          <HistoryPage />
        </section>
        <div className="operations-grid">
          <section
            id="watchlist"
            className="dashboard-section dashboard-section--operation reveal"
          >
            <WatchlistPage />
          </section>
          <section
            id="backfill"
            className="dashboard-section dashboard-section--operation reveal"
          >
            <BackfillPage />
          </section>
        </div>
      </main>
      <footer className="site-footer">
        <span className="site-footer__brand">Close Move</span>
        <span>Private market notes · Not investment advice</span>
      </footer>
    </>
  );
};
