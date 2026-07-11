import type {
  CalendarDividendDto,
  CalendarMoverDto,
  CalendarReadModelDto,
} from "../../shared/contracts";
import { useI18n } from "../i18n/I18nProvider";
import {
  formatDecimalString,
  formatNativeCurrency,
} from "../system/formatters";

export type CalendarEvent = CalendarReadModelDto["events"][number];

export type CalendarSelection =
  | { kind: "mover"; event: CalendarMoverDto }
  | { kind: "dividend"; event: CalendarDividendDto }
  | { kind: "more"; date: string; events: CalendarEvent[] };

export const isMoverEvent = (
  event: CalendarEvent,
): event is CalendarMoverDto & { kind: "mover" } => event.kind === "mover";

export const isDividendEvent = (
  event: CalendarEvent,
): event is CalendarDividendDto & { kind: "dividend" } =>
  event.kind === "dividend";

export const safeDecimal = (
  value: string | null,
  locale: "en" | "cn",
  maximumFractionDigits?: number,
): string => {
  if (value === null) return "—";
  try {
    return formatDecimalString(value, locale, maximumFractionDigits);
  } catch {
    return "—";
  }
};

export const safeCurrency = (
  value: string | null,
  currency: "USD" | "CAD",
  locale: "en" | "cn",
): string => {
  if (value === null) return "—";
  try {
    return formatNativeCurrency(value, currency, locale);
  } catch {
    return "—";
  }
};

export const signedDecimal = (
  value: string | null,
  locale: "en" | "cn",
  maximumFractionDigits = 2,
): string => {
  if (value === null) return "—";
  const normalized = value.trim();
  if (/^[+-]?0(?:\.0*)?$/.test(normalized)) {
    return safeDecimal(
      maximumFractionDigits > 0
        ? `0.${"0".repeat(maximumFractionDigits)}`
        : "0",
      locale,
      maximumFractionDigits,
    );
  }
  const result = safeDecimal(value, locale, maximumFractionDigits);
  if (result === "—" || result.startsWith("-")) return result;
  return `+${result}`;
};

const moverTone = (event: CalendarMoverDto): "up" | "down" | "neutral" => {
  const value = event.movement?.movementPercentDecimal?.trim();
  if (!value || /^[+-]?0(?:\.0*)?$/.test(value)) return "neutral";
  return value.startsWith("-") ? "down" : "up";
};

export const eventDate = (event: CalendarEvent): string =>
  isMoverEvent(event) ? event.tradingDate : event.exDate;

export interface CalendarEventChipProps {
  event: CalendarEvent;
  locale: "en" | "cn";
  onSelect: (selection: CalendarSelection) => void;
}

export const CalendarEventChip = ({
  event,
  locale,
  onSelect,
}: CalendarEventChipProps) => {
  const { t } = useI18n();
  const mover = isMoverEvent(event);
  const label = mover
    ? `${event.symbol} ${signedDecimal(
        event.movement?.movementPercentDecimal ?? null,
        locale,
      )}%`
    : `${event.symbol} ${
        event.amountPerShareDecimal === null
          ? "—"
          : safeCurrency(event.amountPerShareDecimal, event.currency, locale)
      }`;
  const tone = mover ? moverTone(event) : "dividend";
  const ariaLabel = mover
    ? `${event.symbol}, ${t("mover")}, ${label}`
    : `${event.symbol}, ${t("dividend")}, ${label}`;
  return (
    <button
      type="button"
      className={`calendar-event-chip calendar-event-chip--${
        mover ? `mover-${tone}` : "dividend"
      }`}
      aria-haspopup="dialog"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={() =>
        onSelect(mover ? { kind: "mover", event } : { kind: "dividend", event })
      }
    >
      {label}
    </button>
  );
};
