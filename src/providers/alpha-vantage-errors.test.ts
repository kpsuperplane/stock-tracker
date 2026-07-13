import { describe, expect, it } from "vitest";
import {
  throwIfAlphaVantageError,
  throwIfAlphaVantageTextError,
} from "./alpha-vantage-errors";

describe("Alpha Vantage provider notices", () => {
  it.each([
    [
      { Information: "Our standard API rate limit is 25 requests per day." },
      "provider_daily_limit",
    ],
    [
      { Note: "API call frequency is 5 requests per minute." },
      "provider_rate_limited",
    ],
    [
      { Information: "This premium endpoint requires a subscription." },
      "provider_entitlement",
    ],
    [
      { Information: "The API key is invalid or missing." },
      "provider_invalid_api_key",
    ],
    [
      { "Error Message": "Invalid API call. Check the function parameter." },
      "provider_invalid_request",
    ],
    [
      { Information: "Provider maintenance is in progress." },
      "provider_information",
    ],
  ])("classifies %o as %s", (payload, code) => {
    expect(() => throwIfAlphaVantageError(payload)).toThrow(
      expect.objectContaining({ message: code }),
    );
  });

  it("preserves a sanitized provider message", () => {
    expect(() =>
      throwIfAlphaVantageError({
        Information:
          "Daily limit reached for apikey=secret-value.  Try tomorrow.",
      }),
    ).toThrow(
      expect.objectContaining({
        message: "provider_daily_limit",
        providerMessage:
          "Daily limit reached for credential=[REDACTED] Try tomorrow.",
      }),
    );
  });

  it("detects JSON notices returned by CSV endpoints", () => {
    expect(() =>
      throwIfAlphaVantageTextError(
        JSON.stringify({ Note: "Too many requests per minute." }),
      ),
    ).toThrow("provider_rate_limited");
  });
});
