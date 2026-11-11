import { describe, expect, it } from "vitest";
import { createMock } from "../src/mock.ts";
import { followingModel, routineSkills, routineSummary, sidebarInfoValues } from "../src/sidebar-data.ts";
import type { AssistantSkill } from "../../shared/skills.ts";

describe("群资源", () => {
  it("群信息汇总定时、技能和规则", async () => {
    const api = createMock("g-owns");
    const profile = await api.groupProfile("g-dev");
    const skills = await api.groupSkills("g-dev");
    const routines = (await api.bootstrap()).routines.filter((r) => r.groupId === "g-dev" || r.groupId === "g-owns-topic");
    expect(routineSummary(routines, "UTC")).toMatch(/^2 个 · /);
    expect(sidebarInfoValues(skills.length, [], profile.rules.length)).toMatchObject({ skills: "3 个", rules: "2 条" });
  });

  it("模型来源和实际模型从群资料返回", async () => {
    const api = createMock("g-owns");
    const group = (await api.groupProfile("g-dev")).group;
    const member = group.members[0]!;
    const pick = { ref: "demo/model", thinking: "high" as const };
    await api.patchGroup("g-dev", { models: { conversation: pick } });
    expect((await api.groupProfile("g-dev")).memberModels[member]?.conversation).toEqual({ source: "group", pick, inherited: { source: "group", pick } });
    const override = { ref: "demo/override", thinking: "high" as const };
    await api.patchGroupMemberModels("g-dev", member, { conversation: override });
    expect((await api.groupProfile("g-dev")).memberModels[member]?.conversation).toEqual({ source: "member", pick: override, inherited: { source: "group", pick } });
    await api.patchGroupMemberModels("g-dev", member, { conversation: null });
    await api.patchGroup("g-dev", { models: { conversation: null } });
    expect(["assistant", "global"]).toContain((await api.groupProfile("g-dev")).memberModels[member]?.conversation.source);
  });

  it("继承模型文字按服务端来源显示", () => {
    expect(followingModel("group", "模型甲")).toEqual({ text: "跟随本群 · 模型甲", option: "跟随本群（模型甲）" });
    expect(followingModel("assistant", "模型乙")).toEqual({ text: "跟随助手 · 模型乙", option: "跟随助手（模型乙）" });
    expect(followingModel("global", "模型丙").text).toBe("跟随助手 · 模型丙");
  });

  it("换做事成员时使用新成员的技能，本群技能排在前面", () => {
    const skill = (name: string) => ({ name, title: name, enabled: true }) as AssistantSkill;
    const group = [skill("team")];
    expect(routineSkills(group, [skill("first")]).map((item) => [item.skill.name, item.group])).toEqual([["team", true], ["first", false]]);
    expect(routineSkills(group, [skill("second")]).map((item) => [item.skill.name, item.group])).toEqual([["team", true], ["second", false]]);
  });

  it("群定时不允许更换执行成员，由群主处理", async () => {
    const api = createMock("g-owns");
    const routine = (await api.bootstrap()).routines.find((item) => item.groupId === "g-dev");
    expect(routine).toBeTruthy();
    await expect(api.patchRoutine(routine!.id, { assistantId: "other" })).rejects.toThrow("群的定时由群主处理");
  });

  it("按群和单聊筛选任务", async () => {
    const api = createMock("g-owns");
    expect((await api.jobs({ groupId: "g-dev" })).jobs.filter((job) => job.id.startsWith("owns-job-")).length).toBe(5);
    expect((await api.jobs({ groupId: "none" })).jobs.every((job) => !job.groupId)).toBe(true);
  });
});
