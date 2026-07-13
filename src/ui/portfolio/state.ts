import type {
  PortfolioMetric,
  PortfolioRangePreset,
} from "../../shared/contracts";

export interface PortfolioUrlState {
  metric: PortfolioMetric;
  range: PortfolioRangePreset;
  currency?: "CAD" | "USD";
  startDate?: string;
  endDate?: string;
}

export const defaultPortfolioUrlState: PortfolioUrlState = {
  metric: "totalValue",
  range: "1y",
};

const metrics = new Set<PortfolioMetric>([
  "totalValue",
  "bookValue",
  "realizedGains",
  "unrealizedGains",
  "dividends",
]);

const ranges = new Set<PortfolioRangePreset>([
  "today",
  "1w",
  "30d",
  "3m",
  "ytd",
  "1y",
  "all",
  "custom",
]);

const isIsoDate = (value: string | null): value is string =>
  value !== null &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(`${value}T12:00:00Z`));

export const parsePortfolioUrlState = (
  search = typeof window === "undefined" ? "" : window.location.search,
): PortfolioUrlState => {
  const query = new URLSearchParams(search);
  const metric = query.get("metric") as PortfolioMetric | null;
  const range = query.get("range") as PortfolioRangePreset | null;
  const currency = query.get("currency");
  const next: PortfolioUrlState = {
    metric: metric && metrics.has(metric) ? metric : "totalValue",
    range: range && ranges.has(range) ? range : "1y",
    ...(currency === "CAD" || currency === "USD" ? { currency } : {}),
  };
  if (next.range === "custom") {
    const startDate = query.get("startDate");
    const endDate = query.get("endDate");
    if (isIsoDate(startDate) && isIsoDate(endDate) && startDate <= endDate) {
      next.startDate = startDate;
      next.endDate = endDate;
    }
  }
  return next;
};

export const writePortfolioUrlState = (
  state: PortfolioUrlState,
  mode: "push" | "replace" = "push",
): void => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("metric", state.metric);
  url.searchParams.set("range", state.range);
  if (state.currency) url.searchParams.set("currency", state.currency);
  else url.searchParams.delete("currency");
  if (state.range === "custom" && state.startDate && state.endDate) {
    url.searchParams.set("startDate", state.startDate);
    url.searchParams.set("endDate", state.endDate);
  } else {
    url.searchParams.delete("startDate");
    url.searchParams.delete("endDate");
  }
  window.history[mode === "push" ? "pushState" : "replaceState"](
    {},
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
};
