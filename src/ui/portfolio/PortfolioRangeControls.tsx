import {
  Button,
  type DateRange,
  DateRangeInput,
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core";
import type { PortfolioRangePreset } from "../../shared/contracts";
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
}: {
  state: PortfolioUrlState;
  currencies: readonly ("CAD" | "USD")[];
  onRangeChange: (range: PortfolioRangePreset) => void;
  onCustomRangeChange: (startDate: string, endDate: string) => void;
  onCurrencyChange: (currency: "CAD" | "USD") => void;
}) => {
  const { t } = useI18n();
  const customValue: DateRange | null =
    state.range === "custom" && state.startDate && state.endDate
      ? {
          start: state.startDate as DateRange["start"],
          end: state.endDate as DateRange["end"],
        }
      : null;
  return (
    <div className="portfolio-controls">
      <fieldset className="portfolio-range-shortcuts">
        <legend className="product-page-title-hidden">
          {t("selectRange")}
        </legend>
        {presets.map((preset) => (
          <Button
            key={preset.value}
            label={t(preset.labelKey)}
            variant={state.range === preset.value ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={state.range === preset.value}
            onClick={() => onRangeChange(preset.value)}
          />
        ))}
      </fieldset>
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
      </div>
    </div>
  );
};
