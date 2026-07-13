import { describe, expect, it } from "vitest";
import { createApp } from "./app";

describe("Application access", () => {
  it("does not require application-level credentials", async () => {
    const response = await createApp().request("http://local/api/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("WWW-Authenticate")).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });
});
