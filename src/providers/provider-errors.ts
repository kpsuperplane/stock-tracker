export interface ProviderFailure {
  code: string;
  message: string;
}

const providerCodePattern = /^provider_[a-z0-9_]+$/;

const sanitizeProviderMessage = (value: string): string =>
  value
    .replace(/(?:Bearer|Basic)\s+[^\s,;]+/gi, "credential=[REDACTED]")
    .replace(
      /(?:authorization|api[_-]?key|apikey|token|password|secret)\s*[=:]\s*[^\s,;&]+/gi,
      "credential=[REDACTED]",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);

export class ProviderResponseError extends Error {
  readonly providerMessage: string;

  constructor(code: string, providerMessage: string) {
    const safeCode = providerCodePattern.test(code)
      ? code.slice(0, 120)
      : "provider_unavailable";
    super(safeCode);
    this.name = "ProviderResponseError";
    this.providerMessage = sanitizeProviderMessage(providerMessage) || safeCode;
  }
}

export const describeProviderError = (error: unknown): ProviderFailure => {
  if (error instanceof ProviderResponseError) {
    return { code: error.message, message: error.providerMessage };
  }
  const message =
    error instanceof Error ? error.message : "provider_unavailable";
  const code = providerCodePattern.test(message)
    ? message.slice(0, 120)
    : "provider_unavailable";
  return { code, message: code };
};

export const providerFailure = (code: string): ProviderFailure =>
  describeProviderError(new Error(code));
