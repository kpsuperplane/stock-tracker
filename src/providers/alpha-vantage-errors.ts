import { ProviderResponseError } from "./provider-errors";

type AlphaVantageNoticeField = "Error Message" | "Information" | "Note";

const noticeFields: readonly AlphaVantageNoticeField[] = [
  "Error Message",
  "Information",
  "Note",
];

const classifyNotice = (
  field: AlphaVantageNoticeField,
  message: string,
): string => {
  if (
    /(?:invalid|missing|incorrect|demo)\s+(?:alpha vantage\s+)?api\s*key|api\s*key\s+(?:is\s+)?(?:invalid|missing|incorrect)/i.test(
      message,
    )
  ) {
    return "provider_invalid_api_key";
  }
  if (
    /\b(?:call frequency|per (?:second|minute)|too many requests|requests? more sparingly|higher api call volume|throttl(?:e|ed|ing))\b/i.test(
      message,
    )
  ) {
    return "provider_rate_limited";
  }
  if (/\b(?:daily|per day|requests? today)\b|25 requests/i.test(message)) {
    return "provider_daily_limit";
  }
  if (
    /\b(?:premium endpoint|subscription|required subscription|entitlement|paid plan)\b/i.test(
      message,
    )
  ) {
    return "provider_entitlement";
  }
  if (/\brate limit\b/i.test(message)) return "provider_rate_limited";
  if (field === "Error Message") return "provider_invalid_request";
  if (field === "Note") return "provider_notice";
  return "provider_information";
};

export const throwIfAlphaVantageError = (payload: unknown): void => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return;
  }
  const record = payload as Record<string, unknown>;
  for (const field of noticeFields) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") continue;
    throw new ProviderResponseError(classifyNotice(field, value), value);
  }
};

export const throwIfAlphaVantageTextError = (body: string): void => {
  const trimmed = body.trim();
  if (!trimmed.startsWith("{")) return;
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return;
  }
  throwIfAlphaVantageError(payload);
};
