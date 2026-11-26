import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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
// 定稿里的【…】是给人看的注释（比如群里的写法），不进提示词：对照前按行去掉
const strip = (text: string) => text.split("\n").map((line) => line.replace(/\s*【[^】]*】\s*$/, "")).join("\n");
const line = (text: string, name: string) => text.split("\n").find((item) => item.startsWith(`**${name}**`))!.split("：").slice(1).join("：");

describe.skipIf(!doc)("第三版逐字对照", () => {
  it("助手和任务的固定段落与定稿完全一致", () => {
    const hob = makeHob();
    try {
      const store = hob.runtime.store;
      store.saveJob({ id: "t", assistantId: "hob", title: "测试", instruction: "", status: "done", createdAt: "", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      const options = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      const routerSource = section("## 一、助手的系统提示词\n\n```\n", "\n```\n");
      const core = strip(`你的回复显示在聊天气泡里${routerSource.split("你的回复显示在聊天气泡里")[1]!.split("## 技能")[0]}`)
        .trim()
        .replace(
          "放进气泡里读起来像在翻报告。",
          "放进气泡里读起来像在翻报告。内容本身有结构时，用 send_card 发成卡片。卡片就是为此做的：聊天气泡显示不好文档式的 Markdown，卡片有自己的标题、分栏、表格和折叠，在这里代替它。一份总结或汇报、几个选项的对比、一组数据、一份计划或清单，这些内容本来就分成几项、几节、几列，放进卡片比写成一段话或一份 Markdown 都好读。发了卡片，气泡里照常说结论和要用户做的事。几句话能说清的，直接回复。\n\n用户的消息可以用 react 点一个表情回应，像聊天软件里朋友之间那样：赞同、开心、好笑、感谢，一个表情让对话有来有回。表情是回复之外的互动，该说的话照常用文字说。",
        );
      const router = buildSystemPrompt(store, "hob", options);
      expect(router.slice(router.indexOf("你的回复显示在聊天气泡里"), router.indexOf("## 技能")).trim()).toBe(core);
      const workerSource = section("## 二、任务的系统提示词\n\n```\n", "\n```\n");
      // 定稿写的是没指定 cwd 的那句；指定了 cwd 的说法见 prompt.test.ts
      const workerCore = workerSource.split("技能是做某一类事的做法。要做的事对得上哪份")[0]!.trim().replaceAll("{助手}", "Hob").replace("{目录}", homedir());
      expect(buildWorkerPrompt(store, "t", options).startsWith(workerCore)).toBe(true);
      // 任务带着技能时那句，和定稿一字不差
      const taskSkillLine = workerSource.split("\n").find((item) => item.startsWith("技能是做某一类事的做法。要做的事对得上哪份"))!;
      expect(buildWorkerPrompt(store, "t", { ...options, taskSkills: true })).toContain(strip(taskSkillLine).replace("{助手}", "Hob"));
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
      for (const name of ["check_job", "delete_skill", "read", "start_job", "reply_job", "stop_job", "ask_user", "set_rule", "remove_rule", "create_routine", "update_routine", "delete_routine", "send_file", "set_avatar", "generate_image", "overview", "create_assistant", "message_assistant", "search_knowledge", "find_knowledge", "web_search", "web_fetch"]) {
        const expected = name === "create_assistant"
          ? "创建一个专属助手，创建后对话里出一张助手卡。"
          : name === "ask_user"
            ? "在对话里出一张提问卡，用户答完，答案会回到对话。问题可以是选择题（2 到 3 个选项），也可以是填空题（一行字、一段话、数字、日期、时间）。"
            : line(routerSource, name);
        expect(router.find((tool) => tool.name === name)?.description, name).toBe(expected);
      }
      expect(router.find((tool) => tool.name === "show_page")?.description.startsWith(`${line(routerSource, "show_page")}\n`)).toBe(true);
      const secondary = buildRouterTools(hob.runtime, "other");
      expect(secondary.find((tool) => tool.name === "hand_back")?.description).toBe(line(routerSource, "hand_back"));
      const worker = [registerReportTool(hob.runtime, "t"), registerAskTool(hob.runtime, "t"), registerImageTool(hob.runtime, "t")];
      for (const tool of worker) expect(tool.description, tool.name).toBe(line(workerSource, tool.name));
      const outcomeSource = workerSource.split("\n").find((item) => item.startsWith("- `outcome`："))!.split("：").slice(1).join("：");
      expect(worker[0]!.parameters.properties.outcome.description).toBe(outcomeSource);
      const desktop = new DesktopToolSession(hob.runtime, "hob", true, "任务").tools();
      for (const tool of desktop) expect(tool.description, tool.name).toBe(line(workerSource, tool.name));
      for (const tool of [...router, ...secondary, ...worker, ...desktop]) expect(tool.promptSnippet, tool.name).toBeUndefined();
    } finally { hob.close(); }
  });

  it("结果里的沉淀提醒与定稿逐字一致", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const base = "这个任务没用到技能。可以用 review_job 让它回顾一遍，把能复用的做法沉淀下来，有没有值得沉淀的由它判断。";
      const usedBase = "这个任务用了技能「报告整理」。可以用 review_job 让它回顾一遍，有没有值得沉淀的由它判断：技能里没写到的做法、写错的地方，它会补进对应的那份；是另一类事的做法，它会新建一份。";
      const job = { id: "t-copy", assistantId: "hob", title: "整理报告", instruction: "", status: "done" as const, createdAt: "", stats: { reads: 0, commands: 0, edits: 0 }, activity: [], summary: "好了" };
      hob.runtime.store.saveJob(job);
      expect(assistantJobResultEvent(hob.home, job).split("\n")[2]).toBe(base);
      saveAssistantSkill(hob.home, "hob", { name: "report-guide", title: "报告整理", description: "整理报告", content: "步骤" }, job.id);
      expect(assistantJobResultEvent(hob.home, job).split("\n")[2]).toBe(base);
      // 用到了技能：也提醒，并且写出标题
      const usedJob = { ...job, id: "t-copy-2", skillsUsed: ["report-guide"] };
      hob.runtime.store.saveJob(usedJob);
      expect(assistantJobResultEvent(hob.home, usedJob).split("\n")[2]).toBe(usedBase);
    } finally { hob.close(); }
  });

  it("沉淀时发给任务的话，前四段与定稿逐字一致", () => {
    // 票 154 把第五段起的写法换了，定稿还没替换，这里只对前四段
    const source = section("## 五、沉淀时发给任务的话\n\n```\n", "\n```\n");
    const head = source.split("\n\n").slice(0, 4).join("\n\n");
    const sent = sedimentMessage({ assistantName: "Hob" });
    expect(sent.startsWith(`${head}\n\n`)).toBe(true);
    expect(sent).toContain("存好以后调用 report");
  });
});
