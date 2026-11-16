import { describe, expect, it } from "vitest";
import type { Routine } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

const AT = "2026-11-08T02:00:00.000Z";

/** 三人群：Hob（群主）、记账。 */
function groupHob() {
  const hob = makeHob({}, { memory: "off" });
  const base = hob.runtime.store.assistant("hob")!;
  hob.runtime.store.saveAssistant({ ...base, id: "books", name: "记账", primary: false });
  const group = hob.runtime.groups.create({ name: "社区菜园", purpose: "采购和记账", ownerId: "hob", members: ["hob", "books"], workflow: "software" });
  return { hob, group };
}

async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function routineOf(hob: TestHob, name: string): Routine {
  const found = hob.runtime.store.routines().find((routine) => routine.name === name);
  if (!found) throw new Error(`没有这个定时任务：${name}`);
  return found;
}

/** 群里说一句，等群主这一轮把工具调完：群里的回合是排上去的，等它的结果出来再往下走。 */
async function sayInGroup(hob: TestHob, groupId: string, said: string, tools: unknown[], done: () => boolean) {
  hob.faux.setResponses([...(tools as never[]), text("好")]);
  await hob.runtime.groups.send(groupId, { text: said });
  await waitFor(done, 15_000);
  await hob.runtime.router.waitIdle("hob", 15_000, groupId);
}

