import { describe, expect, it, vi } from "vitest";
import { FallbackNewsProvider } from "./fallback-news";

const request = {
  symbol: "MU",
  companyName: "Micron Technology, Inc.",
  publishedAfter: "2026-06-30T20:00:00.000Z",
  publishedBefore: "2026-07-01T22:00:00.000Z",
};
const fallbackItems = [
  {
    title: "Fallback result",
    publisher: "Reuters",
    publishedAt: "2026-07-01T18:00:00.000Z",
    url: "https://news/fallback",
  },
];

describe("FallbackNewsProvider", () => {
  it("uses the fallback when the primary provider fails", async () => {
    const primary = {
      search: vi.fn(async () => Promise.reject(new Error("exa_http_503"))),
    };
    const fallback = { search: vi.fn(async () => fallbackItems) };

    await expect(
      new FallbackNewsProvider(primary, fallback).search(request),
    ).resolves.toEqual(fallbackItems);
    expect(fallback.search).toHaveBeenCalledOnce();
  });

  it("uses the fallback when the primary provider finds nothing", async () => {
    const primary = { search: vi.fn(async () => []) };
    const fallback = { search: vi.fn(async () => fallbackItems) };

    await expect(
      new FallbackNewsProvider(primary, fallback).search(request),
    ).resolves.toEqual(fallbackItems);
  });

  it("keeps primary results without calling the fallback", async () => {
    const primary = { search: vi.fn(async () => fallbackItems) };
    const fallback = { search: vi.fn(async () => []) };

    await expect(
      new FallbackNewsProvider(primary, fallback).search(request),
    ).resolves.toEqual(fallbackItems);
    expect(fallback.search).not.toHaveBeenCalled();
  });
});
