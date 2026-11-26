/** 根据完整单词或模型系列前缀识别厂商；短型号不能匹配普通单词的一部分。 */
const brands = {
  openai: ["openai", "chatgpt", "gpt", "o1", "o3", "o4"],
  anthropic: ["anthropic", "claude"],
  google: ["google", "gemini", "gemma"],
  deepseek: ["deepseek"],
  qwen: ["qwen", "qwq", "tongyi", "dashscope", "通义"],
  moonshot: ["moonshot", "kimi"],
  zhipu: ["zhipu", "glm", "chatglm", "bigmodel", "智谱"],
  xai: ["xai", "grok"],
  mistral: ["mistral", "mixtral"],
  meta: ["meta", "llama"],
  minimax: ["minimax"],
  bytedance: ["bytedance", "doubao", "豆包", "字节跳动"],
  openrouter: ["openrouter"],
  ollama: ["ollama"],
  groq: ["groq"],
  azure: ["azure"],
  bedrock: ["bedrock", "aws"],
  vercel: ["vercel"],
  siliconcloud: ["siliconcloud", "siliconflow", "硅基流动"],
} as const;

export type Brand = keyof typeof brands;

export function recognizeBrand(text: string): Brand | null {
  const value = text.toLowerCase();
  for (const [brand, words] of Object.entries(brands) as [Brand, readonly string[]][]) {
    for (const word of words) {
      const pattern = new RegExp(`(?:^|[^a-z0-9])${word}(?=$|[^a-z0-9]|[0-9])`, "i");
      if (pattern.test(value)) return brand;
    }
  }
  return null;
}

/** 模型自己的名称优先于服务商名称。 */
export function modelBrand(id: string, name = "", providerId = "", providerName = ""): Brand | null {
  return recognizeBrand(id) ?? recognizeBrand(name) ?? recognizeBrand(providerId) ?? recognizeBrand(providerName);
}

/** 不认识的服务商只有在模型全部属于同一家时才使用该厂商。 */
export function providerBrand(id: string, name = "", models: readonly { id: string; name?: string }[] = []): Brand | null {
  const direct = recognizeBrand(id) ?? recognizeBrand(name);
  if (direct) return direct;
  const recognized = models.map((model) => recognizeBrand(model.id) ?? recognizeBrand(model.name ?? ""));
  return recognized.length && recognized[0] && recognized.every((brand) => brand === recognized[0]) ? recognized[0] : null;
}
