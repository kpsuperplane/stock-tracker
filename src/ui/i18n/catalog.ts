export type Locale = "en" | "cn";

export const messageCatalog = {
  en: {
    appName: "Stock Ledger",
    navigation: "Navigation",
    portfolio: "Portfolio",
    events: "Events",
    calendar: "Calendar",
    backfill: "Backfill",
    language: "Language",
    english: "EN",
    chinese: "中文",
    collapseSidebar: "Collapse sidebar",
    portfolioDescription: "Today’s holdings and movements",
    eventsDescription: "Historical buy and sell events",
    calendarDescription: "Historical movers and dividends",
    backfillDescription: "Refresh historical market facts",
  },
  cn: {
    appName: "投资账本",
    navigation: "导航",
    portfolio: "投资组合",
    events: "事件",
    calendar: "日历",
    backfill: "回补",
    language: "语言",
    english: "EN",
    chinese: "中文",
    collapseSidebar: "折叠侧边栏",
    portfolioDescription: "今日持仓与涨跌",
    eventsDescription: "历史买入与卖出事件",
    calendarDescription: "历史异动与股息",
    backfillDescription: "刷新历史行情事实",
  },
} as const satisfies Record<Locale, Record<string, string>>;

export type MessageKey = keyof (typeof messageCatalog)["en"];
