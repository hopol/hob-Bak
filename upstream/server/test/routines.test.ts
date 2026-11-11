import { describe, expect, it } from "vitest";
import { call, makeHob, text } from "./helpers.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { saveAssistantSkill } from "../src/assistant-skills.ts";
import { createApp } from "../src/http.ts";

describe("群定时", () => {
  it("启动时把旧群定时迁到群主名下", () => {
    const hob = makeHob();
    try {
      const base = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...base, id: "ops", primary: false });
      const group = hob.runtime.groups.create({ name: "团队", purpose: "协作", ownerId: "hob", members: ["hob", "ops"] });
      const routine = hob.runtime.routines.create({ assistantId: "hob", groupId: group.id, name: "检查", instruction: "检查", schedules: ["0 9 * * *"] });
      hob.runtime.store.saveRoutine({ ...routine, assistantId: "ops" });
      hob.runtime.routines.start();
      expect(hob.runtime.store.routine(routine.id)?.assistantId).toBe("hob");
    } finally { hob.close(); }
  });

  it("接口建群定时自动使用群主，修改负责人返回 400", async () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "团队", purpose: "协作", ownerId: "hob", members: ["hob"] });
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const headers = { cookie, "content-type": "application/json" };
      const created = await app.request("/api/routines", { method: "POST", headers, body: JSON.stringify({ groupId: group.id, name: "检查", instruction: "检查", schedules: ["0 9 * * *"] }) });
      expect(created.status).toBe(200);
      const body = await created.json() as { routine: { id: string; assistantId: string } };
      expect(body.routine.assistantId).toBe("hob");
      const patch = await app.request(`/api/routines/${body.routine.id}`, { method: "PATCH", headers, body: JSON.stringify({ assistantId: "hob" }) });
      expect(patch.status).toBe(400);
      expect(await patch.json()).toEqual({ error: "群的定时由群主处理" });
    } finally { hob.close(); }
  });
  it("群主接收定时，换群主时同步并清除不可用技能", async () => {
    const hob = makeHob();
    try {
      const main = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...main, id: "ops", name: "服务器", primary: false });
      const group = hob.runtime.groups.create({ name: "团队", purpose: "协作", ownerId: "hob", members: ["hob", "ops"] });
      const topic = hob.runtime.groups.createTopic(group.id, "话题", "user");
      saveAssistantSkill(hob.home, "hob", { name: "ops-skill", title: "服务器技能", description: "检查服务器", content: "步骤" });
      const tool = buildRouterTools(hob.runtime, "ops", topic.id).find((item) => item.name === "create_routine")!;
      expect(tool.parameters.properties).not.toHaveProperty("by");
      const result = await tool.execute("routine", { name: "检查", instruction: "检查", schedules: ["0 9 * * *"], skill: "ops-skill" });
      expect(result.isError).not.toBe(true);
      const routine = hob.runtime.store.routines()[0]!;
      expect(routine).toMatchObject({ assistantId: "hob", groupId: topic.id });
      expect(() => hob.runtime.routines.update(routine.id, { assistantId: "ops" })).toThrow("群的定时由群主处理");
      const delivered: { gid: string; aid: string; event: string; trigger?: string }[] = [];
      hob.runtime.groups.deliverEvent = async (gid, aid, event, trigger) => { delivered.push({ gid, aid, event, trigger }); };
      expect(await hob.runtime.routines.runNow(routine.id)).toEqual({ outcome: "handed" });
      const note = hob.runtime.groups.items(topic.id).items.find((item) => item.kind === "note" && item.text.includes("到点了"))!;
      expect(delivered[0]).toMatchObject({ gid: topic.id, aid: "hob", trigger: note.id, event: expect.stringContaining("绑定的技能：ops-skill") });
      expect(hob.runtime.store.jobs()).toHaveLength(0);
      expect(hob.runtime.store.routine(routine.id)?.runs[0]).toMatchObject({ status: "handed" });
      hob.runtime.routines.update(routine.id, { check: { script: "printf 'issue 1\\nissue 2'", then: "job" } });
      expect((await hob.runtime.routines.runNow(routine.id)).outcome).toBe("handed");
      expect(delivered[1]?.event).toContain("issue 1\nissue 2");
      hob.runtime.routines.update(routine.id, { check: { script: "printf hello", then: "notify" } });
      expect((await hob.runtime.routines.runNow(routine.id)).outcome).toBe("notify");
      expect(delivered).toHaveLength(2);
      expect(hob.runtime.groups.items(topic.id).items).toContainEqual(expect.objectContaining({ kind: "assistant", text: "hello", speaker: "hob" }));
      hob.runtime.groups.update(group.id, { ownerId: "ops" });
      expect(hob.runtime.store.routine(routine.id)).toMatchObject({ assistantId: "ops", groupId: topic.id });
      expect(hob.runtime.store.routine(routine.id)?.skill).toBeUndefined();
      expect(hob.runtime.groups.items(group.id).items).toContainEqual(expect.objectContaining({ kind: "note", text: expect.stringContaining("已解除绑定") }));
    } finally { hob.close(); }
  });
});

