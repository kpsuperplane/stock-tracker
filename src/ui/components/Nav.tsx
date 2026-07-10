const items = [
  ["today", "今日简报"],
  ["history", "历史报告"],
  ["watchlist", "观察列表"],
  ["backfill", "历史回补"],
] as const;

export const Nav = () => (
  <nav className="nav" aria-label="主导航">
    <div className="nav__inner">
      <a className="wordmark" href="#today" aria-label="收盘异动首页">
        <span className="wordmark__mark" aria-hidden="true">
          ±5
        </span>
        <strong>收盘异动</strong>
      </a>
      <div className="nav__links">
        {items.map(([route, label]) => (
          <a key={route} href={`#${route}`}>
            {label}
          </a>
        ))}
      </div>
    </div>
  </nav>
);
