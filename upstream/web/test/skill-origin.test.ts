import { describe, expect, it } from "vitest";
import { skillOriginText } from "../src/skill-origin.ts";

describe("技能来源", () => {
  const state = { jobs: { "t-1": { title: "整理记录" } }, assistants: [{ id: "a-1", name: "资料助手" }], groups: [{ id: "g-1", name: "资料组" }] } as never;
  it("显示任务、单聊和群聊，旧字段继续可读", () => {
    expect(skillOriginText({ origin: { kind: "job", jobId: "t-1" } }, state)).toBe("来自任务 整理记录");
    expect(skillOriginText({ fromJobId: "t-1" }, state)).toBe("来自任务 整理记录");
    expect(skillOriginText({ origin: { kind: "assistant", assistantId: "a-1" } }, state)).toBe("来自和 资料助手 的对话");
    expect(skillOriginText({ origin: { kind: "assistant", assistantId: "a-1", groupId: "g-1" } }, state)).toBe("来自和 资料组 的对话");
  });
});
