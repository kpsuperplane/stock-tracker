import { Button, HStack, Icon, Popover, VStack } from "@astryxdesign/core";
import { DecimalValue } from "../../domain/decimal";
import type { CalendarDividendDto } from "../../shared/contracts";
import { CashIcon } from "../components/ProductIcons";
import { useI18n } from "../i18n/I18nProvider";
import { formatDate } from "../system/formatters";
import { safeCurrency } from "./CalendarEvent";
import type { CalendarView } from "./dateMath";

type DividendCurrency = CalendarDividendDto["currency"];

export interface DividendPeriodSummary {
  dividends: CalendarDividendDto[];
  totals: Partial<Record<DividendCurrency, string>>;
  unavailableCount: number;
}

export const summarizePeriodDividends = (
  dividends: CalendarDividendDto[],
  startDate: string,
  endDate: string,
): DividendPeriodSummary => {
  const inPeriod = dividends.filter(
    (dividend) => dividend.exDate >= startDate && dividend.exDate <= endDate,
  );
  const totals: Partial<Record<DividendCurrency, DecimalValue>> = {};
  let unavailableCount = 0;

  for (const dividend of inPeriod) {
    if (dividend.expectedTotalValueDecimal === null) {
      unavailableCount += 1;
      continue;
    }
    const current = totals[dividend.currency] ?? DecimalValue.zero();
    totals[dividend.currency] = current.add(dividend.expectedTotalValueDecimal);
  }

  return {
    dividends: inPeriod,
    totals: Object.fromEntries(
      Object.entries(totals).map(([currency, total]) => [
        currency,
        total.toString(),
      ]),
    ),
    unavailableCount,
  };
};

const totalLabel = (
  summary: DividendPeriodSummary,
  locale: "en" | "cn",
): string => {
  const values = (["USD", "CAD"] as const).flatMap((currency) => {
    const total = summary.totals[currency];
    return total === undefined
      ? []
      : [`${currency} ${safeCurrency(total, currency, locale)}`];
  });
  return values.length > 0
    ? values.join(" · ")
    : safeCurrency("0", "USD", locale);
};

export interface PeriodDividendSummaryProps {
  dividends: CalendarDividendDto[];
  view: CalendarView;
  startDate: string;
  endDate: string;
  compact?: boolean;
}

export const PeriodDividendSummary = ({
  dividends,
  view,
  startDate,
  endDate,
  compact = false,
}: PeriodDividendSummaryProps) => {
  const { locale, t } = useI18n();
  const summary = summarizePeriodDividends(dividends, startDate, endDate);
  const periodLabel = compact
    ? t("dividends")
    : view === "month"
      ? t("monthlyDividendTotal")
      : t("weeklyDividendTotal");
  const label = `${periodLabel}: ${totalLabel(summary, locale)}`;

  return (
    <div className="calendar-dividend-summary">
      <Popover
        label={t("dividendBreakdown")}
        width="min(30rem, calc(100vw - 2rem))"
        hasCloseButton={false}
        content={
          <VStack gap={2}>
            <strong>{t("dividendBreakdown")}</strong>
            <div className="calendar-dividend-summary__range">
              {formatDate(startDate, locale)} – {formatDate(endDate, locale)}
            </div>
            {summary.dividends.length === 0 ? (
              <div>{t("noDividendsInPeriod")}</div>
            ) : (
              <VStack gap={1}>
                {summary.dividends.map((dividend) => (
                  <HStack
                    key={dividend.id}
                    gap={2}
                    justify="between"
                    align="start"
                    wrap="nowrap"
                  >
                    <div>
                      <strong>{dividend.symbol}</strong>
                      <div className="calendar-dividend-summary__meta">
                        {formatDate(dividend.exDate, locale)} ·{" "}
                        {dividend.companyName}
                      </div>
                    </div>
                    <strong className="calendar-dividend-summary__value">
                      {safeCurrency(
                        dividend.expectedTotalValueDecimal,
                        dividend.currency,
                        locale,
                      )}
                    </strong>
                  </HStack>
                ))}
              </VStack>
            )}
            {summary.unavailableCount > 0 && (
              <div className="calendar-dividend-summary__note">
                {t("unavailableDividendValues").replace(
                  "{count}",
                  String(summary.unavailableCount),
                )}
              </div>
            )}
          </VStack>
        }
      >
        <Button
          variant="secondary"
          size="sm"
          label={label}
          {...(compact
            ? {
                tooltip: label,
                icon: <Icon icon={CashIcon} size="sm" />,
                isIconOnly: true,
              }
            : {})}
        />
      </Popover>
    </div>
  );
};
