import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { Env } from "./env";

const env = {
  BASIC_AUTH_USERNAME: "owner",
  BASIC_AUTH_PASSWORD: "correct-horse",
} as Env;

const authorization = (username: string, password: string) =>
  `Basic ${btoa(`${username}:${password}`)}`;

describe("Basic Authentication", () => {
  it("challenges missing credentials", async () => {
    const response = await createApp().request("http://local/api/health", {}, env);
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Basic realm="Stock Tracker"',
    );
  });

  it("allows matching credentials", async () => {
    const response = await createApp().request(
      "http://local/api/health",
      { headers: { Authorization: authorization("owner", "correct-horse") } },
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("rejects malformed and mismatched credentials without exposing details", async () => {
    const app = createApp();
    for (const header of ["Basic !!!", authorization("owner", "wrong")]) {
      const response = await app.request(
        "http://local/api/health",
        { headers: { Authorization: header } },
        env,
      );
      expect(response.status).toBe(401);
      expect(await response.text()).toBe("Authentication required");
    }
  });
});
