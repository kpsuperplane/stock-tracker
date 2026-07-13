import {
  Heading,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  VStack,
} from "@astryxdesign/core";
import type { PortfolioHistoryPositionDto } from "../../shared/contracts";
import { useI18n } from "../i18n/I18nProvider";
import { formatDecimalString } from "../system/formatters";
import { formatPortfolioCurrency } from "./format";

const numericStyle = {
  textAlign: "end" as const,
  fontVariantNumeric: "tabular-nums",
  whiteSpace: "nowrap" as const,
};

export const PortfolioHoldingsTable = ({
  positions,
}: {
  positions: readonly PortfolioHistoryPositionDto[];
}) => {
  const { locale, t } = useI18n();
  return (
    <VStack gap={2}>
      <Heading level={2}>{t("holdingsAtRangeEnd")}</Heading>
      <div className="portfolio-table-scroll">
        <Table
          density="compact"
          dividers="rows"
          hasHover
          textOverflow="truncate"
          aria-label={t("holdingsAtRangeEnd")}
          tableProps={{ className: "portfolio-holdings-table" }}
        >
          <TableHeader>
            <TableRow isHeaderRow>
              <TableHeaderCell>{t("instrument")}</TableHeaderCell>
              <TableHeaderCell style={numericStyle}>
                {t("quantity")}
              </TableHeaderCell>
              <TableHeaderCell style={numericStyle}>
                {t("averageCost")}
              </TableHeaderCell>
              <TableHeaderCell style={numericStyle}>
                {t("bookCost")}
              </TableHeaderCell>
              <TableHeaderCell style={numericStyle}>
                {t("marketValue")}
              </TableHeaderCell>
              <TableHeaderCell style={numericStyle}>
                {t("portfolioUnrealizedGains")}
              </TableHeaderCell>
              <TableHeaderCell style={numericStyle}>
                {t("portfolioRealizedGains")}
              </TableHeaderCell>
              <TableHeaderCell style={numericStyle}>
                {t("portfolioDividends")}
              </TableHeaderCell>
              <TableHeaderCell>{t("currency")}</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.map((position) => (
              <TableRow key={position.instrumentId}>
                <TableCell>
                  <strong>{position.symbol}</strong>
                  <span className="portfolio-company-name">
                    {position.companyName}
                  </span>
                </TableCell>
                <TableCell style={numericStyle}>
                  {formatDecimalString(position.quantityDecimal, locale, 6)}
                </TableCell>
                <TableCell style={numericStyle}>
                  {formatPortfolioCurrency(
                    position.averageCostDecimal,
                    position.currency,
                    locale,
                  )}
                </TableCell>
                <TableCell style={numericStyle}>
                  {formatPortfolioCurrency(
                    position.bookCostDecimal,
                    position.currency,
                    locale,
                  )}
                </TableCell>
                <TableCell style={numericStyle}>
                  {formatPortfolioCurrency(
                    position.marketValueDecimal,
                    position.currency,
                    locale,
                  )}
                </TableCell>
                <TableCell style={numericStyle}>
                  {formatPortfolioCurrency(
                    position.unrealizedGainDecimal,
                    position.currency,
                    locale,
                  )}
                </TableCell>
                <TableCell style={numericStyle}>
                  {formatPortfolioCurrency(
                    position.realizedGainDecimal,
                    position.currency,
                    locale,
                  )}
                </TableCell>
                <TableCell style={numericStyle}>
                  {formatPortfolioCurrency(
                    position.dividendsDecimal,
                    position.currency,
                    locale,
                  )}
                </TableCell>
                <TableCell>{position.currency}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </VStack>
  );
};
