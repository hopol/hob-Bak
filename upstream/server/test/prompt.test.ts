import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, buildWorkerPrompt, GROUP_OWNER_LINE } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { saveSkillTool } from "../src/save-skill.ts";
import { nowText, checkTimezone, monthDayText, monthDayTimeText } from "../src/time.ts";
import { createFromDraft } from "../src/actions.ts";
import type { Draft } from "../../shared/types.ts";
import { makeHob, text } from "./helpers.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("群补充说明", () => {
  it("群主那段说清成员的活派给成员（票 191）", () => {
    const group = { id: "g-1", name: "团队", purpose: "协作", ownerId: "hob", members: ["hob", "ops"], createdAt: "2026-01-01" };
    const store = {
      home: "/tmp/hob",
      assistant: (id: string) => id === "hob" ? { id: "hob", name: "Hob", primary: true, duty: "主助手" } : { id, name: "运维", primary: false, duty: "机器" },
      assistants: () => [], groups: () => [], group: () => group, globalRules: () => [], rules: () => [], groupRules: () => [], routines: () => [], job: () => undefined, workDir: () => "/own",
    } as never;
    const settings = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const, searchEnabled: false, imageEnabled: false, desktopEnabled: false };
    const sentence = "成员的任务分派给成员：start_job 填它的 assistantId，任务就以它的身份、用它的技能执行。需要核对的，分派给没参与这项任务的成员，核对的人没写过，才看得出执行者自己看不到的地方。";
    expect(GROUP_OWNER_LINE).toContain(sentence);
    expect(buildSystemPrompt(store, "hob", { ...settings, group })).toContain(sentence);
    // 群里的其他成员不管派活，也不在单聊里出现
    expect(buildSystemPrompt(store, "ops", { ...settings, group })).not.toContain(sentence);
    expect(buildSystemPrompt(store, "hob", settings)).not.toContain(sentence);
  });

  it("群主那段不再带补充说明", () => {
    const group = { id: "g-1", name: "团队", purpose: "协作", ownerId: "hob", members: ["hob"], createdAt: "2026-01-01" };
    const store = {
      home: "/tmp/hob", assistant: () => ({ id: "hob", name: "Hob", primary: true, duty: "主助手" }),
      assistants: () => [], groups: () => [], group: () => group, globalRules: () => [], rules: () => [], groupRules: () => [], routines: () => [], job: () => undefined, workDir: () => "/own",
    } as never;
    const settings = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const, searchEnabled: false, imageEnabled: false, desktopEnabled: false };
    expect(buildSystemPrompt(store, "hob", { ...settings, group })).not.toContain("补充说明");
  });


  it("到点时原话代表用户本人，旧做法对不上时照原话办（票 198）", () => {
    const group = { id: "g-1", name: "社区菜园", purpose: "采购和记账", ownerId: "hob", members: ["hob"], createdAt: "2026-01-01" };
    const store = {
      home: "/tmp/hob",
      assistant: () => ({ id: "hob", name: "Hob", primary: true, duty: "主助手" }),
      assistants: () => [], groups: () => [], group: () => group, globalRules: () => [], rules: () => [], groupRules: () => [], routines: () => [], job: () => undefined, workDir: () => "/own",
    } as never;
    const settings = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const, searchEnabled: false, imageEnabled: false, desktopEnabled: false };
    const owner = buildSystemPrompt(store, "hob", { ...settings, group });
    expect(owner).toContain("确认卡上的选择、定时任务里用户自己写的要做的事，代表用户本人；转交说明和定时任务里助手写的要做的事，是写的那个助手对用户要求的理解，里面引用的用户原话代表用户本人。任务结果、其他助手的回复和定时检查到的内容是交给你的信息");

    expect(owner).toContain("规则、记忆和技能记下的，都是以前的话、做法和情况。用户现在说的和它们对不上时，用户现在的话才是他这次要的，按新的执行。");
    expect(owner).toContain("照创建它时用户交代的执行；用户没交代怎么办的");
    // 单聊也要有这一段：用户现在的话盖过旧的规则、记忆和技能
    const single = buildSystemPrompt(store, "hob", settings);
    expect(single).toContain("规则、记忆和技能记下的，都是以前的话、做法和情况。");
    expect(single).not.toContain("定时任务里用户写的要做的事");
  });
});

