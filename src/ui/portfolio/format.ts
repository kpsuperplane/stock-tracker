import type { Locale } from "../i18n/catalog";
import { formatNativeCurrency } from "../system/formatters";

export const formatPortfolioCurrency = (
  value: string | null,
  currency: "CAD" | "USD",
  locale: Locale,
): string => {
  if (value === null) return "—";
  try {
    return formatNativeCurrency(value, currency, locale);
  } catch {
    return "—";
  }
};

export const formatPortfolioDelta = (
  value: string | null,
  currency: "CAD" | "USD",
  locale: Locale,
): string => {
  if (value === null) return "—";
  const normalized = value.trim();
  if (/^-?0(?:\.0*)?$/.test(normalized))
    return formatPortfolioCurrency("0", currency, locale);
  const negative = normalized.startsWith("-");
  const absolute = negative ? normalized.slice(1) : normalized;
  return `${negative ? "-" : "+"}${formatPortfolioCurrency(
    absolute,
    currency,
    locale,
  )}`;
};

export const decimalTone = (
  value: string | null,
): "positive" | "negative" | "neutral" => {
  if (!value || /^-?0(?:\.0*)?$/.test(value.trim())) return "neutral";
  return value.trim().startsWith("-") ? "negative" : "positive";
};
