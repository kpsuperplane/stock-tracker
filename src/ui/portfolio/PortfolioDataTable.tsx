import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "@astryxdesign/core";
import type {
  PortfolioHistoryPointDto,
  PortfolioMetric,
} from "../../shared/contracts";
import { useI18n } from "../i18n/I18nProvider";
import { formatDate } from "../system/formatters";
import { formatPortfolioCurrency } from "./format";
import { pointMetricValue } from "./PortfolioPerformanceChart";

export const PortfolioDataTable = ({
  points,
  metric,
  currency,
}: {
  points: readonly PortfolioHistoryPointDto[];
  metric: PortfolioMetric;
  currency: "CAD" | "USD";
}) => {
  const { locale, t } = useI18n();
  return (
    <details className="portfolio-data-details">
      <summary>{t("showChartData")}</summary>
      <div className="portfolio-table-scroll">
        <Table
          density="compact"
          dividers="rows"
          aria-label={t("chartData")}
          tableProps={{ className: "portfolio-data-table" }}
        >
          <TableHeader>
            <TableRow isHeaderRow>
              <TableHeaderCell>{t("date")}</TableHeaderCell>
              <TableHeaderCell style={{ textAlign: "end" }}>
                {t("value")}
              </TableHeaderCell>
              <TableHeaderCell>{t("dataStatus")}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {points.map((point) => (
              <TableRow key={point.date}>
                <TableCell>{formatDate(point.date, locale)}</TableCell>
                <TableCell className="portfolio-numeric-cell">
                  {formatPortfolioCurrency(
                    pointMetricValue(point, metric),
                    currency,
                    locale,
                  )}
                </TableCell>
                <TableCell>{t(point.status)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </details>
  );
};
