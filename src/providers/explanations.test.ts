import { describe, expect, it, vi } from "vitest";
import { WorkersAiExplanationProvider } from "./explanations";

const move = {
  symbol: "SHOP.TO",
  companyName: "Shopify Inc.",
  changePct: 7.4,
};
const sources = [
  {
    title: "Enterprise growth update lifts Shopify",
    publisher: "Reuters",
    publishedAt: "2026-07-09T18:30:00.000Z",
    url: "https://news/1",
  },
  {
    title: "Analyst raises Shopify target",
    publisher: "BNN Bloomberg",
    publishedAt: "2026-07-09T20:00:00.000Z",
    url: "https://news/2",
  },
];

describe("WorkersAiExplanationProvider", () => {
  it("returns deterministic Chinese copy without calling AI when no sources exist", async () => {
    const ai = { run: vi.fn() } as unknown as Ai;
    const result = await new WorkersAiExplanationProvider(ai).explain({
      ...move,
      sources: [],
    });
    expect(result).toEqual({
      explanationZhCn:
        "未找到与本次价格变动时间相符的相关新闻来源，因此无法确定明确催化因素。",
      model: "deterministic-no-sources",
    });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("accepts plain Simplified Chinese text", async () => {
    const ai = {
      run: vi.fn(async () => ({
        response:
          "企业客户增长和分析师上调目标价可能推动股价上涨。现有报道无法证明单一原因。",
      })),
    } as unknown as Ai;

    const result = await new WorkersAiExplanationProvider(ai).explain({
      ...move,
      sources,
    });

    expect(result).toEqual({
      explanationZhCn:
        "企业客户增长和分析师上调目标价可能推动股价上涨。现有报道无法证明单一原因。",
      model: "@cf/meta/llama-3.1-8b-instruct-fast",
    });
    expect(ai.run).toHaveBeenCalledOnce();
    expect(ai.run).toHaveBeenCalledWith(
      "@cf/meta/llama-3.1-8b-instruct-fast",
      expect.not.objectContaining({ response_format: expect.anything() }),
    );
  });

  it("removes an accidental Markdown fence instead of failing", async () => {
    const ai = {
      run: vi.fn(async () => ({
        response: "```\n相关报道可能解释本次上涨。现有证据仍然有限。\n```",
      })),
    } as unknown as Ai;

    await expect(
      new WorkersAiExplanationProvider(ai).explain({ ...move, sources }),
    ).resolves.toEqual({
      explanationZhCn: "相关报道可能解释本次上涨。现有证据仍然有限。",
      model: "@cf/meta/llama-3.1-8b-instruct-fast",
    });
  });

  it("rejects empty output", async () => {
    const ai = {
      run: vi.fn(async () => ({ response: "   " })),
    } as unknown as Ai;
    await expect(
      new WorkersAiExplanationProvider(ai).explain({ ...move, sources }),
    ).rejects.toThrow("invalid_explanation_text");
  });

  it("rejects output without Simplified Chinese text", async () => {
    const ai = {
      run: vi.fn(async () => ({ response: "News may explain the move." })),
    } as unknown as Ai;
    await expect(
      new WorkersAiExplanationProvider(ai).explain({ ...move, sources }),
    ).rejects.toThrow("invalid_explanation_language");
  });
});
