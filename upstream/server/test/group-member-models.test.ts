import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { groupModelPick } from "../src/models.ts";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";

describe("群成员模型", () => {
  it("没有可用模型时群资料显示全局设置", async () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", ownerId: "hob", members: ["hob"] });
      const pick = { ref: "missing/model", thinking: "off" as const };
      const modified = { ...group, models: { conversation: pick, work: pick } };
      vi.spyOn(hob.runtime.models, "find").mockReturnValue(undefined);
      const settings = hob.runtime.settings.settings.models;
      for (const key of ["conversation", "work"] as const) {
        expect(groupModelPick(hob.runtime.store.assistant("hob")!, modified, hob.runtime.models, settings, key)).toMatchObject({ source: "global", pick: settings[key] });
      }
    } finally { hob.close(); }
  });
  it("群和成员的模型覆盖复用字段解析", () => {
    const source = readFileSync(new URL("../src/groups.ts", import.meta.url), "utf8");
    expect(source.match(/checkAssistantModels\(\{ models:/g)).toHaveLength(1);
  });
  it("冷缓存下群资料和实际任务使用相同模型", async () => {
    const hob = makeHob({}, { memory: "off", models: [{ id: "base" }, { id: "group" }], settings: { models: { roster: ["base", "group"].map((id) => ({ ref: `hob-faux/${id}`, note: "" })) } } });
    try {
      const group = hob.runtime.groups.create({ name: "群", purpose: "测试", members: ["hob"], ownerId: "hob" });
      await hob.runtime.groups.updateModels(group.id, { work: { ref: "hob-faux/group", thinking: "off" } });
      hob.runtime.models.reset();
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const response = await app.request(`/api/groups/${group.id}/profile`, { headers: { cookie } });
      const profile = await response.json() as import("../../shared/types.ts").GroupProfile;
      const job = await hob.runtime.jobs.start("hob", { title: "测试", instruction: "测试", groupId: group.id });
      expect(profile.memberModels.hob!.work).toMatchObject({ source: "group", pick: { ref: job.model } });
    } finally { hob.close(); }
  });
  it("单聊、两个群及话题隔离会话和任务模型", async () => {
    const picks = ["fast", "smart", "eyes"];
    const hob = makeHob({}, { memory: "off", models: picks.map((id) => ({ id, input: ["text"] })), settings: { models: { roster: picks.map((id) => ({ ref: `hob-faux/${id}`, note: "" })) } } });
    try {
      const a = hob.runtime.groups.create({ name: "甲", purpose: "测试", members: ["hob"], ownerId: "hob" });
      const b = hob.runtime.groups.create({ name: "乙", purpose: "测试", members: ["hob"], ownerId: "hob" });
      const topic = hob.runtime.groups.createTopic(a.id, "话题", "user");
      const pick = (ref: string) => ({ ref: `hob-faux/${ref}`, thinking: "off" });
      await hob.runtime.groups.updateMemberModels(a.id, "hob", { conversation: pick("smart"), work: pick("smart") });
      await hob.runtime.groups.updateMemberModels(b.id, "hob", { conversation: pick("eyes"), work: pick("eyes") });
      const direct = await hob.runtime.router.ensure("hob");
      const first = await hob.runtime.router.ensure("hob", a.id);
      const second = await hob.runtime.router.ensure("hob", b.id);
      const topicState = await hob.runtime.router.ensure("hob", topic.id);
      expect([direct, first, second, topicState].map((state) => state.session?.model?.id)).toEqual(["fast", "smart", "eyes", "smart"]);
      const jobA = await hob.runtime.jobs.start("hob", { title: "甲任务", instruction: "测试", groupId: a.id });
      const jobB = await hob.runtime.jobs.start("hob", { title: "乙任务", instruction: "测试", groupId: b.id });
      expect([jobA.model, jobB.model]).toEqual(["hob-faux/smart", "hob-faux/eyes"]);
      const directSession = direct.session;
      const secondSession = second.session;
      await hob.runtime.groups.updateMemberModels(a.id, "hob", { conversation: pick("eyes"), work: pick("eyes") });
      expect((await hob.runtime.router.ensure("hob")).session).toBe(directSession);
      expect((await hob.runtime.router.ensure("hob", b.id)).session).toBe(secondSession);
      expect((await hob.runtime.router.ensure("hob", a.id)).session?.model?.id).toBe("eyes");
      expect(hob.runtime.store.job(jobA.id)?.model).toBe("hob-faux/smart");
      const other = { ...hob.runtime.store.assistant("hob")!, id: "other", name: "其他", primary: false };
      hob.runtime.store.saveAssistant(other);
      hob.runtime.groups.update(a.id, { members: ["hob", "other"] });
      await hob.runtime.groups.updateMemberModels(a.id, "other", { work: pick("smart") });
      hob.runtime.groups.update(a.id, { members: ["hob"] });
      expect(hob.runtime.store.group(a.id)?.memberModels?.other).toBeUndefined();
    } finally { hob.close(); }
  });

  it("群模型按成员、群、助手、全局取值并只释放本群会话", async () => {
    const picks = ["fast", "smart", "eyes"];
    const hob = makeHob({}, { memory: "off", models: picks.map((id) => ({ id, input: ["text"] })), settings: { models: { roster: picks.map((id) => ({ ref: `hob-faux/${id}`, note: "" })) } } });
    try {
      const a = hob.runtime.groups.create({ name: "甲", purpose: "测试", members: ["hob"], ownerId: "hob" });
      const b = hob.runtime.groups.create({ name: "乙", purpose: "测试", members: ["hob"], ownerId: "hob" });
      const topic = hob.runtime.groups.createTopic(a.id, "话题", "user");
      const pick = (id: string) => ({ ref: `hob-faux/${id}`, thinking: "off" });
      const direct = await hob.runtime.router.ensure("hob");
      const other = await hob.runtime.router.ensure("hob", b.id);
      await hob.runtime.router.ensure("hob", topic.id);
      await hob.runtime.groups.updateModels(topic.id, { conversation: pick("smart"), work: pick("smart") });
      expect((await hob.runtime.router.ensure("hob", topic.id)).session?.model?.id).toBe("smart");
      expect((await hob.runtime.router.ensure("hob")).session).toBe(direct.session);
      expect((await hob.runtime.router.ensure("hob", b.id)).session).toBe(other.session);
      await hob.runtime.groups.updateMemberModels(a.id, "hob", { conversation: pick("eyes") });
      expect((await hob.runtime.router.ensure("hob", a.id)).session?.model?.id).toBe("eyes");
      await hob.runtime.groups.updateMemberModels(a.id, "hob", { conversation: null });
      expect((await hob.runtime.router.ensure("hob", a.id)).session?.model?.id).toBe("smart");
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, models: { conversation: pick("eyes") as any } });
      await hob.runtime.groups.updateModels(a.id, { conversation: null });
      expect((await hob.runtime.router.ensure("hob", a.id)).session?.model?.id).toBe("eyes");
      hob.runtime.store.saveAssistant({ ...assistant });
      await hob.runtime.groups.updateModels(a.id, { conversation: null });
      expect((await hob.runtime.router.ensure("hob", a.id)).session?.model?.id).toBe("fast");
    } finally { hob.close(); }
  });

  it("群资料返回移除成员覆盖后的模型来源", async () => {
    const ids = ["fast", "smart", "eyes"];
    const hob = makeHob({}, { memory: "off", models: ids.map((id) => ({ id, input: ["text"] })), settings: { models: { roster: ids.map((id) => ({ ref: `hob-faux/${id}`, note: "" })) } } });
    try {
      const group = hob.runtime.groups.create({ name: "测试群", purpose: "测试", members: ["hob"], ownerId: "hob" });
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      const pick = (id: string) => ({ ref: `hob-faux/${id}`, thinking: "off" as const });
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, models: { conversation: pick("fast"), work: pick("fast") } });
      await hob.runtime.groups.updateModels(group.id, { conversation: pick("smart"), work: pick("smart") });
      await hob.runtime.groups.updateMemberModels(group.id, "hob", { conversation: pick("eyes"), work: pick("eyes") });
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const profile = async () => (await (await app.request(`/api/groups/${topic.id}/profile`, { headers: { cookie } })).json() as import("../../shared/types.ts").GroupProfile).memberModels.hob!;
      for (const key of ["conversation", "work"] as const) expect((await profile())[key]).toEqual({ source: "member", pick: pick("eyes"), inherited: { source: "group", pick: pick("smart") } });
      await hob.runtime.groups.updateModels(group.id, { conversation: null, work: null });
      for (const key of ["conversation", "work"] as const) expect((await profile())[key].inherited).toEqual({ source: "assistant", pick: pick("fast") });
      hob.runtime.store.saveAssistant({ ...assistant, models: undefined });
      const global = (await profile());
      for (const key of ["conversation", "work"] as const) expect(global[key].inherited).toEqual({ source: "global", pick: hob.runtime.settings.settings.models[key] });
      await hob.runtime.groups.updateMemberModels(group.id, "hob", { conversation: null, work: null });
      const following = await profile();
      for (const key of ["conversation", "work"] as const) expect(following[key].inherited).toEqual({ source: following[key].source, pick: following[key].pick });
    } finally { hob.close(); }
  });

  it("话题与所属群共用覆盖，清除和非成员校验", async () => {
    const hob = makeHob({}, { models: [{ id: "fast", input: ["text"] }, { id: "smart", input: ["text"] }], settings: { models: { roster: [{ ref: "hob-faux/fast", note: "" }, { ref: "hob-faux/smart", note: "" }] } } });
    try {
      const group = hob.runtime.groups.create({ name: "测试群", purpose: "测试", members: ["hob"], ownerId: "hob" });
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const patch = (id: string, assistant: string, body: unknown) => app.request(`/api/groups/${id}/members/${assistant}/models`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      expect((await patch(topic.id, "hob", { work: { ref: "hob-faux/smart", thinking: "off" } })).status).toBe(200);
      expect(hob.runtime.store.group(group.id)?.memberModels?.hob?.work?.ref).toBe("hob-faux/smart");
      expect(hob.runtime.store.group(topic.id)?.memberModels?.hob?.work?.ref).toBe("hob-faux/smart");
      expect((await patch(group.id, "other", { work: null })).status).toBe(400);
      expect((await patch(group.id, "hob", { work: null })).status).toBe(200);
      expect(hob.runtime.store.group(topic.id)?.memberModels?.hob).toBeUndefined();
    } finally { hob.close(); }
  });
});
