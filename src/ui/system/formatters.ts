import type { Locale } from "../i18n/catalog";

const decimalPattern = /^([+-]?)(\d+)(?:\.(\d+))?$/;

const intlLocale = (locale: Locale) => (locale === "cn" ? "zh-CN" : "en-US");

const incrementDigits = (integer: string, fraction: string) => {
  const digits = `${integer}${fraction}`.split("");
  let index = digits.length - 1;
  while (index >= 0 && digits[index] === "9") {
    digits[index] = "0";
    index -= 1;
  }
  if (index < 0) {
    return {
      integer: `1${"0".repeat(integer.length)}`,
      fraction: "0".repeat(fraction.length),
    };
  }
  digits[index] = String(Number(digits[index]) + 1);
  const integerLength = integer.length;
  return {
    integer: digits.slice(0, integerLength).join(""),
    fraction: digits.slice(integerLength).join(""),
  };
};

const roundDecimalParts = (
  integer: string,
  fraction: string,
  maximumFractionDigits: number | undefined,
) => {
  if (
    maximumFractionDigits === undefined ||
    fraction.length <= maximumFractionDigits
  ) {
    return { integer, fraction };
  }

  const kept = fraction.slice(0, maximumFractionDigits);
  const shouldRound = Number(fraction[maximumFractionDigits] ?? "0") >= 5;
  if (!shouldRound) return { integer, fraction: kept };
  return incrementDigits(integer, kept);
};

const groupInteger = (integer: string, separator: string) => {
  let grouped = "";
  for (let index = 0; index < integer.length; index += 1) {
    if (index > 0 && (integer.length - index) % 3 === 0) {
      grouped += separator;
    }
    grouped += integer[index];
  }
  return grouped;
};

export const formatDecimalString = (
  value: string,
  locale: Locale,
  maximumFractionDigits?: number,
) => {
  const match = decimalPattern.exec(value.trim());
  if (!match) throw new Error("Invalid decimal string");

  const [, sign, rawInteger, rawFraction = ""] = match;
  const rounded = roundDecimalParts(
    (rawInteger ?? "0").replace(/^0+(?=\d)/, ""),
    rawFraction,
    maximumFractionDigits,
  );
  const numberParts = new Intl.NumberFormat(intlLocale(locale), {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).formatToParts(1000);
  const groupSeparator =
    numberParts.find((part) => part.type === "group")?.value ?? ",";
  const decimalParts = new Intl.NumberFormat(intlLocale(locale), {
    useGrouping: false,
  }).formatToParts(1.1);
  const decimalSeparator =
    decimalParts.find((part) => part.type === "decimal")?.value ?? ".";
  const fraction = rounded.fraction;
  return `${sign === "-" ? "-" : ""}${groupInteger(
    rounded.integer,
    groupSeparator,
  )}${fraction ? `${decimalSeparator}${fraction}` : ""}`;
};

export const formatNativeCurrency = (
  value: string | number | bigint,
  currency: "CAD" | "USD",
  locale: Locale,
) => {
  const raw = String(value);
  const isNegative = raw.trim().startsWith("-");
  const amount = formatDecimalString(
    isNegative ? raw.trim().slice(1) : raw,
    locale,
    2,
  );
  const currencyParts = new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).formatToParts(isNegative ? -0 : 0);
  const integerIndex = currencyParts.findIndex(
    (part) => part.type === "integer",
  );
  const fractionIndex = currencyParts.findIndex(
    (part) => part.type === "fraction",
  );
  const prefix = currencyParts
    .slice(0, integerIndex)
    .map((part) => part.value)
    .join("");
  const suffix = currencyParts
    .slice(fractionIndex + 1)
    .map((part) => part.value)
    .join("");
  const decimalSeparator =
    currencyParts.find((part) => part.type === "decimal")?.value ?? ".";
  const [integer, fraction = ""] = amount.split(decimalSeparator);
  const fixedAmount = `${integer}${decimalSeparator}${fraction.padEnd(2, "0")}`;
  return `${prefix}${fixedAmount}${suffix}`;
};

export const formatDate = (date: string | Date, locale: Locale) => {
  const value = typeof date === "string" ? new Date(`${date}T00:00:00Z`) : date;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(value);
};
