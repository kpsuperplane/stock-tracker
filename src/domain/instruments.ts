export type InstrumentType = "stock" | "etf" | "warrant";

export type YahooInstrumentType = "EQUITY" | "ETF" | "WARRANT";

const knownYahooWarrants = new Set(["OPENW", "OPENL", "OPENZ"]);

/**
 * Yahoo currently reports the Opendoor warrants as equities, so their public
 * symbols are the authoritative discriminator until the provider fixes its
 * metadata.
 */
export const instrumentTypeFromYahoo = (
  symbol: string,
  providerType: YahooInstrumentType,
): InstrumentType => {
  if (knownYahooWarrants.has(symbol.trim().toUpperCase())) return "warrant";
  if (providerType === "WARRANT") return "warrant";
  return providerType === "ETF" ? "etf" : "stock";
};