describe("定时", () => {
  it("创建、改时间即时生效、立即跑一次并记 runs", async () => {
    const hob = makeHob();
    try {
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        name: "每日简报",
        instruction: "看看今天的新闻",
        schedules: ["0 9 * * *"],
      });
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(1);

      const updated = hob.runtime.routines.update(routine.id, { schedules: ["0 9 * * *", "0 21 * * *"] });
      expect(updated.schedules).toEqual(["0 9 * * *", "0 21 * * *"]);
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(2);

      // 关掉就不排了
      hob.runtime.routines.update(routine.id, { active: false });
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(0);
      hob.runtime.routines.update(routine.id, { active: true });

      hob.faux.setResponses([
        call("report", { outcome: "done", result: "今天 6 条" }),
        text("简报好了。"),
        text("好"),
      ]);
      const job = (await hob.runtime.routines.runNow(routine.id)).job!;
      expect(job.routineId).toBe(routine.id);
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "job" && item.jobId === job.id)).toHaveLength(1);
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");

      const saved = hob.runtime.store.routine(routine.id)!;
      const finished = hob.runtime.store.job(job.id)!;
      expect(saved.runs[0]).toMatchObject({ jobId: job.id, status: "done", durationMs: finished.durationMs, tools: finished.stats.reads + finished.stats.commands + finished.stats.edits, tokens: finished.usage!.input + finished.usage!.output });

      // 定时结果的回复带 routine 标记
      const items = hob.runtime.router.items("hob").items;
      const reply = items.filter((item) => item.kind === "assistant").pop();
      expect(reply).toMatchObject({ kind: "assistant", routine: { id: routine.id, name: "每日简报", jobId: job.id } });

      hob.faux.setResponses([call("report", { outcome: "done", result: "继续完成" }), text("完成了。"), text("好")]);
      await hob.runtime.jobs.reply(job.id, "继续做");
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "job" && item.jobId === job.id)).toHaveLength(2);
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
    } finally {
      hob.close();
    }
  });

  it("非法 cron 报错，不建定时", () => {
    const hob = makeHob();
    try {
      expect(() =>
        hob.runtime.routines.create({
          assistantId: "hob",
          name: "坏定时",
          instruction: "x",
          schedules: ["不是 cron"],
        }),
      ).toThrow(/cron/);
      expect(hob.runtime.store.routines()).toHaveLength(0);
    } finally {
      hob.close();
    }
  });

  it("删掉定时后不再排", () => {
    const hob = makeHob();
    try {
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        name: "临时",
        instruction: "x",
        schedules: ["0 9 * * *"],
      });
      hob.runtime.routines.remove(routine.id);
      expect(hob.runtime.store.routine(routine.id)).toBeUndefined();
      expect(hob.runtime.routines.nextRuns(routine.id)).toEqual([]);
    } finally {
      hob.close();
    }
  });
});

describe("检查脚本试跑", () => {
  it("建定时时试跑一次，脚本写错当场告诉模型，写对就记下现状", async () => {
    const hob = makeHob();
    try {
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "create_routine")!;
      const said = (result: { content: unknown[] }) => (result.content as { text?: string }[]).map((part) => part.text ?? "").join("");
      const bad = said((await tool.execute("bad", { name: "坏脚本", instruction: "看看", schedules: ["0 9 * * *"], check: { script: "import json\nprint(json.dumps(1))", then: "job" } })));
      expect(bad).toContain("检查脚本试跑失败");
      expect(hob.runtime.store.routines().some((routine) => routine.name === "坏脚本")).toBe(true);
      const good = said((await tool.execute("good", { name: "好脚本", instruction: "看看", schedules: ["0 9 * * *"], check: { script: "test -f seen || touch seen", then: "job" } })));
      expect(good).toContain("检查脚本试跑通过");
      const routine = hob.runtime.store.routines().find((item) => item.name === "好脚本")!;
      expect(routine.checks?.total ?? 0).toBe(0);
    } finally { hob.close(); }
  });
});
