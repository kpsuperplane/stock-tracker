export const providerErrorCode = (error: unknown): string => {
  const text = error instanceof Error ? error.message : String(error);
  const match = /(provider_[a-z0-9_]+)/i.exec(text);
  return match?.[1] ?? "provider_unavailable";
};

export const isTransientProviderError = (error: unknown): boolean =>
  error instanceof TypeError ||
  /http_(429|5\d\d)|\b429\b|timed?out|network|abort/i.test(String(error));

export const previousDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T12:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
