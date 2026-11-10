import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Assistant, Job } from "../../shared/types.ts";
import { archiveAssistant } from "../src/actions.ts";
import { makeHob, text, type TestHob } from "./helpers.ts";

function addAssistant(hob: TestHob, id: string, extra: Partial<Assistant> = {}): Assistant {
  const assistant: Assistant = {
    id,
    name: "写作",
    duty: "周报和文章",
    sprite: "page",
    primary: false,
    pinned: false,
    hidden: false,
    notify: true,
    instructions: "",
    createdAt: new Date().toISOString(),
    ...extra,
  };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

function addJob(hob: TestHob, id: string, assistantId: string, status: Job["status"]): Job {
  const job: Job = {
    id,
    assistantId,
    title: "写周报",
    instruction: "写这周的周报",
    status,
    createdAt: new Date().toISOString(),
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
  };
  hob.runtime.store.saveJob(job);
  return job;
}

describe("归档助手", () => {
  it("目录和定时进归档，定时停掉，什么都不转给主助手", async () => {
    const hob = makeHob();
    try {
      const assistant = addAssistant(hob, "writer", { instructions: "先列要点，再展开" });
      hob.runtime.settings.setDesktop(hob.runtime.settings.get().revision, { url: "", enabled: false, publicAssistants: ["hob", "writer"] });
      const now = new Date().toISOString();
      hob.runtime.store.saveRules("writer", [{ id: "r-w1", text: "发布公众号", mode: "ask", changedAt: now }]);
      const routine = hob.runtime.routines.create({
        assistantId: "writer",
        name: "周报",
        instruction: "每周五写一份周报",
        schedules: ["0 17 * * 5"],
      });
      // 这个助手已经有一段对话：会话文件跟着进归档
      hob.faux.setResponses([text("好的，每周五写周报。")]);
      await hob.runtime.router.send("writer", { text: "以后每周五写周报" });
      await hob.runtime.router.waitIdle("writer");
      expect(existsSync(hob.runtime.store.routerFile("writer"))).toBe(true);
      addJob(hob, "t-old", "writer", "done");
      const hobBefore = hob.runtime.store.assistant("hob")!;
      const removed: string[] = [];
      hob.runtime.bus.subscribe((event) => { if (event.type === "routine_removed") removed.push(event.id); });

      const result = await archiveAssistant(hob.runtime, "writer");
      expect(result.status).toBe(200);

      // 助手没了，定时停掉、从列表里拿掉
      expect(hob.runtime.store.assistant("writer")).toBeUndefined();
      expect(hob.runtime.settings.settings.desktop?.publicAssistants).toEqual(["hob"]);
      expect(hob.runtime.store.routine(routine.id)).toBeUndefined();
      expect(hob.runtime.routines.nextRuns(routine.id)).toHaveLength(0);
      expect(removed).toEqual([routine.id]);

      // 主助手原样：没有规则、定时、补充说明，也没在它的对话里写东西
      expect(hob.runtime.store.rules("hob")).toHaveLength(0);
      expect(hob.runtime.router.profile("hob").routines).toHaveLength(0);
      expect(hob.runtime.store.assistant("hob")!.instructions).toBe(hobBefore.instructions);
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "note")).toHaveLength(0);

      // 归档：整个目录移进 archive/assistants/<id>-<时间>/，档案、规则、对话、定时都在
      const root = join(hob.home, "archive", "assistants");
      const dirs = readdirSync(root);
      expect(dirs).toHaveLength(1);
      expect(dirs[0]!.startsWith("writer-")).toBe(true);
      const archived = join(root, dirs[0]!);
      expect(JSON.parse(readFileSync(join(archived, "profile.json"), "utf8")).name).toBe("写作");
      expect(JSON.parse(readFileSync(join(archived, "rules.json"), "utf8"))[0].text).toBe("发布公众号");
      expect(JSON.parse(readFileSync(join(archived, "routines.json"), "utf8"))[0]).toMatchObject({ id: routine.id, name: "周报" });
      expect(readFileSync(join(archived, "router.jsonl"), "utf8")).toContain("以后每周五写周报");
      expect(existsSync(join(hob.home, "assistants", "writer"))).toBe(false);

      // 历史任务留在 jobs/，详情里照样有助手名
      expect(hob.runtime.store.job("t-old")!.assistantName).toBe(assistant.name);
    } finally {
      hob.close();
    }
  });

  it("主助手、不存在的助手都拒绝，并给出原因", async () => {
    const hob = makeHob();
    try {
      const primary = await archiveAssistant(hob.runtime, "hob");
      expect(primary.status).toBe(400);
      expect(primary.body).toMatchObject({ error: "主助手不能归档" });

      const missing = await archiveAssistant(hob.runtime, "nobody");
      expect(missing.status).toBe(404);
      expect(missing.body).toMatchObject({ error: "助手不存在" });
    } finally {
      hob.close();
    }
  });

  it("有进行中 / 排队 / 等待确认的任务时拒绝归档", async () => {
    const hob = makeHob();
    try {
      addAssistant(hob, "writer");
      for (const status of ["running", "queued", "waiting"] as const) {
        const job = addJob(hob, `t-${status}`, "writer", status);
        const result = await archiveAssistant(hob.runtime, "writer");
        expect(result.status).toBe(409);
        expect(result.body).toMatchObject({ error: "请等任务结束后再归档" });
        // 拒绝了就什么都没动
        expect(hob.runtime.store.assistant("writer")).toBeDefined();
        hob.runtime.store.saveJob({ ...job, status: "done" });
      }
      expect((await archiveAssistant(hob.runtime, "writer")).status).toBe(200);
    } finally {
      hob.close();
    }
  });

  it("没配好模型也能归档：不碰主助手的对话", async () => {
    const hob = makeHob();
    try {
      addAssistant(hob, "writer");
      hob.runtime.settings.patch(hob.runtime.settings.get().revision, {
        models: { roster: [], conversation: { ref: "", thinking: "off" }, work: { ref: "", thinking: "off" } },
      });
      expect((await archiveAssistant(hob.runtime, "writer")).status).toBe(200);
      expect(hob.runtime.store.assistant("writer")).toBeUndefined();
    } finally {
      hob.close();
    }
  });
});
