import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../shared/types.ts";
import { filterModels, fitThinking, groupByProvider, thinkingLevels } from "../src/model-list.ts";

function model(provider: string, id: string, name = id): ModelInfo {
  return {
    ref: `${provider}/${id}`,
    provider,
    id,
    name,
    reasoning: false,
    thinkingLevels: ["off"],
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 8_192,
    cost: { input: 0, output: 0 },
  };
}

const LIST = [
  model("anthropic", "sonnet", "Claude Sonnet"),
  model("my-proxy", "astra", "GPT-6 Astra"),
  model("anthropic", "haiku", "Claude Haiku"),
  model("deepseek", "flash", "DeepSeek Flash"),
];

describe("模型名单筛选", () => {
  it("空搜索就是全部", () => {
    expect(filterModels(LIST, "  ")).toHaveLength(4);
  });

  it("按名字过滤，不区分大小写", () => {
    expect(filterModels(LIST, "claude").map((m) => m.id)).toEqual(["sonnet", "haiku"]);
  });

  it("按 ref 过滤", () => {
    expect(filterModels(LIST, "my-proxy/").map((m) => m.id)).toEqual(["astra"]);
    expect(filterModels(LIST, "deepseek/flash").map((m) => m.id)).toEqual(["flash"]);
  });

  it("匹配不上就是空", () => {
    expect(filterModels(LIST, "zzz")).toEqual([]);
  });
});

describe("模型按服务商分组", () => {
  it("服务商按第一次出现的顺序，组内保持原顺序", () => {
    const groups = groupByProvider(LIST);
    expect(groups.map((group) => group.provider)).toEqual(["anthropic", "my-proxy", "deepseek"]);
    expect(groups[0]!.models.map((m) => m.id)).toEqual(["sonnet", "haiku"]);
  });

  it("只有一个模型也能成组", () => {
    expect(groupByProvider([model("faux", "fast")])).toEqual([{ provider: "faux", models: [model("faux", "fast")] }]);
  });

  it("空名单没有组", () => {
    expect(groupByProvider([])).toEqual([]);
  });
});

describe("思考档按模型", () => {
  it("只列这个模型支持的档；没拿到模型时只有关闭", () => {
    const smart: ModelInfo = { ...model("faux", "smart"), reasoning: true, thinkingLevels: ["off", "low", "high"] };
    expect(thinkingLevels(smart)).toEqual(["off", "low", "high"]);
    expect(thinkingLevels(undefined)).toEqual(["off"]);
  });

  it("换了模型后原来的档不在新模型的档里：往下取最近的一档", () => {
    const capped: ModelInfo = { ...model("gpt", "old"), reasoning: true, thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh"] };
    expect(fitThinking(capped, "max")).toBe("xhigh");
    expect(fitThinking(capped, "medium")).toBe("medium");
    expect(fitThinking(undefined, "max")).toBe("max");
  });
});
