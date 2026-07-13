import type {
  PortfolioHistoryPointDto,
  PortfolioMetric,
} from "../../shared/contracts";

const metricKeys: Record<PortfolioMetric, keyof PortfolioHistoryPointDto> = {
  totalValue: "totalValueDecimal",
  realizedGains: "realizedGainsDecimal",
  unrealizedGains: "unrealizedGainsDecimal",
  dividends: "dividendsDecimal",
};

const escapeCsvCell = (value: string | null): string => {
  const normalized = value ?? "";
  return /[",\r\n]/.test(normalized)
    ? `"${normalized.replaceAll('"', '""')}"`
    : normalized;
};

export const portfolioPointsCsv = (
  points: readonly PortfolioHistoryPointDto[],
  metric: PortfolioMetric,
): string => {
  const metricKey = metricKeys[metric];
  const rows = [
    ["date", metric, "status"],
    ...points.map((point) => [
      point.date,
      point[metricKey] as string | null,
      point.status,
    ]),
  ];
  return rows.map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
};

export const downloadPortfolioPoints = ({
  points,
  metric,
  startDate,
  endDate,
}: {
  points: readonly PortfolioHistoryPointDto[];
  metric: PortfolioMetric;
  startDate: string;
  endDate: string;
}): void => {
  if (typeof window === "undefined" || points.length === 0) return;

  const blob = new Blob([`\uFEFF${portfolioPointsCsv(points, metric)}`], {
    type: "text/csv;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `portfolio-${metric}-${startDate}-${endDate}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
};
