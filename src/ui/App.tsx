import { BackfillPage } from "./pages/BackfillPage";
import { HistoryPage } from "./pages/HistoryPage";
import { WatchlistPage } from "./pages/WatchlistPage";

export const App = () => (
  <>
    <a className="skip-link" href="#main-content">
      跳至报告
    </a>
    <main id="main-content" className="dashboard" tabIndex={-1}>
      <section id="history" className="dashboard-section">
        <HistoryPage />
      </section>
      <div className="operations-grid">
        <section
          id="watchlist"
          className="dashboard-section dashboard-section--operation"
        >
          <WatchlistPage />
        </section>
        <section
          id="backfill"
          className="dashboard-section dashboard-section--operation"
        >
          <BackfillPage />
        </section>
      </div>
    </main>
    <footer className="site-footer">
      <span className="site-footer__brand">收盘异动</span>
      <span>私人市场研究笔记 · 不构成投资建议</span>
    </footer>
  </>
);
