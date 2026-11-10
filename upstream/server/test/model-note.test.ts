import { describe, expect, it } from "vitest";
import { guessModelScores, scoreLabel } from "../../shared/model-note.ts";
import { noteOf } from "../src/models.ts";
import { makeHob } from "./helpers.ts";

const model = { id: "unknown", name: "Unknown", reasoning: false };

describe("模型评分", () => {
  it.each([
    ["gemini-flash", { smart: 60, cost: 20, speed: 85 }],
    ["gpt-5-mini", { smart: 40, cost: 10, speed: 95 }],
    ["claude-haiku", { smart: 40, cost: 10, speed: 95 }],
    ["model-lite", { smart: 40, cost: 10, speed: 95 }],
    ["gpt-6", { smart: 90, cost: 80, speed: 40 }],
    ["claude-opus", { smart: 90, cost: 80, speed: 40 }],
    ["gemini-pro", { smart: 90, cost: 80, speed: 40 }],
    ["model-sol", { smart: 90, cost: 80, speed: 40 }],
  ])("按家族推测 %s", (id, expected) => expect(guessModelScores({ ...model, id })).toEqual(expected));
  it("未知模型按推理能力推测", () => {
    expect(guessModelScores(model)).toEqual({ smart: 50, cost: 50, speed: 60 });
    expect(guessModelScores({ ...model, reasoning: true })).toEqual({ smart: 70, cost: 50, speed: 50 });
  });
  it("使用最近的阶段档", () => {
    expect(scoreLabel("smart", 60)).toBe("较聪明");
    expect(scoreLabel("smart", 75)).toBe("很聪明");
    expect(scoreLabel("cost", 0)).toBe("免费");
    expect(scoreLabel("speed", 90)).toBe("很快");
  });
  it("旧数据按模型推测，保留说明并显示实际能力", async () => {
    const hob = makeHob({}, { models: [{ id: "flash", input: ["text", "image"] }] });
    try {
      await hob.runtime.models.get();
      const info = hob.runtime.models.find("hob-faux/flash")!;
      const text = noteOf({ ref: info.ref, note: "我的说明" }, hob.runtime.models);
      expect(text).toBe("聪明 60% · 成本 20% · 速度 85% · 能看图 · 上下文 200K · 补充：我的说明");
      expect(noteOf({ ref: info.ref, note: "", scores: { smart: 1, cost: 2, speed: 3 } }, hob.runtime.models)).toBe("聪明 1% · 成本 2% · 速度 3% · 能看图 · 上下文 200K");
    } finally { hob.close(); }
  });
});
