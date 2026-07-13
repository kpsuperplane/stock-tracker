import {
  type DateRange,
  DateRangeInput,
  Icon,
  IconButton,
  Popover,
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core";
import type {
  PortfolioHistoryCoverageDto,
  PortfolioRangePreset,
} from "../../shared/contracts";
import { DownloadIcon, WarningIcon } from "../components/ProductIcons";
import { useI18n } from "../i18n/I18nProvider";
import type { PortfolioUrlState } from "./state";

const presets: Array<{
  value: PortfolioRangePreset;
  labelKey:
    | "rangeToday"
    | "rangeWeek"
    | "range30Days"
    | "range3Months"
    | "rangeYtd"
    | "rangeYear"
    | "rangeAll"
    | "rangeCustom";
}> = [
  { value: "today", labelKey: "rangeToday" },
  { value: "1w", labelKey: "rangeWeek" },
  { value: "30d", labelKey: "range30Days" },
  { value: "3m", labelKey: "range3Months" },
  { value: "ytd", labelKey: "rangeYtd" },
  { value: "1y", labelKey: "rangeYear" },
  { value: "all", labelKey: "rangeAll" },
  { value: "custom", labelKey: "rangeCustom" },
];

export const PortfolioRangeControls = ({
  state,
  currencies,
  onRangeChange,
  onCustomRangeChange,
  onCurrencyChange,
  coverage,
  canDownload,
  onDownload,
}: {
  state: PortfolioUrlState;
  currencies: readonly ("CAD" | "USD")[];
  onRangeChange: (range: PortfolioRangePreset) => void;
  onCustomRangeChange: (startDate: string, endDate: string) => void;
  onCurrencyChange: (currency: "CAD" | "USD") => void;
  coverage: PortfolioHistoryCoverageDto | null;
  canDownload: boolean;
  onDownload: () => void;
}) => {
  const { t } = useI18n();
  const customValue: DateRange | null =
    state.range === "custom" && state.startDate && state.endDate
      ? {
          start: state.startDate as DateRange["start"],
          end: state.endDate as DateRange["end"],
        }
      : null;
  const coverageTitleKey =
    coverage?.status === "partial"
      ? "portfolioPartialData"
      : coverage?.status === "pending"
        ? "portfolioPendingData"
        : "portfolioEstimatedData";

  return (
    <div className="portfolio-controls">
      <div className="portfolio-range-cluster">
        <div className="portfolio-range-shortcuts">
          <SegmentedControl
            value={state.range}
            onChange={(value) => {
              const nextPreset = presets.find(
                (preset) => preset.value === value,
              );
              if (nextPreset) onRangeChange(nextPreset.value);
            }}
            label={t("selectRange")}
            size="sm"
          >
            {presets.map((preset) => (
              <SegmentedControlItem
                key={preset.value}
                value={preset.value}
                label={t(preset.labelKey)}
              />
            ))}
          </SegmentedControl>
        </div>
        {coverage && coverage.status !== "complete" && (
          <Popover
            label={t("portfolioCoverageDetails")}
            placement="below"
            alignment="start"
            width="min(24rem, calc(100vw - 2rem))"
            content={
              <div className="portfolio-coverage-popover">
                <strong>{t(coverageTitleKey)}</strong>
                <p>{t("portfolioCoverageDescription")}</p>
              </div>
            }
          >
            <IconButton
              variant="ghost"
              size="sm"
              label={t("portfolioCoverageWarning")}
              tooltip={t("portfolioCoverageWarning")}
              icon={<Icon icon={WarningIcon} size="sm" />}
            />
          </Popover>
        )}
      </div>
      <div className="portfolio-control-end">
        {state.range === "custom" && (
          <DateRangeInput
            label={t("customDateRange")}
            isLabelHidden
            value={customValue}
            onChange={(next) => {
              if (next) onCustomRangeChange(next.start, next.end);
            }}
            max={new Date().toISOString().slice(0, 10) as DateRange["end"]}
            size="sm"
            width="min(20rem, 100%)"
            numberOfMonths={2}
            hasClear={false}
          />
        )}
        {currencies.length > 1 && state.currency && (
          <SegmentedControl
            value={state.currency}
            onChange={(value) => {
              if (value === "CAD" || value === "USD") onCurrencyChange(value);
            }}
            label={t("selectCurrency")}
            size="sm"
          >
            {currencies.map((currency) => (
              <SegmentedControlItem
                key={currency}
                value={currency}
                label={currency}
              />
            ))}
          </SegmentedControl>
        )}
        {canDownload && (
          <IconButton
            variant="ghost"
            size="sm"
            label={t("downloadPortfolioData")}
            tooltip={t("downloadPortfolioData")}
            icon={<Icon icon={DownloadIcon} size="sm" />}
            onClick={onDownload}
          />
        )}
      </div>
    </div>
  );
};
