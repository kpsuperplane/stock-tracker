import { useTheme } from "@astryxdesign/core";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  PortfolioHistoryPointDto,
  PortfolioMetric,
} from "../../shared/contracts";
import { useI18n } from "../i18n/I18nProvider";
import { formatDate } from "../system/formatters";
import { formatPortfolioCurrency } from "./format";

const metricKeys = {
  totalValue: "totalValueDecimal",
  realizedGains: "realizedGainsDecimal",
  unrealizedGains: "unrealizedGainsDecimal",
  dividends: "dividendsDecimal",
} as const;

const labelKeys = {
  totalValue: "portfolioTotalValue",
  realizedGains: "portfolioRealizedGains",
  unrealizedGains: "portfolioUnrealizedGains",
  dividends: "portfolioDividends",
} as const;

export const pointMetricValue = (
  point: PortfolioHistoryPointDto,
  metric: PortfolioMetric,
): string | null => point[metricKeys[metric]];

export const PortfolioPerformanceChart = ({
  points,
  metric,
  currency,
}: {
  points: readonly PortfolioHistoryPointDto[];
  metric: PortfolioMetric;
  currency: "CAD" | "USD";
}) => {
  const { locale, t } = useI18n();
  const { token } = useTheme();
  const exactByDate = new Map(
    points.map((point) => [point.date, pointMetricValue(point, metric)]),
  );
  const data = points.map((point) => {
    const exact = pointMetricValue(point, metric);
    const approximate = exact === null ? null : Number(exact);
    return {
      date: point.date,
      value:
        approximate !== null && Number.isFinite(approximate)
          ? approximate
          : null,
    };
  });
  const compactNumber = new Intl.NumberFormat(
    locale === "cn" ? "zh-CN" : "en",
    {
      notation: "compact",
      maximumFractionDigits: 1,
    },
  );
  return (
    <section
      className="portfolio-chart-panel"
      aria-label={`${t(labelKeys[metric])} ${t("performanceChart")}`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 12, right: 12, bottom: 4, left: 4 }}
          accessibilityLayer
        >
          <CartesianGrid
            vertical={false}
            stroke={token("--color-border-subtle")}
          />
          <XAxis
            dataKey="date"
            minTickGap={32}
            tickFormatter={(date: string) =>
              new Intl.DateTimeFormat(locale === "cn" ? "zh-CN" : "en", {
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              }).format(new Date(`${date}T00:00:00Z`))
            }
            tick={{ fill: token("--color-text-secondary"), fontSize: 11 }}
            axisLine={{ stroke: token("--color-border-subtle") }}
            tickLine={false}
          />
          <YAxis
            width={52}
            tickFormatter={(value: number) => compactNumber.format(value)}
            tick={{ fill: token("--color-text-secondary"), fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            cursor={{ stroke: token("--color-border-emphasized") }}
            content={({ active, label }) => {
              if (!active || typeof label !== "string") return null;
              return (
                <div className="portfolio-chart-tooltip">
                  <span>{formatDate(label, locale)}</span>
                  <strong>
                    {formatPortfolioCurrency(
                      exactByDate.get(label) ?? null,
                      currency,
                      locale,
                    )}
                  </strong>
                </div>
              );
            }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke={token("--color-data-categorical-blue")}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4 }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </section>
  );
};
