import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSystemPrompt, buildWorkerPrompt } from "../src/prompt.ts";
import { assistantJobResultEvent, sedimentMessage } from "../src/jobs.ts";
import { saveAssistantSkill } from "../src/assistant-skills.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { registerAskTool, registerImageTool, registerReportTool } from "../src/worker-tools.ts";
import { DesktopToolSession } from "../src/desktop-tools.ts";
import { makeHob } from "./helpers.ts";

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
      for (const name of ["check_job", "save_job_as_skill", "edit_skill", "delete_skill", "read", "start_job", "reply_job", "stop_job", "ask_user", "set_rule", "remove_rule", "create_routine", "update_routine", "delete_routine", "send_file", "set_avatar", "generate_image", "overview", "create_assistant", "message_assistant", "search_knowledge", "find_knowledge", "web_search", "web_fetch"]) {
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

  it("沉淀时发给任务的话，前四段与定稿逐字一致", () => {
    // 票 154 把第五段起的写法换了，定稿还没替换，这里只对前四段
    const source = section("## 五、沉淀时发给任务的话\n\n```\n", "\n```\n");
    const head = source.split("\n\n").slice(0, 4).join("\n\n");
    const sent = sedimentMessage({ skillsDir: "/skills", assistantName: "Hob" });
    expect(sent.startsWith(`${head}\n\n`)).toBe(true);
    expect(sent).toContain("写好以后调用 report");
  });
});
