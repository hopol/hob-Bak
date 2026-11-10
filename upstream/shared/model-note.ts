import type { ModelScores } from "./types.ts";

export const SCORE_STAGES = {
  smart: [{ value: 25, label: "一般" }, { value: 50, label: "较聪明" }, { value: 75, label: "很聪明" }, { value: 100, label: "最聪明" }],
  cost: [{ value: 0, label: "免费" }, { value: 20, label: "很低" }, { value: 50, label: "中等" }, { value: 75, label: "较高" }, { value: 100, label: "特别贵" }],
  speed: [{ value: 25, label: "较慢" }, { value: 50, label: "中等" }, { value: 75, label: "较快" }, { value: 100, label: "很快" }],
} as const;

// 只按公开的模型家族名称推测；轻量型号优先于 pro 等宽泛规则。
export function guessModelScores(model: { id: string; name: string; reasoning: boolean }): ModelScores {
  const name = `${model.id} ${model.name}`;
  if (/(?:^|[^a-z])mini|haiku|lite/i.test(name)) return { smart: 40, cost: 10, speed: 95 };
  if (/flash/i.test(name)) return { smart: 60, cost: 20, speed: 85 };
  if (/gpt[-\s]?[56](?:\D|$)|opus|pro|sol/i.test(name)) return { smart: 90, cost: 80, speed: 40 };
  return model.reasoning ? { smart: 70, cost: 50, speed: 50 } : { smart: 50, cost: 50, speed: 60 };
}

export function scoreLabel(kind: keyof ModelScores, value: number): string {
  return SCORE_STAGES[kind].reduce((closest, stage) => Math.abs(stage.value - value) < Math.abs(closest.value - value) ? stage : closest).label;
}

export function scoreSummary(scores: ModelScores): string {
  return `聪明 ${scores.smart}% · 成本 ${scores.cost}% · 速度 ${scores.speed}%`;
}

export function contextText(contextWindow: number): string {
  if (contextWindow >= 1_000_000) {
    const millions = contextWindow / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  return `${Math.round(contextWindow / 1000)}K`;
}
