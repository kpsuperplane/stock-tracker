import type { DividendEventRange, DividendProvider } from "./dividends";

const fallbackEligible = (error: unknown): boolean => {
  const code = error instanceof Error ? error.message : String(error);
  return /provider_(?:http_(?:429|5\d\d)|rate_limited|notice|information|schema|symbol_unavailable|unavailable)|timeout|timed[_-]?out|network|fetch|abort/i.test(
    code,
  );
};

export class PrimaryFallbackDividendProvider implements DividendProvider {
  lastProvider: "primary" | "fallback" | null = null;

  constructor(
    private readonly primary: DividendProvider,
    private readonly fallback: DividendProvider | null,
    private readonly onFallbackEntitlementFailure?: (
      code: string,
    ) => Promise<void>,
  ) {}

  async getDividends(
    symbol: string,
    startDate: string,
    endDate: string,
    currency?: "USD" | "CAD",
  ): Promise<DividendEventRange> {
    this.lastProvider = null;
    try {
      const range = await this.primary.getDividends(
        symbol,
        startDate,
        endDate,
        currency,
      );
      this.lastProvider = "primary";
      return range;
    } catch (primaryError) {
      if (!this.fallback || !fallbackEligible(primaryError)) throw primaryError;
      try {
        const range = await this.fallback.getDividends(
          symbol,
          startDate,
          endDate,
          currency,
        );
        this.lastProvider = "fallback";
        return range;
      } catch (fallbackError) {
        const code =
          fallbackError instanceof Error
            ? fallbackError.message
            : "provider_unavailable";
        if (
          code === "provider_entitlement" ||
          code === "provider_invalid_api_key"
        ) {
          await this.onFallbackEntitlementFailure?.(code);
        }
        // Yahoo remains authoritative. A failed fallback must not replace its
        // error classification with an Alpha quota or entitlement condition.
        throw primaryError;
      }
    }
  }
}