describe("现在时间", () => {
  it("按 config.timezone 算，不带服务器系统时区", () => {
    expect(nowText("Asia/Shanghai", new Date("2026-11-01T01:10:00.000Z"))).toBe("2026-11-01 09:10 周日");
    expect(nowText("America/New_York", new Date("2026-11-01T01:10:00.000Z"))).toBe("2026-10-31 21:10 周六");
  });

  it("时区写错直接报错", () => {
    expect(() => checkTimezone("Asia/ShangHaii")).toThrow(/时区不合法/);
    expect(checkTimezone("Asia/Shanghai")).toBe("Asia/Shanghai");
  });

  it("月日按配置时区算：系统还是 10 月 31 日，上海已经 11 月 1 日", () => {
    const at = new Date("2026-10-31T16:30:00.000Z");
    expect(monthDayText("Asia/Shanghai", at)).toBe("11月1日");
    expect(monthDayText("America/New_York", at)).toBe("10月31日");
  });

  it("报告里的结束时间写成「11月1日 09:43」，按配置时区", () => {
    const at = new Date("2026-11-01T01:43:00.000Z");
    expect(monthDayTimeText("Asia/Shanghai", at)).toBe("11月1日 09:43");
    expect(monthDayTimeText("America/New_York", at)).toBe("10月31日 21:43");
  });

  it("分出助手的说明用 config 时区的日期", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // 系统时区 2026-10-31 12:30，配置时区 Asia/Shanghai 已经是 11 月 1 日 00:30
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-31T16:30:00.000Z"));
      expect(new Date().getDate()).toBe(31);

      const hob = makeHob();
      try {
        const draft: Draft = {
          id: "d-1",
          assistantId: "hob",
          status: "pending",
          name: "写作",
          sprite: "page",
          duty: "周报和文章",
          dutyLong: "每周写周报。",
          routines: [],
          routinesText: "",
          askFirst: [],
          carry: { conversations: 2 },
          createdAt: new Date().toISOString(),
        };
        hob.runtime.store.saveDraft(draft);
        const result = await createFromDraft(hob.runtime, draft.id);
        expect(result.status).toBe(200);
        const id = (result.body as { assistant: { id: string } }).assistant.id;
        expect(hob.runtime.store.assistant(id)?.dutyLong).toBe("每周写周报。");
        const note = hob.runtime.router.items(id).items[0];
        expect(note.kind === "note" ? note.text : "").toBe("11月1日 由 Hob 创建");
      } finally {
        hob.close();
      }
    } finally {
      vi.useRealTimers();
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});

describe("提示词角色和内容", () => {
  it("覆盖主助手、其他助手和 Worker，最少信息时也能写全", () => {
    const primary = { id: "hob", name: "Hob", primary: true, duty: "主助手" };
    const other = { id: "ops", name: "运维", primary: false, duty: "服务器", dutyLong: "维护机器" };
    const store = {
      assistant: (id: string) => id === "hob" ? primary : other,
      assistants: () => [primary, other],
      groups: () => [],
      globalRules: () => [{ mode: "ask", text: "删除" }, { mode: "allow", text: "验证" }],
      rules: (id: string) => id === "hob" ? [{ mode: "ask", text: "重启" }, { mode: "allow", text: "查看" }] : [{ mode: "ask", text: "发布" }],
      routines: () => [{ id: "rt-daily", assistantId: "hob", name: "日报", schedules: ["0 9 * * *"], active: true, instruction: "写日报" }],
      job: (id: string) => id === "t-plain" ? { assistantId: "hob" } : { assistantId: "hob", cwd: "/work" },
      workDir: () => "/own",
    } as never;
    const settings = { timezone: "Asia/Shanghai", aboutYou: { name: "小林", language: "中文", notes: "简洁" }, memory: "lore" as const, searchEnabled: true, imageEnabled: true, desktopEnabled: true, skills: [{ name: "搜索", description: "不显示" }] };
    const main = buildSystemPrompt(store, "hob", { ...settings, assistantSkillsDir: "/skills" });
    expect(main).toContain("你是「Hob」，用户的主助手。用户在一对一的对话里和你合作，每条消息都是对你说的。");
    expect(main).toContain("- 日报（rt-daily） · 每天 09:00：写日报");
    const specific = buildSystemPrompt(store, "ops", { ...settings, assistantSkillsDir: "/skills" });
    expect(specific).toContain("你是「运维」，用户的助手，负责服务器。\n详细职责：维护机器");
    expect(specific).toContain("用户在一对一的对话里和你合作。别的助手会把归你管的事交给你：交来的消息是交接方写的交接说明，里面引用的用户原话等同用户本人的要求");
    const worker = buildWorkerPrompt(store, "t", { ...settings, abilities: { exec: false, write: true, image: false } });
    expect(worker).toContain("你是「Hob」派出的后台任务，在自己的会话里完成交给你的任务。\n工作目录：/work：你的命令默认在这里运行，改动直接落在这里。任务自己的目录是 /own：要另拉一份代码隔离着执行，或者放临时文件和中间产物，用它。读取不限目录。");
    expect(worker).toContain("不能做：执行命令（bash）、生成图片（generate_image）。");
    expect(worker).toContain("## 这些事执行前先用 ask_user 确认\n- 删除\n- 重启");
    // 没指定 cwd：任务就在自己的目录里做
    expect(buildWorkerPrompt(store, "t-plain", settings)).toContain(`工作目录：${homedir()}。产出放在这里；读取不限目录。`);
    const emptyStore = { ...store as object, assistant: () => ({ ...primary }), assistants: () => [primary], groups: () => [], globalRules: () => [], rules: () => [], routines: () => [] } as never;
    const empty = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const, assistantSkillsDir: "/skills" };
    // 提示词不设字数上限：只看最少信息时也能写出身份和边界
    expect(buildSystemPrompt(emptyStore, "hob", empty)).toContain("你是「Hob」");
    expect(buildWorkerPrompt(emptyStore, "t", empty)).toContain("你是「Hob」派出的后台任务");
  });

  it("start_job 的 cwd 参数说明", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const start = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "start_job")!;
      expect(start.parameters.properties.cwd.description).toBe("可选。填了，任务的命令默认就在这个目录里运行，改动直接落在这里，适合直接修改一个现成的项目。不填，任务在自己的目录里执行；只是读取某个项目，或者要另拉一份隔离着执行，不用填。相对路径以你的工作目录为准。");
    } finally { hob.close(); }
  });
});

