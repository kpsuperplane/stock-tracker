const items = [
  ["today", "Today"],
  ["history", "History"],
  ["watchlist", "Watchlist"],
  ["backfill", "Backfill"],
] as const;

export const Nav = ({ current }: { current: string }) => (
  <nav className="nav" aria-label="Primary">
    <div className="nav__inner">
      <a className="wordmark" href="#/today" aria-label="Close Move home">
        <span className="wordmark__mark" aria-hidden="true">
          ±5
        </span>
        <span>Close Move</span>
      </a>
      <div className="nav__links">
        {items.map(([route, label], index) => (
          <a
            key={route}
            href={`#/${route}`}
            aria-current={current === route ? "page" : undefined}
          >
            <span aria-hidden="true">0{index + 1}</span>
            {label}
          </a>
        ))}
      </div>
    </div>
  </nav>
);
