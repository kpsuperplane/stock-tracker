const items = [
  ["today", "Today"],
  ["history", "History"],
  ["watchlist", "Watchlist"],
  ["backfill", "Backfill"],
] as const;

export const Nav = ({ current }: { current: string }) => (
  <nav className="nav" aria-label="Primary">
    {items.map(([route, label]) => (
      <a
        key={route}
        href={`#/${route}`}
        aria-current={current === route ? "page" : undefined}
      >
        {label}
      </a>
    ))}
  </nav>
);
