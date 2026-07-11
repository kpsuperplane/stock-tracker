const SENSITIVE_FIELD =
  /(?:authorization|password|secret|token|api[_-]?key|cookie|payload|prompt|body|csv|content)/i;
const REDACTED = "[REDACTED]";
const MAX_LOG_STRING = 500;

const redactValue = (
  key: string,
  value: string | number | boolean | null,
): string | number | boolean | null => {
  if (SENSITIVE_FIELD.test(key)) return REDACTED;
  if (typeof value !== "string") return value;
  // Provider errors occasionally echo request details. Keep diagnostics useful
  // while preventing unbounded/raw payloads from reaching Worker logs.
  return value
    .replace(/(?:Bearer|Basic)\s+[^\s,;]+/gi, "credential=[REDACTED]")
    .replace(
      /(?:api[_-]?key|token|password|secret)\s*[=:]\s*[^\s,;]+/gi,
      "credential=[REDACTED]",
    )
    .slice(0, MAX_LOG_STRING);
};

export const logEvent = (
  event: string,
  fields: Record<string, string | number | boolean | null>,
) => {
  const safeFields = Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [
      key,
      redactValue(key, value),
    ]),
  );
  console.log(JSON.stringify({ event, ...safeFields }));
};
