import { afterEach, describe, expect, it, vi } from "vitest";
import { safeErrorMessage } from "./errors";
import { logEvent } from "./log";

describe("structured log redaction", () => {
  afterEach(() => vi.restoreAllMocks());

  it("does not emit credentials, payloads, or unbounded error text", () => {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    logEvent("provider_failed", {
      message:
        "Authorization: Basic dXNlcjpwYXNz Bearer super-secret api_key=abc123",
      provider: "yahoo",
      apiKey: "abc123",
    });
    const line = String(output.mock.calls[0]?.[0]);
    expect(line).not.toContain("super-secret");
    expect(line).not.toContain("dXNlcjpwYXNz");
    expect(line).not.toContain("abc123");
    expect(line).toContain("[REDACTED]");
  });

  it("redacts Basic and Bearer credentials from error messages", () => {
    const message = safeErrorMessage(
      new Error(
        "upstream rejected Authorization: Basic dXNlcjpwYXNz Bearer token-value",
      ),
    );
    expect(message).not.toContain("dXNlcjpwYXNz");
    expect(message).not.toContain("token-value");
    expect(message).toContain("credential=[REDACTED]");
  });
});
