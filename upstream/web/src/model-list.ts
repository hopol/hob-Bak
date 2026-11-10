// 设置 → 模型「添加模型」和思考档的纯函数：按名字 / ref 过滤，按服务商分组，按模型的档收思考档。界面直接用，测试单独跑。
import type { ModelInfo, ThinkingLevel } from "../../shared/types.ts";

/** 思考档从低到高，和引擎的顺序一致（fitThinking 用）。 */
export const THINKING_ORDER: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 这个模型能选的思考档（引擎给的）：不会推理的模型只有 off。 */
export function thinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
  return model?.thinkingLevels ?? ["off"];
}

/** 换了模型后原来的档不在新模型的档里：往下取最近的一档；一档都没有才是 off。 */
export function fitThinking(model: ModelInfo | undefined, wants: ThinkingLevel): ThinkingLevel {
  const levels = thinkingLevels(model);
  if (!model || levels.includes(wants)) return wants;
  const rank = THINKING_ORDER.indexOf(wants);
  return [...levels].reverse().find((level) => THINKING_ORDER.indexOf(level) <= rank) ?? "off";
}

/** 按名字 / ref 过滤，不区分大小写；空串就是全部。 */
export function filterModels(models: ModelInfo[], query: string): ModelInfo[] {
  const q = query.trim().toLowerCase();
  if (!q) return models;
  return models.filter((model) => model.name.toLowerCase().includes(q) || model.ref.toLowerCase().includes(q));
}

/** 按服务商分组，服务商按第一次出现的顺序，组内保持原顺序。 */
export function groupByProvider(models: ModelInfo[]): { provider: string; models: ModelInfo[] }[] {
  const groups: { provider: string; models: ModelInfo[] }[] = [];
  for (const model of models) {
    let group = groups.find((item) => item.provider === model.provider);
    if (!group) {
      group = { provider: model.provider, models: [] };
      groups.push(group);
    }
    group.models.push(model);
  }
  return groups;
}