describe("可选能力和事件边界", () => {
  it("按四个开关列出关闭的能力、网页和记忆", () => {
    const hob = makeHob();
    try {
      hob.runtime.store.saveGlobalRules([]);
      const base = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" } };
      for (let mask = 0; mask < 16; mask++) {
        const options = { ...base, memory: (mask & 1 ? "local" : "off") as "local" | "off", searchEnabled: !!(mask & 2), imageEnabled: !!(mask & 4), desktopEnabled: !!(mask & 8) };
        const prompt = buildSystemPrompt(hob.runtime.store, "hob", options);
        const disabled = [!(mask & 1) && "记忆", !(mask & 2) && "联网搜索", !(mask & 4) && "图像生成", !(mask & 8) && "云桌面"].filter(Boolean);
        if (disabled.length) expect(prompt).toContain(`未启用的能力：${disabled.join("、")}，在 设置 里开。`);
        else expect(prompt).not.toContain("未启用的能力：");
        expect(prompt.includes("产出、网页")).toBe(!!(mask & 2));
        expect(prompt.includes("## 记忆")).toBe(!!(mask & 1));
        expect(prompt.includes("用户需要图片，用 generate_image 生成，生成后会显示在对话里。")).toBe(!!(mask & 4));
        expect(prompt.includes("网页上的事用 playwright-cli 命令做，你和任务用的是同一个云桌面浏览器")).toBe(!!(mask & 8));
        expect(prompt).not.toContain("做成页面（show_page）更好读");
        expect(buildSystemPrompt(hob.runtime.store, "hob", { ...options, showPageEnabled: true })).toContain("做成页面（show_page）更好读");
        // 收起的助手（这里是默认带的那几位）照样能接转交，它们的回复也会送回来
        expect(prompt).toContain("其他助手的回复");
      }
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, id: "other", primary: false });
      expect(buildSystemPrompt(hob.runtime.store, "hob", { ...base, memory: "off" })).toContain("转交说明是转交方对用户要求的理解，里面引用的用户原话代表用户本人");
      expect(buildSystemPrompt(hob.runtime.store, "hob", { ...base, memory: "off", desktopEnabled: true })).toContain("网页上的事用 playwright-cli 命令做，你和任务用的是同一个云桌面浏览器");
    } finally { hob.close(); }
  });
});

