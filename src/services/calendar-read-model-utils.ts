import { DecimalValue } from "../domain/decimal";

export const safeDecimal = (value: string | null): string | null => {
  if (value === null) return null;
  try {
    return DecimalValue.parse(value).toString();
  } catch {
    return null;
  }
};

export const multiplyDecimal = (left: string, right: string): string | null => {
  const normalizedLeft = safeDecimal(left);
  const normalizedRight = safeDecimal(right);
  if (normalizedLeft === null || normalizedRight === null) return null;
  try {
    return DecimalValue.parse(normalizedLeft)
      .multiply(normalizedRight)
      .toString();
  } catch {
    return null;
  }
};

export const qualifies = (value: string | null): boolean => {
  const normalized = safeDecimal(value);
  if (normalized === null) return false;
  const decimal = DecimalValue.parse(normalized);
  return (
    (decimal.isNegative() ? decimal.multiply("-1") : decimal).compare("5") >= 0
  );
};

export const safeSourceUrl = (value: string | null): string | null => {
  if (!value) return null;
  try {
    const trimmed = value.trim();
    const parsed = new URL(trimmed);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.length > 0 &&
      !parsed.username &&
      !parsed.password
      ? trimmed
      : null;
  } catch {
    return null;
  }
};

export const pendingMessage = (status: string): string =>
  status === "processing"
    ? "Market data is currently processing."
    : "Market data is waiting to be fetched.";
