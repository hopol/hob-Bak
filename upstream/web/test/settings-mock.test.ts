import { describe, expect, it } from "vitest";
import { createMock } from "../src/mock.ts";

describe("设置演示模式", () => {
  it("记忆提供者和其他设置共用 revision", async () => {
    const api = createMock();
    const memory = await api.memory();
    const changed = await api.putMemory(memory.revision, "off");
    const settings = await api.settings();
    expect(settings.revision).toBe(changed.revision);
    const saved = await api.putSettings(settings.revision, { work: { maxJobs: 3 } });
    expect((await api.memory()).revision).toBe(saved.revision);
  });

  it("助手规则可新增并校验空内容、超长和重复内容", async () => {
    const api = createMock();
    const original = await api.profile("hob");
    await expect(api.patchAssistant("hob", { rule: { text: " ", mode: "ask" } })).rejects.toThrow("规则内容不能为空");
    await expect(api.patchAssistant("hob", { rule: { text: "长".repeat(1001), mode: "ask" } })).rejects.toThrow("规则内容不能为空");
    await expect(api.patchAssistant("hob", { rule: { text: original.rules[0].text, mode: "ask" } })).rejects.toThrow("规则内容已存在");
    const result = await api.patchAssistant("hob", { rule: { text: "  发布前确认  ", mode: "allow" } });
    expect(result?.rule).toMatchObject({ text: "发布前确认", mode: "allow" });
    expect((await api.profile("hob")).rules.at(-1)).toMatchObject({ text: "发布前确认", mode: "allow" });
  });

  it("助手规则可编辑、切换模式并拒绝重复内容", async () => {
    const api = createMock();
    const profile = await api.profile("hob");
    const rule = profile.rules[0];
    await api.patchAssistant("hob", { rule: { id: rule.id, text: "新的规则", mode: "allow" } });
    expect((await api.profile("hob")).rules[0]).toMatchObject({ text: "新的规则", mode: "allow" });
    await expect(api.patchAssistant("hob", { rule: { id: rule.id, text: profile.rules[1].text } })).rejects.toThrow("规则内容已存在");
  });
});
