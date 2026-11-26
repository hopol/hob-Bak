import { describe, expect, it } from "vitest";
import { modelBrand, providerBrand, recognizeBrand } from "../src/brand-recognition.ts";
import { brandForRef } from "../src/brand-icons.tsx";

describe("recognizeBrand", () => {
  it.each([
    ["GPT-4", "openai"], ["o1-preview", "openai"], ["o3", "openai"], ["o4-mini", "openai"], ["ChatGPT", "openai"],
    ["Claude 3", "anthropic"], ["Anthropic", "anthropic"], ["Gemini-2", "google"], ["Gemma", "google"], ["Google", "google"],
    ["deepseek-r1", "deepseek"], ["qwen2.5", "qwen"], ["qwq", "qwen"], ["tongyi", "qwen"], ["dashscope", "qwen"], ["通义", "qwen"],
    ["kimi", "moonshot"], ["moonshot", "moonshot"], ["glm-4", "zhipu"], ["chatglm", "zhipu"], ["bigmodel", "zhipu"], ["zhipu", "zhipu"], ["智谱", "zhipu"],
    ["grok", "xai"], ["xai", "xai"], ["mistral", "mistral"], ["mixtral", "mistral"], ["llama", "meta"], ["meta", "meta"],
    ["minimax", "minimax"], ["doubao", "bytedance"], ["豆包", "bytedance"], ["bytedance", "bytedance"], ["字节跳动", "bytedance"], ["openrouter", "openrouter"],
    ["ollama", "ollama"], ["groq", "groq"], ["azure", "azure"], ["aws", "bedrock"], ["bedrock", "bedrock"], ["vercel", "vercel"],
    ["siliconcloud", "siliconcloud"], ["siliconflow", "siliconcloud"], ["硅基流动", "siliconcloud"],
  ])("recognizes %s", (text, brand) => expect(recognizeBrand(text)).toBe(brand));

  it.each(["", "radio1clock", "mygpttool", "llamazing", "unknown"])("does not recognize %s", (text) => expect(recognizeBrand(text)).toBeNull());

  it("prefers the model and falls back to the provider", () => {
    expect(modelBrand("claude-3", "", "openai")).toBe("anthropic");
    expect(modelBrand("unknown", "Gemini", "openai")).toBe("google");
    expect(modelBrand("unknown", "", "openai")).toBe("openai");
  });

  it("uses a configured provider name only after checking the model", () => {
    const providers = [{ id: "relay", name: "DeepSeek" }];
    expect(brandForRef("relay/unknown", [], providers)).toBe("deepseek");
    expect(brandForRef("relay/claude-sample", [], providers)).toBe("anthropic");
    expect(brandForRef("other/unknown", [], providers)).toBeNull();
  });

  it("uses a shared model brand only when every model is recognized as that brand", () => {
    expect(providerBrand("proxy", "", [{ id: "gpt-4" }, { id: "o1" }])).toBe("openai");
    expect(providerBrand("proxy", "", [{ id: "gpt-4" }, { id: "claude-3" }])).toBeNull();
    expect(providerBrand("proxy", "", [{ id: "gpt-4" }, { id: "other" }])).toBeNull();
    expect(providerBrand("proxy")).toBeNull();
  });
});
