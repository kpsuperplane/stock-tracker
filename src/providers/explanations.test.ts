import { readFile } from "node:fs/promises";
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
      confidence: "low",
      clearCatalyst: false,
      sourceIndexes: [],
      model: "deterministic-no-sources",
    });
    expect(ai.run).not.toHaveBeenCalled();
  });

  it("accepts schema-valid Simplified Chinese output and valid citations", async () => {
    const payload = JSON.parse(
      await readFile("tests/fixtures/ai/valid-explanation.json", "utf8"),
    );
    const ai = {
      run: vi.fn(async () => ({ response: payload })),
    } as unknown as Ai;
    const result = await new WorkersAiExplanationProvider(ai).explain({
      ...move,
      sources,
    });
    expect(result.sourceIndexes).toEqual([0, 1]);
    expect(result.confidence).toBe("high");
    expect(ai.run).toHaveBeenCalledOnce();
  });

  it("deduplicates citations and rejects an unknown source index", async () => {
    const ai = {
      run: vi.fn(async () => ({
        response: {
          explanation_zh_cn: "报道可能解释了上涨。现有证据不能证明单一原因。",
          confidence: "low",
          clear_catalyst: true,
          source_indexes: [0, 0, 9],
        },
      })),
    } as unknown as Ai;
    await expect(
      new WorkersAiExplanationProvider(ai).explain({ ...move, sources }),
    ).rejects.toThrow("invalid_source_index");
  });

  it("rejects an explanation without Simplified Chinese text", async () => {
    const ai = {
      run: vi.fn(async () => ({
        response: {
          explanation_zh_cn: "News may explain the move.",
          confidence: "low",
          clear_catalyst: false,
          source_indexes: [],
        },
      })),
    } as unknown as Ai;
    await expect(
      new WorkersAiExplanationProvider(ai).explain({ ...move, sources }),
    ).rejects.toThrow("invalid_explanation_language");
  });

  it("requires cited evidence for a claimed clear catalyst", async () => {
    const ai = {
      run: vi.fn(async () => ({
        response: {
          explanation_zh_cn: "报道可能解释了上涨。现有证据仍然有限。",
          confidence: "medium",
          clear_catalyst: true,
          source_indexes: [],
        },
      })),
    } as unknown as Ai;
    await expect(
      new WorkersAiExplanationProvider(ai).explain({ ...move, sources }),
    ).rejects.toThrow("missing_catalyst_source");
  });
});
