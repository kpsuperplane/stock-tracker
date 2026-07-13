import type {
  PortfolioHistoryCurrencyDto,
  PortfolioMetric,
} from "../../shared/contracts";
import { useI18n } from "../i18n/I18nProvider";
import {
  decimalTone,
  formatPortfolioCurrency,
  formatPortfolioDelta,
} from "./format";

const metrics: PortfolioMetric[] = [
  "totalValue",
  "realizedGains",
  "unrealizedGains",
  "dividends",
];

const labelKeys = {
  totalValue: "portfolioTotalValue",
  realizedGains: "portfolioRealizedGains",
  unrealizedGains: "portfolioUnrealizedGains",
  dividends: "portfolioDividends",
} as const;

export const PortfolioSummaryStrip = ({
  currency,
  selectedMetric,
  onSelectMetric,
}: {
  currency: PortfolioHistoryCurrencyDto;
  selectedMetric: PortfolioMetric;
  onSelectMetric: (metric: PortfolioMetric) => void;
}) => {
  const { locale, t } = useI18n();
  return (
    <fieldset className="portfolio-summary-strip">
      <legend className="product-page-title-hidden">{t("selectMetric")}</legend>
      {metrics.map((metric) => {
        const summary = currency.summaries[metric];
        const tone = decimalTone(summary.periodDeltaDecimal);
        return (
          <button
            key={metric}
            type="button"
            className="portfolio-summary-item"
            aria-pressed={selectedMetric === metric}
            onClick={() => onSelectMetric(metric)}
          >
            <span className="portfolio-summary-label">
              {t(labelKeys[metric])}
            </span>
            <strong className="portfolio-summary-value">
              {formatPortfolioCurrency(
                summary.valueDecimal,
                currency.currency,
                locale,
              )}
            </strong>
            <span className={`portfolio-summary-delta is-${tone}`}>
              {formatPortfolioDelta(
                summary.periodDeltaDecimal,
                currency.currency,
                locale,
              )}{" "}
              {t("selectedPeriod")}
            </span>
          </button>
        );
      })}
    </fieldset>
  );
};