describe("系统提示词", () => {
  const promptOf = (hob: ReturnType<typeof makeHob>) => {
    const { timezone, aboutYou } = hob.runtime.settings.settings.general;
    return buildSystemPrompt(hob.runtime.store, "hob", { timezone, aboutYou, memory: "local" });
  };

  it("助手的能力说明与开关一致", () => {
    const hob = makeHob();
    try {
      const base = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      for (const [exec, write, lead] of [
        [true, true, "你自己能执行命令、读取和修改文件"],
        [true, false, "你自己能执行命令、读取文件"],
        [false, true, "你自己能读取和修改文件"],
        [false, false, "你自己能读取文件"],
      ] as const) {
        const prompt = buildSystemPrompt(hob.runtime.store, "hob", { ...base, abilities: { exec, write, image: false } });
        expect(prompt).toContain(`${lead}，也能把事情交给后台任务。`);
      }
    } finally { hob.close(); }
  });

  it("任务提示词只在带上技能和云桌面工具时包含对应段落", () => {
    const hob = makeHob();
    try {
      const job = { id: "t-conditional", assistantId: "hob", title: "测试", instruction: "", status: "done" as const, createdAt: "", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] };
      const options = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      hob.runtime.store.saveJob(job);
      expect(buildWorkerPrompt(hob.runtime.store, job.id, options)).not.toContain("技能是做某一类事的做法");
      expect(buildWorkerPrompt(hob.runtime.store, job.id, options)).not.toContain("需要登录的网站");
      const prompt = buildWorkerPrompt(hob.runtime.store, job.id, { ...options, desktopEnabled: true, taskSkills: true });
      expect(prompt).toContain("技能是做某一类事的做法。要做的事对得上哪份，先读它的 SKILL.md 再执行，照着做能少走弯路。技能里有写错或过时的地方，按实际情况做对，并在 result 里写明是哪份技能、哪里不对，「Hob」会安排把技能改对。");
      expect(prompt).toContain("网页上的事用 playwright-cli 命令做，它操作的是云桌面的浏览器，用户看得到、能接手，登录也一直保持。云桌面是另一台机器，局域网和外网都通，但打不开这台机器上只监听 127.0.0.1 的服务。");
      expect(prompt).toContain("需要登录的网站，用 ask_user 告诉「Hob」要登录哪个网站");
      const credentialsPrompt = "需要登录的网站：打开登录页后调 login，登录的每一步都交给它。密码管理器里存了账号的，Hob 核对网址、请用户批准后直接填进页面；没存的，Hob 请用户在卡片上填一次、存好再填。扫码、第三方账号、短信或邮箱验证码这类只能用户本人完成的，也调 login：Hob 会出一张卡，用户点卡上的按钮打开云桌面登完，再点「已登录」，你就会收到消息接着做；只在聊天里请用户去登，用户登完还得回来再告诉你一次。你看不到密码；填好后你点登录按钮。注册新账号或修改密码时用 fill_new_password。用户说要自己登录的，也调 login，self 填 true：Hob 直接出那张卡，不替他填。用户要交给你密码时，请他在 login 的卡片上填，或者在云桌面里自己填，密码就不会经过聊天。";
      expect(buildSystemPrompt(hob.runtime.store, "hob", { ...options, desktopEnabled: true, credentialsEnabled: true })).toContain(credentialsPrompt);
      expect(buildWorkerPrompt(hob.runtime.store, job.id, { ...options, desktopEnabled: true, credentialsEnabled: true })).toContain(credentialsPrompt);
    } finally { hob.close(); }
  });

  it("旧助手职责从创建草稿回填且不覆盖编辑，提示词列出职责和确认规则", () => {
    const hob = makeHob();
    try {
      const store = hob.runtime.store;
      const primary = store.assistant("hob")!;
      store.saveAssistant({ ...primary, id: "ops", name: "服务器", duty: "机器", primary: false });
      store.saveDraft({ id: "d", assistantId: "hob", status: "created", createdAssistantId: "ops", name: "服务器", sprite: "server", duty: "机器", dutyLong: "维护服务器", routines: [], routinesText: "", askFirst: [], carry: { conversations: 0 }, createdAt: primary.createdAt });
      store.migrateAssistantDuties();
      expect(store.assistant("ops")?.dutyLong).toBe("维护服务器");
      store.saveRules("ops", [{ id: "r", text: "重启服务", mode: "ask", changedAt: primary.createdAt }, { id: "r2", text: "查看日志", mode: "allow", changedAt: primary.createdAt }]);
      expect(promptOf(hob)).toContain("服务器（ops）：机器");
      expect(promptOf(hob)).not.toContain("服务器（ops）：机器。维护服务器");
      expect(promptOf(hob)).not.toContain("执行前要确认：查看日志");
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      expect(buildSystemPrompt(store, "ops", { timezone, aboutYou, memory: "off" })).toContain("详细职责：维护服务器");
      store.saveAssistant({ ...store.assistant("ops")!, dutyLong: "" });
      store.migrateAssistantDuties();
      expect(store.assistant("ops")?.dutyLong).toBe("");
      expect(promptOf(hob)).not.toContain("详细职责：维护服务器");
      expect(buildSystemPrompt(store, "ops", { timezone, aboutYou, memory: "off" })).not.toContain("详细职责：");
    } finally { hob.close(); }
  });

  it("所有助手都要求在同一轮调用工具执行承诺的操作", () => {
    const hob = makeHob();
    try {
      const primary = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...primary, id: "other", primary: false, name: "其他助手" });
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      const expected = "同一件事的补充、纠正和追问，交给原来那个任务（reply_job），它记得之前的上下文和目录，结束了也能接着做。";
      for (const id of ["hob", "other"]) {
        expect(buildSystemPrompt(hob.runtime.store, id, { timezone, aboutYou, memory: "local" })).toContain(expected);
      }
    } finally {
      hob.close();
    }
  });

  it("列出启用的助手技能和配置时区的更新时间", () => {
    const hob = makeHob();
    try {
      const settings = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      const skill = { name: "dir-size", title: "目录大小", description: "统计目录", version: 2, updatedAt: "2026-11-05T15:57:00Z", path: "/tmp/skills/dir-size/SKILL.md", dir: "/tmp/skills/dir-size", scope: "assistant" as const, editable: true };
      const prompt = buildSystemPrompt(hob.runtime.store, "hob", { ...settings, skills: [skill] });
      expect(prompt).toContain("你能用的技能（括号里是它的文件，需要时可以读）：\n- dir-size「目录大小」· 你的 · 第 2 版 · 11-05 23:57 更新：统计目录（/tmp/skills/dir-size/SKILL.md）");
      expect(buildSystemPrompt(hob.runtime.store, "hob", { ...settings, skills: [] })).not.toContain("你能用的技能");
      // 停用的不列
      expect(buildSystemPrompt(hob.runtime.store, "hob", { ...settings, skills: [{ ...skill, enabled: false }] })).not.toContain("你能用的技能");
    } finally { hob.close(); }
  });

  it("Router 提示词里没有现在时间", () => {
    const hob = makeHob();
    try {
      const prompt = promptOf(hob);
      expect(prompt).not.toContain("现在时间：");
    } finally {
      hob.close();
    }
  });

  it("Worker 提示词里有现在时间", async () => {
    const hob = makeHob();
    try {
      const job = await hob.runtime.jobs.start("hob", { title: "查磁盘", instruction: "看看还剩多少" });
      await hob.runtime.jobs.waitIdle(10_000);
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      const prompt = buildWorkerPrompt(hob.runtime.store, job.id, { timezone, aboutYou, memory: "local" });
      expect(prompt).not.toContain("现在时间：");
    } finally {
      hob.close();
    }
  });

  it("讲清楚卡片工具先说话再调、always 选项、头像对照表", () => {
    const hob = makeHob();
    try {
      const prompt = promptOf(hob);
      expect(prompt).not.toContain("先在同一条消息里写一句话");
      expect(prompt).not.toContain("以后同类操作直接执行，无需确认");
      expect(prompt).not.toContain("用 set_rule 记入规则");
      expect(prompt).not.toContain("remember");
      expect(prompt).not.toContain("page 写作/文档");
      expect(prompt).not.toContain("hob 那个火苗是主助手专用的");
    } finally {
      hob.close();
    }
  });

  it("提示词里没有外部工作台和具体产品名；写代码的活靠 cwd 指定目录", () => {
    const hob = makeHob();
    try {
      const prompt = promptOf(hob);
      expect(prompt).not.toContain("外部工作台");
      expect(prompt).not.toContain("via");
      expect(prompt).toContain("任务在自己的会话里做，不占你的对话");
    } finally {
      hob.close();
    }
  });

  it("「关于你」：填了哪行出哪行，全空就整节不出", () => {
    const hob = makeHob();
    try {
      expect(promptOf(hob)).not.toContain("\n## 用户\n");

      hob.runtime.settings.patch(hob.runtime.settings.get().revision, {
        general: { aboutYou: { name: "小林", language: "中文", notes: "" } },
      });
      const prompt = promptOf(hob);
      expect(prompt).toContain("## 用户");
      expect(prompt).toContain("- 称呼：小林");
      expect(prompt).toContain("- 语言：中文");
      expect(prompt).not.toContain("- 其他：");

      // Worker 的提示词也要有
      hob.faux.setResponses([text("收到")]);
      const job = {
        id: "t-about",
        assistantId: "hob",
        title: "看下",
        instruction: "看下",
        status: "queued" as const,
        createdAt: new Date().toISOString(),
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      };
      hob.runtime.store.saveJob(job);
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      expect(buildWorkerPrompt(hob.runtime.store, job.id, { timezone, aboutYou, memory: "off" })).toContain("- 称呼：小林");
    } finally {
      hob.close();
    }
  });
});

