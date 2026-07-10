const items = [
  ["today", "Daily brief"],
  ["history", "Archive"],
  ["watchlist", "Watchlist"],
  ["backfill", "Backfill"],
] as const;

export const Nav = () => (
  <nav className="nav" aria-label="Primary">
    <div className="nav__inner">
      <a className="wordmark" href="#today" aria-label="Close Move home">
        <span className="wordmark__mark" aria-hidden="true">
          ±5
        </span>
        <span className="wordmark__text">
          <strong>Close Move</strong>
          <small>Market movement notes</small>
        </span>
      </a>
      <div className="nav__links">
        {items.map(([route, label], index) => (
          <a key={route} href={`#${route}`}>
            <span aria-hidden="true">0{index + 1}</span>
            {label}
          </a>
        ))}
      </div>
      <p className="nav__note">US + Canada · Close-to-close · 5% threshold</p>
    </div>
  </nav>
);