describe("定时任务记下用户的原话和要做的事是谁写的", () => {
  it("工具建：instructionBy 是当前助手，userWords 是这一轮用户说的那句话", async () => {
    const { hob, group } = groupHob();
    try {
      await sayInGroup(hob, group.id, "以后每 10 分钟看一下订单目录", [call("create_routine", { name: "盯新订单", instruction: "看新订单，价格让记账核", schedules: ["*/10 * * * *"] })], () => hob.runtime.store.routines().some((item) => item.name === "盯新订单"));
      const routine = routineOf(hob, "盯新订单");
      expect(routine.instructionBy).toBe("hob");
      expect(routine.userWords).toEqual([{ text: "以后每 10 分钟看一下订单目录", at: expect.any(String) }]);
    } finally { hob.close(); }
  });

  it("工具建（单聊）：原话取这一轮的用户消息，引用也带上", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([call("create_routine", { name: "写日报", instruction: "写日报", schedules: ["0 18 * * *"] }), text("好")]);
      await hob.runtime.router.send("hob", { text: "每天下午六点写日报", quote: { itemId: "q-1", text: "周报模板" } });
      await hob.runtime.router.waitIdle("hob");
      const routine = routineOf(hob, "写日报");
      expect(routine.instructionBy).toBe("hob");
      expect(routine.userWords?.[0]?.text).toBe("每天下午六点写日报\n（引用：「周报模板」）");
    } finally { hob.close(); }
  });

  it("工具改：改了内容之后再改时间也照记；只改时间不动 instructionBy", async () => {
    const { hob, group } = groupHob();
    try {
      await sayInGroup(hob, group.id, "以后每 10 分钟看一下订单目录", [call("create_routine", { name: "盯新订单", instruction: "看新订单", schedules: ["*/10 * * * *"] })], () => hob.runtime.store.routines().some((item) => item.name === "盯新订单"));
      const routine = routineOf(hob, "盯新订单");
      await sayInGroup(hob, group.id, "改成 8 点看", [call("update_routine", { routineId: routine.id, schedules: ["0 8 * * *"] })], () => (routineOf(hob, "盯新订单").userWords ?? []).length === 2);
      expect(routineOf(hob, "盯新订单").instructionBy).toBe("hob");
      expect(routineOf(hob, "盯新订单").userWords?.map((word) => word.text)).toEqual(["以后每 10 分钟看一下订单目录", "改成 8 点看"]);
      await sayInGroup(hob, group.id, "价格还是你们核对，别自己算", [call("update_routine", { routineId: routine.id, instruction: "看新订单，价格让记账核" })], () => routineOf(hob, "盯新订单").instruction === "看新订单，价格让记账核");
      expect(routineOf(hob, "盯新订单").instructionBy).toBe("hob");
      expect(routineOf(hob, "盯新订单").userWords?.map((word) => word.text)).toEqual(["以后每 10 分钟看一下订单目录", "改成 8 点看", "价格还是你们核对，别自己算"]);
    } finally { hob.close(); }
  });

  it("原话只留最近 3 条", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const routine = hob.runtime.routines.create({ assistantId: "hob", name: "巡检", instruction: "看一眼", schedules: ["0 9 * * *"], instructionBy: "hob" });
      for (const said of ["第一句", "第二句", "第三句", "第四句", "第五句"]) {
        hob.runtime.routines.update(routine.id, { userWords: [{ text: said, at: new Date().toISOString() }] });
      }
      expect(routineOf(hob, "巡检").userWords?.map((word) => word.text)).toEqual(["第三句", "第四句", "第五句"]);
    } finally { hob.close(); }
  });

  it("界面上建：「要做的事」是用户自己写的，没有原话；只改时间不动它", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const created = await app.request("/api/routines", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ assistantId: "hob", name: "日报", instruction: "写日报", schedules: ["0 18 * * *"] }),
      });
      expect(created.status).toBe(200);
      const { routine } = await created.json() as { routine: Routine };
      expect(routine.instructionBy).toBe("user");
      expect(routine.userWords).toBeUndefined();
      const patched = await app.request(`/api/routines/${routine.id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ schedules: ["0 9 * * *"] }),
      });
      expect(patched.status).toBe(200);
      expect(routineOf(hob, "日报").instructionBy).toBe("user");
    } finally { hob.close(); }
  });

  it("界面上改：内容变了算用户自己写的，清掉原话；整张表单内容没变的不算改", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const routine = hob.runtime.routines.create({
        assistantId: "hob", name: "日报", instruction: "写日报", schedules: ["0 18 * * *"],
        instructionBy: "hob", userWords: [{ text: "每天下午六点写日报", at: AT }],
      });
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const patch = (body: Record<string, unknown>) => app.request(`/api/routines/${routine.id}`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      // 界面整张表单一起提交，内容没变
      expect((await patch({ name: "日报", instruction: "写日报", schedules: ["0 19 * * *"] })).status).toBe(200);
      expect(routineOf(hob, "日报").instructionBy).toBe("hob");
      expect(routineOf(hob, "日报").userWords?.length).toBe(1);
      // 内容改了：用户自己写的，旧原话清掉
      expect((await patch({ name: "日报", instruction: "写日报，只写做了什么", schedules: ["0 19 * * *"] })).status).toBe(200);
      expect(routineOf(hob, "日报").instructionBy).toBe("user");
      expect(routineOf(hob, "日报").userWords).toBeUndefined();
    } finally { hob.close(); }
  });

  it("到点那一轮里改定时任务：来由是定时记录，不追加原话", async () => {
    const { hob, group } = groupHob();
    try {
      const routine = hob.runtime.routines.create({
        assistantId: "hob", groupId: group.id, name: "盯新订单", instruction: "看新订单", schedules: ["*/10 * * * *"],
        instructionBy: "hob", userWords: [{ text: "以后每 10 分钟看一下订单目录", at: AT }],
      });
      hob.faux.setResponses([call("update_routine", { routineId: routine.id, instruction: "看新订单，价格让记账核" }), text("好")]);
      await hob.runtime.routines.runNow(routine.id);
      await waitFor(() => routineOf(hob, "盯新订单").instruction === "看新订单，价格让记账核");
      expect(routineOf(hob, "盯新订单").userWords?.map((word) => word.text)).toEqual(["以后每 10 分钟看一下订单目录"]);
    } finally { hob.close(); }
  });

  it("单聊里事件那一轮改定时任务：来由还是这一轮对应的那条用户消息，记的就是它", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([call("create_routine", { name: "写日报", instruction: "写日报", schedules: ["0 18 * * *"] }), text("好")]);
      await hob.runtime.router.send("hob", { text: "每天下午六点写日报" });
      await hob.runtime.router.waitIdle("hob");
      const routine = routineOf(hob, "写日报");
      hob.faux.setResponses([call("update_routine", { routineId: routine.id, instruction: "写日报，只写做了什么" }), text("好")]);
      await hob.runtime.router.event("hob", "任务「写日报」已完成");
      await hob.runtime.router.waitIdle("hob");
      expect(routineOf(hob, "写日报").instructionBy).toBe("hob");
      // 事件那一轮的单聊来由就是最近那条用户消息（和 start_job 带原话同一个来由）；和上次记的是同一句，不重复记
      expect(routineOf(hob, "写日报").userWords?.map((word) => word.text)).toEqual(["每天下午六点写日报"]);
    } finally { hob.close(); }
  });

  it("换技能、启停这类改动不动这两项", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const routine = hob.runtime.routines.create({
        assistantId: "hob", name: "日报", instruction: "写日报", schedules: ["0 18 * * *"],
        instructionBy: "hob", userWords: [{ text: "每天下午六点写日报", at: AT }],
      });
      hob.runtime.routines.update(routine.id, { active: false });
      expect(routineOf(hob, "日报")).toMatchObject({ instructionBy: "hob", userWords: [{ text: "每天下午六点写日报", at: AT }] });
    } finally { hob.close(); }
  });
});
