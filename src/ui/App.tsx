import { isNewProductUiEnabled } from "./featureFlags";
import { BackfillPage } from "./pages/BackfillPage";
import { HistoryPage } from "./pages/HistoryPage";
import { WatchlistPage } from "./pages/WatchlistPage";
import { ProductApp } from "./system/AppShell";

const LegacyApp = () => (
  <div className="legacy-app">
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
          <BackfillPage legacy />
        </section>
      </div>
    </main>
  </div>
);

export const App = () =>
  isNewProductUiEnabled() ? <ProductApp /> : <LegacyApp />;
