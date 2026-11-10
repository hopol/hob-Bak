import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, buildWorkerPrompt } from "../src/prompt.ts";
import { assistantJobResultEvent } from "../src/jobs.ts";
import { saveAssistantSkill } from "../src/assistant-skills.ts";
import { textOfContent } from "../src/transcript.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { registerAskTool, registerImageTool, registerReportTool } from "../src/worker-tools.ts";
import { DesktopToolSession } from "../src/desktop-tools.ts";
import { makeHob, call, text } from "./helpers.ts";

// 定稿只在开发仓库里（.scratch 不随公开版发布），没有就跳过逐字对照
const DOC = ".scratch/v2/design-prompts-v3.md";
const doc = existsSync(DOC) ? readFileSync(DOC, "utf8") : "";
const section = (start: string, end: string) => doc.split(start)[1]!.split(end)[0]!;
const line = (text: string, name: string) => text.split("\n").find((item) => item.startsWith(`**${name}**`))!.split("：").slice(1).join("：");

describe.skipIf(!doc)("第三版逐字对照", () => {
  it("助手和任务的固定段落与定稿完全一致", () => {
    const hob = makeHob();
    try {
      const store = hob.runtime.store;
      store.saveJob({ id: "t", assistantId: "hob", title: "测试", instruction: "", status: "done", createdAt: "", cwd: "/work", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      const options = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const, assistantSkillsDir: "/skills" };
      const routerSource = section("## 一、助手的系统提示词\n\n```\n", "\n```\n");
      const core = `用户读回复时${routerSource.split("用户读回复时")[1]!.split("你现在的技能：")[0]}`.trim().replace("{技能目录}", "/skills");
      const router = buildSystemPrompt(store, "hob", options);
      expect(router.slice(router.indexOf("用户读回复时"), router.indexOf("## 系统送来的消息")).trim()).toBe(core);
      const workerSource = section("## 二、任务的系统提示词\n\n```\n", "\n```\n");
      const workerCore = workerSource.split("派活时给你的技能")[0]!.trim().replaceAll("{助手}", "Hob").replace("{目录}", "/work");
      expect(buildWorkerPrompt(store, "t", options).startsWith(workerCore)).toBe(true);
    } finally { hob.close(); }
  });

  it("助手、任务和云桌面的工具说明与定稿逐字一致", () => {
    const hob = makeHob();
    try {
      const store = hob.runtime.store;
      const assistant = store.assistant("hob")!;
      store.saveAssistant({ ...assistant, id: "other", primary: false });
      hob.runtime.settings.setImage(hob.runtime.settings.get().revision, { source: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "fake" });
      hob.runtime.settings.setSearch(hob.runtime.settings.get().revision, [{ name: "searxng", enabled: true }]);
      const routerSource = section("## 三、助手的工具", "## 四、任务的工具");
      const workerSource = section("## 四、任务的工具", "## 五、沉淀时发给任务的话");
      const router = buildRouterTools(hob.runtime, "hob");
      for (const name of ["check_job", "save_job_as_skill", "edit_skill", "delete_skill", "read", "start_job", "reply_job", "stop_job", "ask_user", "set_rule", "remove_rule", "create_routine", "update_routine", "delete_routine", "send_file", "set_avatar", "generate_image", "overview", "propose_assistant", "message_assistant", "search_knowledge", "find_knowledge", "web_search", "web_fetch"]) {
        expect(router.find((tool) => tool.name === name)?.description, name).toBe(line(routerSource, name));
      }
      expect(router.find((tool) => tool.name === "show_page")?.description.startsWith(`${line(routerSource, "show_page")}\n`)).toBe(true);
      const secondary = buildRouterTools(hob.runtime, "other");
      expect(secondary.find((tool) => tool.name === "hand_back_to_hob")?.description).toBe(line(routerSource, "hand_back_to_hob"));
      const worker = [registerReportTool(hob.runtime, "t"), registerAskTool(hob.runtime, "t"), registerImageTool(hob.runtime, "t")];
      for (const tool of worker) expect(tool.description, tool.name).toBe(line(workerSource, tool.name));
      const outcomeSource = workerSource.split("\n").find((item) => item.startsWith("- `outcome`："))!.split("：").slice(1).join("：");
      expect(worker[0]!.parameters.properties.outcome.description).toBe(outcomeSource);
      const desktop = new DesktopToolSession(hob.runtime, "hob", true, undefined, true).tools();
      for (const tool of desktop) expect(tool.description, tool.name).toBe(line(routerSource, tool.name));
      const workerDesktop = new DesktopToolSession(hob.runtime, "hob", true, undefined, false).tools();
      expect(workerDesktop.find((tool) => tool.name === "browser_open")?.description).toBe(line(workerSource, "browser_open"));
      for (const tool of [...router, ...secondary, ...worker, ...desktop, ...workerDesktop]) expect(tool.promptSnippet, tool.name).toBeUndefined();
    } finally { hob.close(); }
  });

  it("结果里的沉淀提醒与定稿逐字一致", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const source = doc.split("\n").find((item) => item.startsWith("这个任务没带技能。"))!;
      const base = source.split("{上次")[0]!;
      const withSkill = source.replace("。{上次", "。上次").replace(/}$/, "");
      const job = { id: "t-copy", assistantId: "hob", title: "整理报告", instruction: "", status: "done" as const, createdAt: "", stats: { reads: 0, commands: 0, edits: 0 }, activity: [], summary: "好了" };
      hob.runtime.store.saveJob(job);
      expect(assistantJobResultEvent(hob.home, job).split("\n")[2]).toBe(base);
      saveAssistantSkill(hob.home, "hob", { name: "report-guide", title: "报告整理", description: "整理报告", content: "步骤" }, job.id);
      expect(assistantJobResultEvent(hob.home, job).split("\n")[2]).toBe(withSkill.replace("{标题}", "报告整理").replace("{name}", "report-guide"));
    } finally { hob.close(); }
  });

  it("沉淀时发给任务的话，开头和结尾与定稿逐字一致", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const source = section("## 五、沉淀时发给任务的话\n\n```\n", "\n```\n");
      const head = source.split("\n\n")[0]!;
      const tail = source.split("\n").at(-1)!;
      hob.runtime.store.saveJob({ id: "t-sed", assistantId: "hob", title: "测试", instruction: "整理报告", status: "done", createdAt: "", cwd: "/work", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([text("没有需要沉淀的")]);
      hob.runtime.jobs.startSediment("t-sed");
      await hob.runtime.jobs.waitIdle();
      const entries = readFileSync(hob.runtime.store.workerFile("t-sed"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
      const sent = entries.filter((entry) => entry.type === "message" && entry.message.role === "user").map((entry) => textOfContent(entry.message.content).trim()).at(-1)!;
      expect(sent.startsWith(`${head}\n\n`)).toBe(true);
      expect(sent.endsWith(tail)).toBe(true);
    } finally { hob.close(); }
  });

  it("沉淀做完的事件与定稿逐字一致，目录名只加在事件里", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const job = { id: "t-event", assistantId: "hob", title: "整理报告", instruction: "整理报告", status: "done" as const, createdAt: "", cwd: "/work", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] };
      hob.runtime.store.saveJob(job);
      const notify = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const line = doc.split("\n").find((item) => item.startsWith("**沉淀做完**"))!;
      const [created, updated] = line.split("沉淀完了：")[1]!.replace(/。$/, "").slice(1, -1).split("|");
      const fill = (text: string) => text.replace("X", "新报告整理").replace("{name}", "new-guide").replace("{N}", "2");
      expect(fill(created!)).toBe("已沉淀技能「新报告整理」（new-guide）");
      expect(fill(updated!)).toBe("已更新技能「新报告整理」（new-guide）· 第 2 版");
      hob.faux.setResponses([call("save_skill", { name: "new-guide", title: "新报告整理", description: "整理报告", content: "步骤" }), text("完成")]);
      hob.runtime.jobs.startSediment(job.id);
      await hob.runtime.jobs.waitIdle();
      expect(notify).toHaveBeenCalledWith("hob", `任务「整理报告」（${job.id}）沉淀完了：${fill(created!)}。`);
      hob.faux.setResponses([call("save_skill", { title: "新报告整理", description: "整理报告", content: "新步骤" }), text("完成")]);
      hob.runtime.jobs.startSediment(job.id, { into: "new-guide" });
      await hob.runtime.jobs.waitIdle();
      expect(notify).toHaveBeenCalledWith("hob", `任务「整理报告」（${job.id}）沉淀完了：${fill(updated!)}。`);
      const notes = hob.runtime.router.items("hob").items.filter((item) => item.kind === "note" && (item.text.startsWith("已沉淀技能") || item.text.startsWith("已更新技能"))).map((item) => (item.kind === "note" ? item.text : ""));
      expect(notes).toEqual(["已沉淀技能「新报告整理」", "已更新技能「新报告整理」· 第 2 版"]);
    } finally { hob.close(); }
  });
});
