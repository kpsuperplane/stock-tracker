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
      model: "@cf/qwen/qwen3-30b-a3b-fp8",
    });
    expect(ai.run).toHaveBeenCalledOnce();
    expect(ai.run).toHaveBeenCalledWith(
      "@cf/qwen/qwen3-30b-a3b-fp8",
      expect.objectContaining({
        chat_template_kwargs: { enable_thinking: false },
      }),
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
      model: "@cf/qwen/qwen3-30b-a3b-fp8",
    });
  });

  it("accepts the chat-completions response shape used by Qwen", async () => {
    const ai = {
      run: vi.fn(async () => ({
        choices: [
          {
            message: {
              content: null,
              reasoning_content:
                "多篇报道提到存储芯片需求改善。这可能与本次股价上涨有关。",
            },
          },
        ],
      })),
    } as unknown as Ai;

    await expect(
      new WorkersAiExplanationProvider(ai).explain({ ...move, sources }),
    ).resolves.toEqual({
      explanationZhCn:
        "多篇报道提到存储芯片需求改善。这可能与本次股价上涨有关。",
      model: "@cf/qwen/qwen3-30b-a3b-fp8",
    });
  });

  it("retries an invalid response before accepting valid Chinese output", async () => {
    const ai = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ response: "News may explain the move." })
        .mockResolvedValueOnce({ response: "相关报道可能解释本次异动。" }),
    } as unknown as Ai;
    await expect(
      new WorkersAiExplanationProvider(ai).explain({ ...move, sources }),
    ).resolves.toEqual({
      explanationZhCn: "相关报道可能解释本次异动。",
      model: "@cf/qwen/qwen3-30b-a3b-fp8",
    });
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("rejects English-dominant mixed output", async () => {
    const ai = {
      run: vi
        .fn()
        .mockResolvedValueOnce({
          response:
            "Super Micro Computer announced a large financing transaction to fund component purchases. 公司表示相关资金将用于履行人工智能服务器订单。",
        })
        .mockResolvedValueOnce({
          response:
            "超微电脑宣布一项大型融资交易，相关资金将用于采购组件并履行人工智能服务器订单。这一消息可能与股价上涨有关。",
        }),
    } as unknown as Ai;

    await expect(
      new WorkersAiExplanationProvider(ai).explain({ ...move, sources }),
    ).resolves.toEqual({
      explanationZhCn:
        "超微电脑宣布一项大型融资交易，相关资金将用于采购组件并履行人工智能服务器订单。这一消息可能与股价上涨有关。",
      model: "@cf/qwen/qwen3-30b-a3b-fp8",
    });
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("uses deterministic Chinese copy after two invalid responses", async () => {
    const ai = {
      run: vi
        .fn()
        .mockResolvedValueOnce({ response: "   " })
        .mockResolvedValueOnce({ response: "News may explain the move." }),
    } as unknown as Ai;
    await expect(
      new WorkersAiExplanationProvider(ai).explain({ ...move, sources }),
    ).resolves.toEqual({
      explanationZhCn:
        "模型未能生成有效的中文摘要。现有新闻来源可能与本次异动相关，但无法确认明确催化因素。",
      model: "deterministic-invalid-output",
    });
    expect(ai.run).toHaveBeenCalledTimes(2);
  });

  it("leaves provider failures to the queue retry policy", async () => {
    const ai = {
      run: vi.fn(async () => {
        throw new Error("provider_503");
      }),
    } as unknown as Ai;
    await expect(
      new WorkersAiExplanationProvider(ai).explain({ ...move, sources }),
    ).rejects.toThrow("provider_503");
    expect(ai.run).toHaveBeenCalledOnce();
  });
});