describe("界面语言", () => {
  it("英文界面：助手的回复用英文，用户会看到的文字也用英文", () => {
    const hob = makeHob();
    try {
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      const prompt = buildSystemPrompt(hob.runtime.store, "hob", { timezone, aboutYou, locale: "en", memory: "off" });
      expect(prompt).toContain("像一个同事在聊天里跟人说事：用规范的英文，");
      expect(prompt).not.toContain("用规范的中文");
      expect(prompt).toContain("\n\n用户用的是英文界面，读的也是英文：回复，以及任务标题、规则、定时任务的名字、卡片上的问题和选项这些用户会看到的文字，都用英文写。\n\n## 你和任务");
    } finally {
      hob.close();
    }
  });

  it("英文界面：任务给用户看的文字也用英文，技能模板用英文名举例", () => {
    const hob = makeHob();
    try {
      hob.runtime.store.saveJob({ id: "t-en", assistantId: "hob", title: "整理", instruction: "", status: "done", createdAt: "", cwd: "/work", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      const prompt = buildWorkerPrompt(hob.runtime.store, "t-en", { timezone, aboutYou, locale: "en", memory: "off" });
      expect(prompt).toContain("交给你的消息是「Hob」写的交接说明和附带的文件，里面引用的用户原话代表用户本人。\n用户读英文：result 里的结论，以及要给用户看的文件、页面和技能的标题与正文，都用英文写。\n\n完成后调用 report");
      hob.runtime.settings.patch(hob.runtime.settings.get().revision, { general: { locale: "en" } });
      const template = saveSkillTool(hob.runtime, "hob", undefined, hob.home).parameters.properties.from.description;
      expect(template).toContain("title: <英文名，如「Weekly report」>");
      expect(template).not.toContain("中文名");
    } finally {
      hob.close();
    }
  });

  it("中文界面：三处都和原来一样", () => {
    const hob = makeHob();
    try {
      hob.runtime.store.saveJob({ id: "t-zh", assistantId: "hob", title: "整理", instruction: "", status: "done", createdAt: "", cwd: "/work", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      const settings = { timezone, aboutYou, memory: "off" as const };
      const prompt = buildSystemPrompt(hob.runtime.store, "hob", settings);
      expect(prompt).toContain("像一个同事在聊天里跟人说事：用规范的中文，");
      expect(prompt).not.toContain("用户用的是英文界面");
      expect(buildWorkerPrompt(hob.runtime.store, "t-zh", settings)).not.toContain("用户读英文");
      expect(saveSkillTool(hob.runtime, "hob", undefined, hob.home).parameters.properties.from.description).toContain("title: <中文名，如「每周周报」>");
    } finally {
      hob.close();
    }
  });

  it("用户自己填了语言：英文界面也不加", () => {
    const hob = makeHob();
    try {
      hob.runtime.store.saveJob({ id: "t-diy", assistantId: "hob", title: "整理", instruction: "", status: "done", createdAt: "", cwd: "/work", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      const aboutYou = { name: "", language: "中文", notes: "" };
      const settings = { timezone: "Asia/Shanghai", aboutYou, locale: "en" as const, memory: "off" as const };
      const prompt = buildSystemPrompt(hob.runtime.store, "hob", settings);
      expect(prompt).toContain("- 语言：中文");
      expect(prompt).toContain("像一个同事在聊天里跟人说事：用规范的中文，");
      expect(prompt).not.toContain("用户用的是英文界面");
      expect(buildWorkerPrompt(hob.runtime.store, "t-diy", settings)).not.toContain("用户读英文");
    } finally {
      hob.close();
    }
  });

  it("改了设置里的界面语言，同一个 Router 会话下一轮就按新的写", async () => {
    const hob = makeHob();
    try {
      const state = await hob.runtime.router.ensure("hob");
      hob.faux.setResponses([text("好")]);
      await hob.runtime.router.send("hob", { text: "你好" });
      await hob.runtime.router.waitIdle("hob");
      expect(state.session!.systemPrompt).toContain("用规范的中文，");

      hob.runtime.settings.patch(hob.runtime.settings.get().revision, { general: { locale: "en" } });
      hob.faux.setResponses([text("Hello")]);
      await hob.runtime.router.send("hob", { text: "Hello" });
      await hob.runtime.router.waitIdle("hob");
      expect(state.session!.systemPrompt).toContain("用规范的英文，");
      expect(state.session!.systemPrompt).toContain("用户用的是英文界面，读的也是英文：");
      expect(state.session!.systemPrompt).not.toContain("用规范的中文，");
    } finally {
      hob.close();
    }
  });
});

describe("技能按谁能用分档（票 197）", () => {
  const base = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };

  it("单聊：说清两种技能、沉淀存哪、换给谁用", () => {
    const hob = makeHob();
    try {
      const prompt = buildSystemPrompt(hob.runtime.store, "hob", base);
      expect(prompt).toContain("技能按谁能用分两种：你的，只有你能用；通用的，所有助手都能用。任务会带上它能用的全部技能，看着手上的事，挑对得上的那份照着做。");
      expect(prompt).toContain("做法一般跟着做成它的助手走，存成你的；对所有助手都用得上、和你管的事无关的，存成通用的。");
      expect(prompt).toContain("已经有的技能要换成通用的或者收回来，用 save_skill 的 general。");
      expect(prompt).toContain("任务做完时，结果里会提醒你可以让它回顾，并写明它用了哪些技能");
      expect(prompt).toContain("用 review_job 叫它");
      expect(prompt).toContain("学到的东西只进了其中一份，任务还可能挑中旧的那份。");
      expect(prompt).not.toContain("派活时给哪些");
      expect(prompt).not.toContain("start_job 的 skills");
      expect(prompt).not.toContain("任务带上的通用技能");
    } finally { hob.close(); }
  });

  it("群里：说清三种档位和沉淀存哪", () => {
    const hob = makeHob();
    try {
      const group = hob.runtime.groups.create({ name: "出行安排", purpose: "安排行程", ownerId: "hob", members: ["hob"] });
      const prompt = buildSystemPrompt(hob.runtime.store, "hob", { ...base, group });
      expect(prompt).toContain("技能按谁能用分三种：本群的，群里的成员在这个群里都能用；你的，跟着你，单聊和别的群里也能用；通用的，所有助手都能用。");
      expect(prompt).toContain("在这个群里做成的事，沉淀进本群的技能；对所有助手都用得上、和这个群管的事无关的，存成通用的。");
      expect(prompt).toContain("只对这个群的事成立的做法，另存成本群的。");
      expect(prompt).not.toContain("任务带上的通用技能");
    } finally { hob.close(); }
  });
});
