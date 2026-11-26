import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../shared/i18n.ts";
import type { Assistant } from "../../shared/types.ts";
import { createFromDraft, updateAssistant } from "../src/actions.ts";
import { assistantWorkDir } from "../src/config.ts";
import { createApp } from "../src/http.ts";
import { checkSensitivePath, lookupFile } from "../src/files.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { saveSkillDirectory } from "../src/save-skill.ts";
import { writablePath } from "../src/write-protection.ts";
import {
  CWD_BOUND_LOCKED,
  WORKSPACE_AGENTS_MAX_CHARS,
  allowedWorkspaceDirs,
  loadWorkspaceAgentsFile,
  normalizeWorkspaceCwdInput,
  resolveWorkspaceCwd,
  validateWorkspaceCwd,
} from "../src/workspace.ts";
import { call, makeHob, text, waitFor, type TestHob } from "./helpers.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix = "hob-ws-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function addAssistant(hob: TestHob, id: string, overrides: Partial<Assistant> = {}): Assistant {
  const assistant: Assistant = {
    id,
    name: overrides.name ?? id,
    duty: overrides.duty ?? "协助处理任务",
    sprite: overrides.sprite ?? "page",
    primary: false,
    pinned: false,
    hidden: false,
    notify: true,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  hob.runtime.store.saveAssistant(assistant);
  return assistant;
}

async function loginCookie(hob: TestHob) {
  const app = createApp(hob.runtime, { home: hob.home });
  const res = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  return { app, cookie };
}

function makeSkillDraft(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: 测试用工作目录技能\nmetadata:\n  title: 目录技能\n---\n\n步骤一：执行验证。\n`,
  );
  return dir;
}

function systemPromptOf(ctx: { messages: Array<{ role: string; content?: unknown; sections?: Record<string, string | null> }> }): string {
  const parts: string[] = [];
  const sections = new Map<string, string>();
  for (const msg of ctx.messages) {
    if (msg.role !== "system") continue;
    if (typeof msg.content === "string" && msg.content) parts.push(msg.content);
    else if (Array.isArray(msg.content)) {
      const joined = msg.content
        .map((block: { type?: string; text?: string }) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
        .join("");
      if (joined) parts.push(joined);
    }
    if (msg.sections) {
      for (const [key, value] of Object.entries(msg.sections)) {
        if (value === null) sections.delete(key);
        else sections.set(key, value);
      }
    }
  }
  return [...parts, ...sections.values()].join("\n\n");
}

afterEach(() => {
  setLocale("zh-CN");
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("工作目录路径校验与规范化", () => {
  it("拒绝非法输入、相对路径、不存在目录、文件、悬空链接、HOB_HOME 及其祖先目录，支持 ~ 展开和目录软链", () => {
    const hob = makeHob({}, { memory: "off" });
    const project = makeTempDir("hob-ws-valid-");
    const linkParent = makeTempDir("hob-ws-link-");
    const file = join(project, "README.md");
    writeFileSync(file, "hello");
    const linkToProject = join(linkParent, "alias");
    symlinkSync(project, linkToProject);
    const brokenLink = join(linkParent, "broken");
    symlinkSync(join(project, "does-not-exist"), brokenLink);
    const linkToSystem = join(linkParent, "to-system");
    symlinkSync(join(hob.home, "system"), linkToSystem);

    try {
      expect(normalizeWorkspaceCwdInput(undefined)).toBeUndefined();
      expect(normalizeWorkspaceCwdInput(null)).toBeUndefined();
      expect(normalizeWorkspaceCwdInput("   ")).toBeUndefined();
      expect(() => normalizeWorkspaceCwdInput(123)).toThrow("工作目录必须是路径文字。");
      expect(normalizeWorkspaceCwdInput("~")).toBe(homedir());
      expect(normalizeWorkspaceCwdInput("~/demo-repo")).toBe(join(homedir(), "demo-repo"));

      // 合法目录与去尾斜杠、合法外部软链保留逻辑路径
      expect(validateWorkspaceCwd(`${project}/`, hob.home)).toBe(resolve(project));
      expect(validateWorkspaceCwd(linkToProject, hob.home)).toBe(resolve(linkToProject));

      // 持久配置拒绝相对路径
      expect(() => validateWorkspaceCwd("relative/path", hob.home)).toThrow("工作目录必须填写绝对路径");
      // 相对路径在 allowRelative: true 时按 base 解析
      expect(validateWorkspaceCwd("alias", hob.home, { allowRelative: true, base: linkParent })).toBe(resolve(linkToProject));

      // 不存在、文件、悬空软链
      expect(() => validateWorkspaceCwd(join(project, "missing"), hob.home)).toThrow("工作目录不存在");
      expect(() => validateWorkspaceCwd(file, hob.home)).toThrow("工作目录不是文件夹");
      expect(() => validateWorkspaceCwd(brokenLink, hob.home)).toThrow("工作目录不存在");

      // 禁止 HOB_HOME 自身、HOB_HOME/system 及指向它们的符号链接
      expect(() => validateWorkspaceCwd(hob.home, hob.home)).toThrow("不能把 Hob 的数据目录作为工作目录。");
      expect(() => validateWorkspaceCwd(join(hob.home, "system"), hob.home)).toThrow("不能把 Hob 的数据目录作为工作目录。");
      expect(() => validateWorkspaceCwd(linkToSystem, hob.home)).toThrow("不能把 Hob 的数据目录作为工作目录。");

      // 禁止 HOB_HOME 祖先目录（如 / 或 tmpdir）
      expect(() => validateWorkspaceCwd("/", hob.home)).toThrow("工作目录范围过大（包含 Hob 数据目录）");
      expect(() => validateWorkspaceCwd(tmpdir(), hob.home)).toThrow("工作目录范围过大（包含 Hob 数据目录）");

      // 支持 ~ 展开校验：使用家目录下临时目录验证 ~ 展开后的真实路径（若家目录包含 HOB_HOME 则只测试未包含情况）
      const homeRel = relative(homedir(), project);
      if (!homeRel.startsWith("..") && !homeRel.startsWith("/")) {
        expect(validateWorkspaceCwd(`~/${homeRel}`, hob.home)).toBe(resolve(project));
      }
    } finally {
      hob.close();
    }
  });
});

describe("继承链与不可变边界", () => {
  it("主助手忽略任何 cwd 且 PATCH 返回 400（含英文翻译）", async () => {
    const hob = makeHob({}, { memory: "off" });
    const dir = makeTempDir("hob-ws-primary-");
    try {
      // 防御性验证：即使磁盘上被手工写入 cwd，resolveWorkspaceCwd 仍忽略主助手 cwd
      const hobProfile = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...hobProfile, cwd: dir });
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, "hob")).toEqual({
        source: "default",
        sessionCwd: assistantWorkDir(hob.home, "hob"),
      });
      expect(allowedWorkspaceDirs(hob.runtime.store)).not.toContain(dir);

      const { app, cookie } = await loginCookie(hob);
      const resZh = await app.request("/api/assistants/hob", {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cwd: dir }),
      });
      expect(resZh.status).toBe(400);
      expect(await resZh.json()).toEqual({ error: "主助手不支持设置工作目录。" });

      setLocale("en");
      const resEn = await app.request("/api/assistants/hob", {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cwd: "" }),
      });
      expect(resEn.status).toBe(400);
      expect(await resEn.json()).toEqual({ error: "The primary assistant does not support a work directory." });
    } finally {
      hob.close();
    }
  });

  it("普通助手仅创建时可绑定 cwd，创建后不可修改或清空", async () => {
    const hob = makeHob({}, { memory: "off" });
    const dirA = makeTempDir("hob-ws-ast-a-");
    const dirB = makeTempDir("hob-ws-ast-b-");
    try {
      const tools = buildRouterTools(hob.runtime, "hob");
      const createTool = tools.find((item) => item.name === "create_assistant")!;
      const updateTool = tools.find((item) => item.name === "update_assistant")!;
      expect("cwd" in (updateTool.parameters.properties ?? {})).toBe(false);

      // 非法 cwd 直接拒绝且不落草稿卡
      const bad = await createTool.execute("bad", {
        name: "报表搭子",
        duty: "报表整理",
        dutyLong: "负责生成与校对月度报表",
        sprite: "page",
        cwd: "not/absolute",
      });
      expect(bad.isError).toBe(true);
      expect(hob.runtime.store.drafts()).toHaveLength(0);

      // 合法 cwd 创建成功并持久化
      const ok = await createTool.execute("ok", {
        name: "报表搭子",
        duty: "报表整理",
        dutyLong: "负责生成与校对月度报表",
        sprite: "page",
        cwd: `${dirA}/`,
      });
      expect(ok.isError).not.toBe(true);
      const created = hob.runtime.store.assistants().find((a) => a.name === "报表搭子")!;
      expect(created.cwd).toBe(dirA);
      expect(hob.runtime.store.drafts()[0]?.cwd).toBe(dirA);
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, created.id)).toEqual({
        bound: dirA,
        source: "assistant",
        sessionCwd: dirA,
      });

      // PATCH 改值、空串、null 全部 400 拦截
      const { app, cookie } = await loginCookie(hob);
      for (const value of [dirB, dirA, "", null]) {
        const res = await app.request(`/api/assistants/${created.id}`, {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ cwd: value }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "工作目录仅支持在创建时绑定，创建后不可修改。" });
      }
      // PATCH 同时携带 rule 与 cwd 也返回 400 且不落规则
      const patchRuleAndCwd = await app.request(`/api/assistants/${created.id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ rule: { text: "禁止偷偷改目录", mode: "ask" }, cwd: dirB }),
      });
      expect(patchRuleAndCwd.status).toBe(400);
      expect(await patchRuleAndCwd.json()).toEqual({ error: "工作目录仅支持在创建时绑定，创建后不可修改。" });
      expect(hob.runtime.store.rules(created.id)).toHaveLength(0);

      // 主助手 PATCH 同时携带 rule 与 cwd 返回主助手禁止错误且不落规则
      const patchPrimaryRuleAndCwd = await app.request("/api/assistants/hob", {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ rule: { text: "主助手规则", mode: "ask" }, cwd: dirB }),
      });
      expect(patchPrimaryRuleAndCwd.status).toBe(400);
      expect(await patchPrimaryRuleAndCwd.json()).toEqual({ error: "主助手不支持设置工作目录。" });
      expect(hob.runtime.store.rules("hob")).toHaveLength(0);

      expect(hob.runtime.store.assistant(created.id)?.cwd).toBe(dirA);

      // createFromDraft 也会复验草稿中的 cwd（若创建前目录被删则 400）
      const gone = makeTempDir("hob-ws-draft-gone-");
      hob.runtime.store.saveDraft({
        id: "d-gone",
        assistantId: "hob",
        status: "pending",
        name: "文档助手",
        sprite: "page",
        duty: "文档维护",
        dutyLong: "维护项目文档",
        cwd: gone,
        routines: [],
        routinesText: "",
        askFirst: [],
        createdAt: new Date().toISOString(),
      });
      rmSync(gone, { recursive: true, force: true });
      const failed = await createFromDraft(hob.runtime, "d-gone");
      expect(failed.status).toBe(400);
      expect((failed.body as { error: string }).error).toContain("工作目录不存在");
    } finally {
      hob.close();
    }
  });

  it("群与话题创建时绑定、锁定与不可变边界，及完整继承优先级", async () => {
    const hob = makeHob({}, { memory: "off" });
    const astDir = makeTempDir("hob-ws-ast-");
    const groupDirPath = makeTempDir("hob-ws-grp-");
    const topicDir = makeTempDir("hob-ws-topic-");
    const otherDir = makeTempDir("hob-ws-other-");
    try {
      const dev = addAssistant(hob, "dev", { name: "开发", cwd: astDir });
      const { app, cookie } = await loginCookie(hob);

      // 1. 建群绑定 cwd
      const createGroupRes = await app.request("/api/groups", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          name: "后端小组",
          purpose: "负责服务维护",
          ownerId: "hob",
          members: ["hob", dev.id],
          cwd: `${groupDirPath}/`,
        }),
      });
      expect(createGroupRes.status).toBe(201);
      const lockedGroup = await createGroupRes.json() as { id: string; cwd?: string };
      expect(lockedGroup.cwd).toBe(groupDirPath);

      // PATCH 群 cwd 返回 400（单独传或连同 rule 传均拦截且不落规则）
      const patchGroup = await app.request(`/api/groups/${lockedGroup.id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cwd: otherDir }),
      });
      expect(patchGroup.status).toBe(400);
      expect(await patchGroup.json()).toEqual({ error: "工作目录仅支持在创建时绑定，创建后不可修改。" });

      const patchGroupRuleAndCwd = await app.request(`/api/groups/${lockedGroup.id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ rule: { text: "群规则", mode: "ask" }, cwd: otherDir }),
      });
      expect(patchGroupRuleAndCwd.status).toBe(400);
      expect(await patchGroupRuleAndCwd.json()).toEqual({ error: "工作目录仅支持在创建时绑定，创建后不可修改。" });
      expect(hob.runtime.store.groupRules(lockedGroup.id)).toHaveLength(0);

      // 群已设 cwd：创建话题不传或空串自动沿用，且话题自身 group.json 不重复落盘 cwd
      const topicFollowRes = await app.request(`/api/groups/${lockedGroup.id}/topics`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "排查慢查询", cwd: "" }),
      });
      expect(topicFollowRes.status).toBe(201);
      const topicFollow = await topicFollowRes.json() as { id: string; cwd?: string };
      expect(topicFollow.cwd).toBeUndefined();
      expect(hob.runtime.store.group(topicFollow.id)?.cwd).toBeUndefined();
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, dev.id, topicFollow.id)).toEqual({
        bound: groupDirPath,
        source: "group",
        sessionCwd: groupDirPath,
      });

      // 群已设 cwd：创建话题传非空 cwd 返回 400 拒绝
      const topicConflict = await app.request(`/api/groups/${lockedGroup.id}/topics`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "单独目录", cwd: topicDir }),
      });
      expect(topicConflict.status).toBe(400);
      expect(await topicConflict.json()).toEqual({
        error: `所属群已绑定工作目录（${groupDirPath}），话题自动沿用群目录，不支持单独指定。`,
      });

      // 异常数据防御：即使话题文件被手工写入 cwd，父群已设 cwd 时解析链依然锁定父群 cwd
      hob.runtime.store.saveGroup({ ...hob.runtime.store.group(topicFollow.id)!, cwd: topicDir });
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, dev.id, topicFollow.id)).toEqual({
        bound: groupDirPath,
        source: "group",
        sessionCwd: groupDirPath,
      });

      // 2. 建群不设 cwd
      const freeGroup = hob.runtime.groups.create({
        name: "协作群",
        purpose: "跨项目协作",
        ownerId: "hob",
        members: ["hob", dev.id],
      });
      expect(freeGroup.cwd).toBeUndefined();

      // 话题不设 cwd 时：群里不看助手自己的 cwd，dev 和 hob 都是没绑定；dev 回到单聊才用自己的
      const freeTopic = hob.runtime.groups.createTopic(freeGroup.id, "日常同步", "user");
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, dev.id, freeTopic.id)).toEqual({
        source: "default",
        sessionCwd: assistantWorkDir(hob.home, dev.id),
      });
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, dev.id, freeGroup.id)).toEqual({
        source: "default",
        sessionCwd: assistantWorkDir(hob.home, dev.id),
      });
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, dev.id)).toEqual({
        bound: astDir,
        source: "assistant",
        sessionCwd: astDir,
      });
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, "hob", freeTopic.id)).toEqual({
        source: "default",
        sessionCwd: assistantWorkDir(hob.home, "hob"),
      });

      // 群未设 cwd 时创建话题绑定 cwd：生效且不污染父群；优先级 topic.cwd > assistant.cwd
      const boundTopicRes = await app.request(`/api/groups/${freeGroup.id}/topics`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ title: "升级报表服务", cwd: topicDir }),
      });
      expect(boundTopicRes.status).toBe(201);
      const boundTopic = await boundTopicRes.json() as { id: string; cwd?: string };
      expect(boundTopic.cwd).toBe(topicDir);
      expect(hob.runtime.store.group(freeGroup.id)?.cwd).toBeUndefined();
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, dev.id, boundTopic.id)).toEqual({
        bound: topicDir,
        source: "topic",
        sessionCwd: topicDir,
      });
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, "hob", boundTopic.id)).toEqual({
        bound: topicDir,
        source: "topic",
        sessionCwd: topicDir,
      });

      // PATCH 话题仍可改名，但传 cwd 返回 400
      const renameOk = await app.request(`/api/groups/${boundTopic.id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "升级报表服务 v2" }),
      });
      expect(renameOk.status).toBe(200);
      expect(hob.runtime.store.group(boundTopic.id)?.name).toBe("升级报表服务 v2");
      expect(hob.runtime.store.group(boundTopic.id)?.cwd).toBe(topicDir);

      const patchTopicCwd = await app.request(`/api/groups/${boundTopic.id}`, {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ cwd: otherDir }),
      });
      expect(patchTopicCwd.status).toBe(400);
      expect(await patchTopicCwd.json()).toEqual({ error: "工作目录仅支持在创建时绑定，创建后不可修改。" });
    } finally {
      hob.close();
    }
  });

  it("start_job 继承与锁定规则：已绑定成员不可被 explicitCwd 覆写，未绑定才允许显式 cwd 且未传严格落 jobs/<id>/work", async () => {
    const hob = makeHob({}, { memory: "off" });
    const astDir = makeTempDir("hob-ws-job-ast-");
    const groupDirPath = makeTempDir("hob-ws-job-grp-");
    const explicitDir = makeTempDir("hob-ws-job-exp-");
    const subDir = join(groupDirPath, "packages");
    mkdirSync(subDir, { recursive: true });
    const linkToAst = join(makeTempDir("hob-ws-job-link-"), "same-ast");
    symlinkSync(astDir, linkToAst);
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
      const dev = addAssistant(hob, "dev", { name: "开发", cwd: astDir });
      const plain = addAssistant(hob, "writer", { name: "写手" });
      const lockedGroup = hob.runtime.groups.create({
        name: "核心项目群",
        purpose: "代码维护",
        ownerId: "hob",
        members: ["hob", dev.id, plain.id],
        cwd: groupDirPath,
      });
      const freeGroup = hob.runtime.groups.create({
        name: "综合协作群",
        purpose: "综合事务",
        ownerId: "hob",
        members: ["hob", dev.id, plain.id],
      });

      hob.faux.setResponses([
        call("report", { outcome: "done", result: "1" }),
        call("report", { outcome: "done", result: "2" }),
        call("report", { outcome: "done", result: "3" }),
        call("report", { outcome: "done", result: "4" }),
        call("report", { outcome: "done", result: "5" }),
        call("report", { outcome: "done", result: "6" }),
        call("report", { outcome: "done", result: "7" }),
        call("report", { outcome: "done", result: "8" }),
      ]);

      // 1. 未绑定主助手：严格落在 jobs/<id>/work，绝不落到 assistants/hob/work
      const jUnbound = await hob.runtime.jobs.start("hob", { title: "未绑定任务", instruction: "检查状态" });
      expect(jUnbound.cwd).toBe(join(hob.home, "assistants", "hob", "jobs", jUnbound.id, "work"));
      expect(jUnbound.cwd).not.toBe(assistantWorkDir(hob.home, "hob"));

      // 2. 绑定了 cwd 的普通助手单聊未传 cwd：自动继承 assistant.cwd
      const jAssistant = await hob.runtime.jobs.start(dev.id, { title: "助手继承", instruction: "跑单测" });
      expect(jAssistant.cwd).toBe(astDir);

      // 3. 绑定了 cwd 的群内指派给其他成员（无论是绑了自己 cwd 的 dev 还是未绑定的 writer）：统一继承群 cwd
      const startInLocked = buildRouterTools(hob.runtime, "hob", lockedGroup.id, groupDirPath).find((t) => t.name === "start_job")!;
      await startInLocked.execute("c1", { title: "指派开发", note: "检查构建", assistantId: dev.id });
      await startInLocked.execute("c2", { title: "指派写手", note: "整理变更日志", assistantId: plain.id });
      const jLockedDev = hob.runtime.store.jobs().find((j) => j.title === "指派开发")!;
      const jLockedPlain = hob.runtime.store.jobs().find((j) => j.title === "指派写手")!;
      expect(jLockedDev.cwd).toBe(groupDirPath);
      expect(jLockedPlain.cwd).toBe(groupDirPath);

      // 4. 群未设 cwd 时指派给绑了目录的 dev：群里不看 dev 自己的目录，落在任务自己的目录
      const startInFree = buildRouterTools(hob.runtime, "hob", freeGroup.id, assistantWorkDir(hob.home, "hob")).find((t) => t.name === "start_job")!;
      await startInFree.execute("c3", { title: "自由群指派开发", note: "查代码", assistantId: dev.id });
      const jFreeDev = hob.runtime.store.jobs().find((j) => j.title === "自由群指派开发")!;
      expect(jFreeDev.cwd).toBe(join(hob.home, "assistants", dev.id, "jobs", jFreeDev.id, "work"));

      // 5. 未绑定会话给未绑定成员允许显式传入 cwd；已绑定成员传不同 explicitCwd 明确拒绝，传相同目录（含等价软链）则沿用 bound
      await startInFree.execute("c4", { title: "未绑定显式目录", note: "只看子目录", cwd: subDir });
      const jSub = hob.runtime.store.jobs().find((j) => j.title === "未绑定显式目录")!;
      expect(jSub.cwd).toBe(subDir);

      const jPlainExplicit = await hob.runtime.jobs.start(plain.id, { title: "未绑定成员显式绝对目录", instruction: "在另一目录工作", cwd: explicitDir });
      expect(jPlainExplicit.cwd).toBe(explicitDir);

      await expect(
        hob.runtime.jobs.start(dev.id, { title: "企图覆写绑定助手", instruction: "换目录", cwd: explicitDir }),
      ).rejects.toThrow(CWD_BOUND_LOCKED);
      await expect(
        hob.runtime.jobs.start(plain.id, { title: "企图覆写绑定群", instruction: "换目录", groupId: lockedGroup.id, cwd: explicitDir }),
      ).rejects.toThrow(CWD_BOUND_LOCKED);

      const jSameAsBound = await hob.runtime.jobs.start(dev.id, { title: "传与绑定等价软链", instruction: "同目录", cwd: linkToAst });
      expect(jSameAsBound.cwd).toBe(astDir);

      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("定时任务检查脚本 cwd 仍隔离在 routines/<rid>/，触发后的群会话与派生任务继承绑定目录", async () => {
    const hob = makeHob({}, { memory: "off" });
    const projectDir = makeTempDir("hob-ws-routine-");
    try {
      const dev = addAssistant(hob, "dev", { name: "开发" });
      const group = hob.runtime.groups.create({
        name: "巡检群",
        purpose: "定期检查项目状态",
        ownerId: dev.id,
        members: [dev.id],
        cwd: projectDir,
      });
      const routine = hob.runtime.routines.create({
        assistantId: dev.id,
        groupId: group.id,
        name: "检查仓库状态",
        instruction: "发现变化时汇报",
        schedules: ["0 9 * * *"],
        check: { script: "pwd && touch marker.txt", then: "job" },
      });

      const trial = await hob.runtime.routines.trial(routine);
      expect(trial.outcome).toBe("hit");
      const routineDir = hob.runtime.routines.dir(routine);
      expect(realpathSync(trial.output!)).toBe(realpathSync(routineDir));
      expect(existsSync(join(routineDir, "marker.txt"))).toBe(true);
      expect(existsSync(join(projectDir, "marker.txt"))).toBe(false);

      // 到点触发后落到目标群会话，且会话与派生任务都继承 projectDir
      const openedCwds: string[] = [];
      const rawOpen = hob.runtime.pi.open.bind(hob.runtime.pi);
      vi.spyOn(hob.runtime.pi, "open").mockImplementation(async (opts) => {
        openedCwds.push(opts.cwd);
        return rawOpen(opts);
      });
      hob.faux.setResponses([
        call("start_job", { title: "处理巡检结果", note: "核对巡检输出" }),
        call("report", { outcome: "done", result: "已核对" }),
        text("巡检任务已安排"),
        text("巡检结论已确认"),
      ]);

      await hob.runtime.routines.fire(routine.id);
      await waitFor(() => hob.runtime.store.jobs().some((j) => j.title === "处理巡检结果"), 10_000);
      await hob.runtime.jobs.waitIdle(10_000);
      await waitFor(() => hob.runtime.groups.summary(group.id).busy.length === 0, 10_000);

      const spawned = hob.runtime.store.jobs().find((j) => j.title === "处理巡检结果")!;
      expect(spawned.cwd).toBe(projectDir);
      expect(openedCwds).toContain(projectDir);
    } finally {
      hob.close();
    }
  });
});

describe("安全边界、writeGuard 加固、save_skill 双根目录与运行时目录失效", () => {
  it("Router read 与 /api/files 可读绑定目录内普通文件，拒绝敏感文件与软链逃逸", async () => {
    const hob = makeHob({}, { memory: "off" });
    const project = makeTempDir("hob-ws-read-");
    const outside = makeTempDir("hob-ws-outside-");
    try {
      const dev = addAssistant(hob, "dev", { name: "开发", cwd: project });
      writeFileSync(join(project, "app.ts"), "export const answer = 42;\n");
      writeFileSync(join(project, ".env"), "SECRET=123\n");
      writeFileSync(join(project, "private.pem"), "KEY\n");
      mkdirSync(join(project, ".ssh"), { recursive: true });
      writeFileSync(join(project, ".ssh", "id_rsa"), "PRIVATE\n");
      mkdirSync(join(project, ".git"), { recursive: true });
      writeFileSync(join(project, ".git", "config"), "[core]\n");
      writeFileSync(join(outside, "leak.txt"), "outside-secret");
      symlinkSync(join(outside, "leak.txt"), join(project, "escape.txt"));
      writeFileSync(join(hob.home, "system", "secrets.json"), "{}");

      const tools = buildRouterTools(hob.runtime, dev.id, undefined, project);
      const readTool = tools.find((item) => item.name === "read")!;

      const okRead = await readTool.execute("r1", { path: "app.ts" });
      expect(okRead.isError).not.toBe(true);
      expect((okRead.content[0] as { text: string }).text).toContain("export const answer = 42;");

      for (const badPath of [".env", ".ssh/id_rsa", ".git/config", "private.pem", "escape.txt", join(hob.home, "system", "secrets.json")]) {
        const res = await readTool.execute("bad", { path: badPath });
        expect(res.isError, badPath).toBe(true);
      }

      // /api/files 允许读取绑定目录普通文件，仍拦截敏感文件
      const { app, cookie } = await loginCookie(hob);
      const okHttp = await app.request(`/api/files?path=${encodeURIComponent(join(project, "app.ts"))}`, { headers: { cookie } });
      expect(okHttp.status).toBe(200);
      expect(await okHttp.text()).toContain("export const answer = 42;");

      const badHttp = await app.request(`/api/files?path=${encodeURIComponent(join(project, ".env"))}`, { headers: { cookie } });
      expect(badHttp.status).toBe(403);
    } finally {
      hob.close();
    }
  });

  it("writeGuard 加固：拒绝经外部宽目录或软链写入 HOB_HOME，Worker/Router 仍可写 ownWorkDir，save_skill 支持 ownWorkDir", async () => {
    const hob = makeHob({}, { memory: "off" });
    const project = makeTempDir("hob-ws-write-");
    try {
      const dev = addAssistant(hob, "dev", { name: "开发", cwd: project });
      const ownAssistantDir = assistantWorkDir(hob.home, dev.id);
      mkdirSync(ownAssistantDir, { recursive: true });
      const secretsPath = join(hob.home, "system", "secrets.json");
      writeFileSync(secretsPath, "{}");
      const evilLink = join(project, "link-secrets.json");
      symlinkSync(secretsPath, evilLink);

      // 1. 项目目录内正常可写
      expect(writablePath(hob.home, [project, ownAssistantDir], join(project, "ok.txt"))).toBe(join(project, "ok.txt"));
      // 2. 助手 ownWorkDir 正常可写
      expect(writablePath(hob.home, [project, ownAssistantDir], join(ownAssistantDir, "scratch.txt"))).toBe(join(ownAssistantDir, "scratch.txt"));
      // 3. 项目目录内指向 HOB_HOME/system/secrets.json 的符号链接被拒绝
      expect(() => writablePath(hob.home, [project, ownAssistantDir], evilLink)).toThrow("这是 Hob 自己的数据");
      // 4. 即使 roots 误含 HOB_HOME 的祖先目录（如 / 或 tmpdir），也绝不放行 HOB_HOME 内写入
      expect(() => writablePath(hob.home, ["/", tmpdir()], secretsPath)).toThrow("这是 Hob 自己的数据");
      expect(() => writablePath(hob.home, ["/", tmpdir()], join(hob.home, "assistants", "dev", "profile.json"))).toThrow("这是 Hob 自己的数据");

      // 5. Worker 绑定外部 cwd 时仍可在 jobs/<id>/work 写临时文件，且能写 project 内文件，但不能写 HOB_HOME/system
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
      let workerOwnFile = "";
      hob.faux.setResponses([
        (ctx) => {
          const match = /任务自己的目录是 ([^：\s]+)/.exec(systemPromptOf(ctx));
          workerOwnFile = join(match![1], "tmp-note.txt");
          return call("write", { path: workerOwnFile, content: "worker scratch" });
        },
        call("write", { path: join(project, "generated.txt"), content: "project output" }),
        call("write", { path: evilLink, content: "hacked" }),
        call("report", { outcome: "done", result: "ok" }),
      ]);
      const job = await hob.runtime.jobs.start(dev.id, { title: "双目录写入测试", instruction: "测试写入边界" });
      await hob.runtime.jobs.waitIdle(10_000);
      expect(job.cwd).toBe(project);
      expect(readFileSync(workerOwnFile, "utf8")).toBe("worker scratch");
      expect(readFileSync(join(project, "generated.txt"), "utf8")).toBe("project output");
      expect(readFileSync(secretsPath, "utf8")).toBe("{}");

      // 6. save_skill(from) 支持 ownWorkDir（不污染外部项目目录）
      const draftedInOwn = makeSkillDraft(ownAssistantDir, "from-own-dir");
      const saved = saveSkillDirectory(
        hob.runtime,
        dev.id,
        undefined,
        project,
        { name: "from-own-dir", from: draftedInOwn },
        { kind: "assistant", assistantId: dev.id },
        [project, ownAssistantDir],
      );
      expect(saved).toMatchObject({ name: "from-own-dir", version: 1 });
      // 外部随机目录仍被拒绝
      const stray = makeTempDir("hob-ws-stray-");
      const draftedStray = makeSkillDraft(stray, "from-stray");
      expect(() =>
        saveSkillDirectory(
          hob.runtime,
          dev.id,
          undefined,
          project,
          { name: "from-stray", from: draftedStray },
          { kind: "assistant", assistantId: dev.id },
          [project, ownAssistantDir],
        ),
      ).toThrow("from 要指向工作目录里的技能文件夹。");
    } finally {
      hob.close();
    }
  });

  it("运行时已绑定目录被删除：Router 降级默认目录并在提示词告警不崩溃；start_job 明确报错", async () => {
    const hob = makeHob({}, { memory: "off" });
    const project = makeTempDir("hob-ws-missing-");
    try {
      const dev = addAssistant(hob, "dev", { name: "开发", cwd: project });
      // 模拟运行时目录被外部删除
      rmSync(project, { recursive: true, force: true });

      const capturedSystems: string[] = [];
      hob.faux.setResponses([
        (ctx) => {
          capturedSystems.push(systemPromptOf(ctx));
          return text("已收到，我注意到目录不见了。");
        },
      ]);
      await hob.runtime.router.send(dev.id, { text: "检查一下当前项目" });
      await hob.runtime.router.waitIdle(dev.id, 10_000);

      expect(capturedSystems).toHaveLength(1);
      expect(capturedSystems[0]).toContain(`注意：配置的工作目录「${project}」当前不存在或不可访问，本轮已临时回落到默认目录`);
      expect(capturedSystems[0]).toContain(assistantWorkDir(hob.home, dev.id));

      // 后台任务启动明确报错，避免静默落进隔离目录
      await expect(hob.runtime.jobs.start(dev.id, { title: "执行构建", instruction: "跑构建" })).rejects.toThrow("工作目录不存在");
    } finally {
      hob.close();
    }
  });
});

describe("AGENTS.md 自动加载与 Prompt Cache 稳定性", () => {
  it("仅加载绑定目录根 AGENTS.md，支持 CLAUDE.md 回退、优先级、截断、拒绝软链逃逸，不向上扫描父目录", () => {
    const parent = makeTempDir("hob-ws-agents-parent-");
    const child = join(parent, "app");
    const outside = makeTempDir("hob-ws-agents-out-");
    mkdirSync(child, { recursive: true });
    writeFileSync(join(parent, "AGENTS.md"), "PARENT_SHOULD_NOT_LOAD");

    // 1. 子目录无 AGENTS.md / CLAUDE.md 时不向上加载父目录
    expect(loadWorkspaceAgentsFile(child)).toEqual([]);
    expect(loadWorkspaceAgentsFile(undefined)).toEqual([]);

    // 2. 只有 CLAUDE.md 时回退加载 CLAUDE.md
    writeFileSync(join(child, "CLAUDE.md"), "CLAUDE_ONLY_RULE");
    const claudeOnly = loadWorkspaceAgentsFile(child);
    expect(claudeOnly).toHaveLength(1);
    expect(claudeOnly[0].path).toBe(join(child, "CLAUDE.md"));
    expect(claudeOnly[0].content).toBe("CLAUDE_ONLY_RULE");

    // 3. AGENTS.md 与 CLAUDE.md 共存时仅加载 AGENTS.md
    writeFileSync(join(child, "AGENTS.md"), "AGENTS_PRIMARY_RULE");
    const both = loadWorkspaceAgentsFile(child);
    expect(both).toHaveLength(1);
    expect(both[0].path).toBe(join(child, "AGENTS.md"));
    expect(both[0].content).toBe("AGENTS_PRIMARY_RULE");
    expect(both[0].content).not.toContain("CLAUDE_ONLY_RULE");

    // 4. 超过 32,000 字符按换行截断并附截断说明
    const longBody = Array.from({ length: 400 }, (_, i) => `line-${String(i).padStart(3, "0")}-${"x".repeat(90)}`).join("\n");
    expect(longBody.length).toBeGreaterThan(WORKSPACE_AGENTS_MAX_CHARS);
    writeFileSync(join(child, "AGENTS.md"), longBody);
    const truncated = loadWorkspaceAgentsFile(child);
    expect(truncated).toHaveLength(1);
    expect(truncated[0].content).toContain("（以上为前 32,000 字，文件其余部分已省略；如需查看完整内容，请用 read 工具读取");
    const [head] = truncated[0].content.split("\n（以上为前 32,000 字");
    expect(head.length).toBeLessThanOrEqual(WORKSPACE_AGENTS_MAX_CHARS);
    // 确认是在换行处完整截断，没有把某一行从中间腰斩
    expect(head.endsWith("x".repeat(90))).toBe(true);

    // 5. 指向目录外的 AGENTS.md 软链被忽略
    const symlinkChild = join(parent, "symlink-app");
    mkdirSync(symlinkChild, { recursive: true });
    writeFileSync(join(outside, "secret-agents.md"), "OUTSIDE_AGENTS");
    symlinkSync(join(outside, "secret-agents.md"), join(symlinkChild, "AGENTS.md"));
    expect(loadWorkspaceAgentsFile(symlinkChild)).toEqual([]);
  });

  it("会话打开时快照 AGENTS.md：两轮之间修改磁盘 AGENTS.md 保持 system 逐字不变（Cache 稳定），重开后才重读", async () => {
    const hob = makeHob({}, { memory: "off" });
    const project = makeTempDir("hob-ws-cache-");
    try {
      const agentsPath = join(project, "AGENTS.md");
      writeFileSync(agentsPath, "PROJECT_RULE_V1: always run vitest with --maxWorkers=1\n");
      const dev = addAssistant(hob, "dev", { name: "开发", cwd: project });

      // 未绑定默认目录里的 AGENTS.md 不应被加载
      const hobWork = assistantWorkDir(hob.home, "hob");
      mkdirSync(hobWork, { recursive: true });
      writeFileSync(join(hobWork, "AGENTS.md"), "DEFAULT_DIR_SHOULD_NOT_LOAD");

      const seen: string[] = [];
      const seenSystemCount: number[] = [];
      hob.faux.setResponses([
        (ctx) => { seen.push(systemPromptOf(ctx)); seenSystemCount.push(ctx.messages.filter((m) => m.role === "system").length); return text("第一轮收到"); },
        (ctx) => { seen.push(systemPromptOf(ctx)); seenSystemCount.push(ctx.messages.filter((m) => m.role === "system").length); return text("第二轮收到"); },
        (ctx) => { seen.push(systemPromptOf(ctx)); seenSystemCount.push(ctx.messages.filter((m) => m.role === "system").length); return text("第三轮收到"); },
        (ctx) => { seen.push(systemPromptOf(ctx)); seenSystemCount.push(ctx.messages.filter((m) => m.role === "system").length); return text("主助手收到"); },
      ]);

      // 第 1 轮
      await hob.runtime.router.send(dev.id, { text: "先看下规范" });
      await hob.runtime.router.waitIdle(dev.id, 10_000);

      // 两轮之间修改磁盘上的 AGENTS.md
      writeFileSync(agentsPath, "PROJECT_RULE_V2: updated on disk while session is open\n");

      // 第 2 轮（同一会话，每轮会 refreshTools -> refreshSystemPrompt）
      await hob.runtime.router.send(dev.id, { text: "继续讨论实现" });
      await hob.runtime.router.waitIdle(dev.id, 10_000);

      expect(seen).toHaveLength(2);
      expect(seen[0]).toContain("<project_context>");
      expect(seen[0]).toContain("PROJECT_RULE_V1");
      expect(seen[0]).toContain(`当前工作目录：${project}（来源：你的设置）。命令、文件读写和派出的任务都在这个目录进行。`);
      expect(seen[1]).toBe(seen[0]); // 逐字一致，Prompt Cache 不漂移
      expect(seenSystemCount[1]).toBe(seenSystemCount[0]); // 未追加任何中间 system delta

      // 对照：释放重开会话后读到磁盘上的 V2
      hob.runtime.router.releaseSessions();
      await hob.runtime.router.send(dev.id, { text: "重开后再看" });
      await hob.runtime.router.waitIdle(dev.id, 10_000);
      expect(seen[2]).toContain("PROJECT_RULE_V2");
      expect(seen[2]).not.toContain("PROJECT_RULE_V1");

      // 未绑定的主助手零打扰：不加载默认目录 AGENTS.md，也不附加工作目录提示行
      await hob.runtime.router.send("hob", { text: "你好" });
      await hob.runtime.router.waitIdle("hob", 10_000);
      expect(seen[3]).not.toContain("DEFAULT_DIR_SHOULD_NOT_LOAD");
      expect(seen[3]).not.toContain("当前工作目录：");
    } finally {
      hob.close();
    }
  });

  it("后台任务（继承目录与显式 worktree 目录）均在 <project_context> 中加载对应目录的 AGENTS.md", async () => {
    const hob = makeHob({}, { memory: "off" });
    const mainRepo = makeTempDir("hob-ws-worker-main-");
    const worktreeRepo = makeTempDir("hob-ws-worker-wt-");
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
      writeFileSync(join(mainRepo, "AGENTS.md"), "MAIN_REPO_GUIDELINE");
      writeFileSync(join(worktreeRepo, "AGENTS.md"), "WORKTREE_BRANCH_GUIDELINE");
      const dev = addAssistant(hob, "dev", { name: "开发", cwd: mainRepo });

      const workerSystems: string[] = [];
      hob.faux.setResponses([
        (ctx) => { workerSystems.push(systemPromptOf(ctx)); return call("report", { outcome: "done", result: "main ok" }); },
        text("好"),
        (ctx) => { workerSystems.push(systemPromptOf(ctx)); return call("report", { outcome: "done", result: "wt ok" }); },
        text("好"),
      ]);

      await hob.runtime.jobs.start(dev.id, { title: "主目录任务", instruction: "在继承目录执行" });
      await hob.runtime.jobs.waitIdle(10_000);

      await hob.runtime.jobs.start("hob", { title: "Worktree 任务", instruction: "在独立 worktree 执行", cwd: worktreeRepo });
      await hob.runtime.jobs.waitIdle(10_000);

      expect(workerSystems).toHaveLength(2);
      expect(workerSystems[0]).toContain("<project_context>");
      expect(workerSystems[0]).toContain("MAIN_REPO_GUIDELINE");
      expect(workerSystems[0]).not.toContain("WORKTREE_BRANCH_GUIDELINE");

      expect(workerSystems[1]).toContain("<project_context>");
      expect(workerSystems[1]).toContain("WORKTREE_BRANCH_GUIDELINE");
      expect(workerSystems[1]).not.toContain("MAIN_REPO_GUIDELINE");
    } finally {
      hob.close();
    }
  });
});

describe("工具集成：show_assistant / show_group / create_group / manage_topic / open_topic / message_group / send_file", () => {
  it("各管理工具与路由工具正确展示、透传和拦截 cwd", async () => {
    const hob = makeHob({}, { memory: "off" });
    const astDir = makeTempDir("hob-ws-tool-ast-");
    const grpDir = makeTempDir("hob-ws-tool-grp-");
    const topicDir = makeTempDir("hob-ws-tool-topic-");
    try {
      const dev = addAssistant(hob, "dev", { name: "开发", cwd: astDir });
      const plain = addAssistant(hob, "ops", { name: "运维" });
      const hobTools = buildRouterTools(hob.runtime, "hob");
      const findTool = (list: typeof hobTools, name: string) => list.find((item) => item.name === name)!;

      // show_assistant：普通助手显示工作目录 / 未设置（默认），主助手不显示
      const showAssistant = findTool(hobTools, "show_assistant");
      const devProfile = (await showAssistant.execute("s1", { assistantId: dev.id })).content[0] as { text: string };
      expect(devProfile.text).toContain(`工作目录：${astDir}`);
      const opsProfile = (await showAssistant.execute("s2", { assistantId: plain.id })).content[0] as { text: string };
      expect(opsProfile.text).toContain("工作目录：未设置（默认）");
      const hobProfile = (await showAssistant.execute("s3", { assistantId: "hob" })).content[0] as { text: string };
      expect(hobProfile.text).not.toContain("工作目录：");

      // create_group：支持 cwd，update_group 不暴露 cwd
      const createGroup = findTool(hobTools, "create_group");
      const updateGroup = findTool(hobTools, "update_group");
      expect("cwd" in (updateGroup.parameters.properties ?? {})).toBe(false);
      const createdLocked = await createGroup.execute("cg1", {
        name: "前端组",
        purpose: "负责前端开发",
        ownerId: dev.id,
        members: [dev.id, "hob"],
        cwd: grpDir,
      });
      expect(createdLocked.isError).not.toBe(true);
      const lockedGroup = hob.runtime.store.groups().find((g) => g.name === "前端组")!;
      expect(lockedGroup.cwd).toBe(grpDir);

      const createdFree = await createGroup.execute("cg2", {
        name: "通用组",
        purpose: "跨仓库讨论",
        ownerId: "hob",
        members: ["hob", dev.id],
      });
      expect(createdFree.isError).not.toBe(true);
      const freeGroup = hob.runtime.store.groups().find((g) => g.name === "通用组")!;
      expect(freeGroup.cwd).toBeUndefined();

      // manage_topic(open)：群已绑时传 cwd 拒绝，未传沿用；群未绑时可设 cwd；对 close/reopen/rename 传 cwd 拒绝
      const manageTopic = findTool(hobTools, "manage_topic");
      const mtConflict = await manageTopic.execute("mt1", { action: "open", groupId: lockedGroup.id, title: "冲突话题", cwd: topicDir });
      expect(mtConflict.isError).toBe(true);
      const mtFollow = await manageTopic.execute("mt2", { action: "open", groupId: lockedGroup.id, title: "跟随群话题" });
      expect(mtFollow.isError).not.toBe(true);
      const followTopic = hob.runtime.groups.topicsOf(lockedGroup.id)[0]!;

      // 在通用组中，主助手在单聊给非群主或由 manage_topic 演示：先换 owner 为 dev 以便主助手用 manage_topic(open)
      hob.runtime.groups.update(freeGroup.id, { ownerId: dev.id });
      const mtFree = await manageTopic.execute("mt3", { action: "open", groupId: freeGroup.id, title: "独立目录话题", cwd: topicDir });
      expect(mtFree.isError).not.toBe(true);
      const freeTopic = hob.runtime.groups.topicsOf(freeGroup.id)[0]!;
      expect(freeTopic.cwd).toBe(topicDir);

      for (const action of ["rename", "close", "reopen"] as const) {
        const bad = await manageTopic.execute(`mt-${action}`, { action, topicId: freeTopic.id, title: "新名", cwd: grpDir });
        expect(bad.isError, action).toBe(true);
        expect((bad.content[0] as { text: string }).text).toContain("工作目录仅支持在创建时绑定，创建后不可修改。");
      }

      // show_group：展示群和话题（跟随群 vs 本话题）的工作目录
      const showGroup = findTool(hobTools, "show_group");
      const lockedView = (await showGroup.execute("sg1", { groupId: lockedGroup.id })).content[0] as { text: string };
      expect(lockedView.text).toContain(`工作目录：${grpDir}`);
      const followTopicView = (await showGroup.execute("sg2", { groupId: followTopic.id })).content[0] as { text: string };
      expect(followTopicView.text).toContain(`工作目录：跟随群（${grpDir}）`);
      const freeTopicView = (await showGroup.execute("sg3", { groupId: freeTopic.id })).content[0] as { text: string };
      expect(freeTopicView.text).toContain(`工作目录：${topicDir}`);

      // open_topic：群未绑时暴露 cwd 且创建新话题可带 cwd、转到已有话题传 cwd 拒；群已绑时隐藏 cwd 且忽略强传 cwd
      vi.spyOn(hob.runtime.groups, "deliverEvent").mockResolvedValue();
      const devFreeTools = buildRouterTools(hob.runtime, dev.id, freeGroup.id);
      const openFree = findTool(devFreeTools, "open_topic");
      expect("cwd" in openFree.parameters.properties).toBe(true);
      expect(openFree.parameters.properties.cwd.description).toBe("仅创建新话题（填 title）时可选，话题的工作目录（绝对路径，创建后不可修改）。");
      const openedNew = await openFree.execute("ot1", { title: "话题二", note: "交接说明", cwd: topicDir });
      expect(openedNew.isError).not.toBe(true);
      const topic2 = hob.runtime.groups.topicsOf(freeGroup.id).find((t) => t.name === "话题二")!;
      expect(topic2.cwd).toBe(topicDir);

      const openExistingWithCwd = await openFree.execute("ot2", { topic: topic2.id, note: "转过去", cwd: grpDir });
      expect(openExistingWithCwd.isError).toBe(true);
      expect((openExistingWithCwd.content[0] as { text: string }).text).toContain("工作目录仅支持在创建时绑定，创建后不可修改。");

      const devLockedTools = buildRouterTools(hob.runtime, dev.id, lockedGroup.id, grpDir);
      const openLocked = findTool(devLockedTools, "open_topic");
      expect("cwd" in openLocked.parameters.properties).toBe(false);
      const openLockedForced = await openLocked.execute("ot3", { title: "忽略强传目录", note: "说明", cwd: topicDir });
      expect(openLockedForced.isError).not.toBe(true);
      const lockedTopic2 = hob.runtime.groups.topicsOf(lockedGroup.id).find((t) => t.name === "忽略强传目录")!;
      expect(lockedTopic2.cwd).toBeUndefined();
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, dev.id, lockedTopic2.id)).toMatchObject({ bound: grpDir, source: "group", sessionCwd: grpDir });

      // message_group：目标群未设 cwd 时可传 cwd；目标群已设 cwd 时传非空 cwd 拒绝
      const msgGroup = findTool(hobTools, "message_group");
      const mgOk = await msgGroup.execute("mg1", { groupId: freeGroup.id, title: "交接任务", note: "请处理", cwd: topicDir });
      expect(mgOk.isError).not.toBe(true);
      const handedTopic = hob.runtime.groups.topicsOf(freeGroup.id).find((t) => t.name === "交接任务")!;
      expect(handedTopic.cwd).toBe(topicDir);

      const mgConflict = await msgGroup.execute("mg2", { groupId: lockedGroup.id, title: "冲突交接", note: "请处理", cwd: topicDir });
      expect(mgConflict.isError).toBe(true);

      // send_file：外部绑定目录普通文件复制进 files/sent/（原文件删除后仍可读）；敏感文件 .env 被拒绝
      const reportFile = join(astDir, "summary.txt");
      writeFileSync(reportFile, "季度汇总内容");
      writeFileSync(join(astDir, ".env"), "TOKEN=secret");
      const devTools = buildRouterTools(hob.runtime, dev.id, undefined, astDir);
      const sendFile = findTool(devTools, "send_file");

      const sent = await sendFile.execute("sf1", { path: "summary.txt" });
      expect(sent.isError).not.toBe(true);
      const fileItem = hob.runtime.router.items(dev.id).items.find((item) => item.kind === "file") as { kind: "file"; path: string };
      expect(fileItem.path.startsWith(join(hob.home, "assistants", dev.id, "files", "sent"))).toBe(true);
      rmSync(reportFile);
      expect(readFileSync(fileItem.path, "utf8")).toBe("季度汇总内容");
      expect(lookupFile(hob.home, fileItem.path).ok).toBe(true);

      const sentSecret = await sendFile.execute("sf2", { path: ".env" });
      expect(sentSecret.isError).toBe(true);
      expect((sentSecret.content[0] as { text: string }).text).toContain("这个文件不对页面开放");
    } finally {
      hob.close();
    }
  });

  it("按会话上下文调整 start_job 与 open_topic 的 cwd 参数：已绑定会话的任务只能在绑定目录里面运行", async () => {
    const hob = makeHob({}, { memory: "off" });
    const astDir = makeTempDir("hob-ws-hide-ast-");
    const grpDir = makeTempDir("hob-ws-hide-grp-");
    const topicDir = makeTempDir("hob-ws-hide-topic-");
    const otherDir = makeTempDir("hob-ws-hide-other-");
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);
      vi.spyOn(hob.runtime.groups, "deliverEvent").mockResolvedValue();

      const dev = addAssistant(hob, "dev", { name: "开发", cwd: astDir });
      const writer = addAssistant(hob, "writer", { name: "写手" });
      const lockedGroup = hob.runtime.groups.create({
        name: "绑定群",
        purpose: "项目维护",
        ownerId: "hob",
        members: ["hob", dev.id, writer.id],
        cwd: grpDir,
      });
      const freeGroup = hob.runtime.groups.create({
        name: "自由群",
        purpose: "综合协作",
        ownerId: "hob",
        members: ["hob", dev.id, writer.id],
      });
      const boundTopic = hob.runtime.groups.createTopic(freeGroup.id, "绑定话题", "hob", { cwd: topicDir });
      const freeTopic = hob.runtime.groups.createTopic(freeGroup.id, "未绑定话题", "hob");

      const findTool = (tools: ReturnType<typeof buildRouterTools>, name: string) =>
        tools.find((t) => t.name === name)!;

      // 1. 未绑定会话：start_job 暴露 cwd（含精简说明）
      const unboundStartCases = [
        { label: "主助手单聊", tools: buildRouterTools(hob.runtime, "hob") },
        { label: "未绑定助手单聊", tools: buildRouterTools(hob.runtime, writer.id) },
        { label: "未绑定群综合", tools: buildRouterTools(hob.runtime, "hob", freeGroup.id) },
        { label: "未绑定话题", tools: buildRouterTools(hob.runtime, "hob", freeTopic.id) },
      ];
      for (const { label, tools } of unboundStartCases) {
        const startTool = findTool(tools, "start_job");
        expect("cwd" in startTool.parameters.properties, label).toBe(true);
        expect(startTool.parameters.properties.cwd.description, label).toBe(
          "可选。填了，任务的命令默认就在这个目录里运行，改动直接落在这里，适合直接修改一个现成的项目。不填，任务在自己的目录里执行；只是读取某个项目，或者要另拉一份隔离着执行，不用填。相对路径以你的工作目录为准。",
        );
      }

      // 2. 已绑定会话（单聊助手绑定、群绑定、话题绑定）：start_job 的 cwd 只收绑定目录里面的子目录，出了绑定目录拒绝，不填落在绑定目录
      hob.faux.setResponses([
        call("report", { outcome: "done", result: "ast ok" }),
        call("report", { outcome: "done", result: "grp ok" }),
        call("report", { outcome: "done", result: "topic ok" }),
        call("report", { outcome: "done", result: "ast sub ok" }),
        call("report", { outcome: "done", result: "grp sub ok" }),
        call("report", { outcome: "done", result: "topic sub ok" }),
      ]);
      const boundStartCases = [
        { label: "单聊助手绑定", title: "强传单聊", tools: buildRouterTools(hob.runtime, dev.id, undefined, astDir), expectedCwd: astDir },
        { label: "群绑定", title: "强传群聊", tools: buildRouterTools(hob.runtime, "hob", lockedGroup.id, grpDir), expectedCwd: grpDir },
        { label: "话题绑定", title: "强传话题", tools: buildRouterTools(hob.runtime, "hob", boundTopic.id, topicDir), expectedCwd: topicDir },
      ];
      for (const { label, title, tools, expectedCwd } of boundStartCases) {
        const startTool = findTool(tools, "start_job");
        expect(startTool.parameters.properties.cwd.description, label).toContain(`不填，任务就在 ${expectedCwd} 里运行`);
        const outside = await startTool.execute(`out-${title}`, { title: `${title}-外面`, note: "出了绑定目录", cwd: otherDir });
        expect((outside.content[0] as { text: string }).text, label).toContain(CWD_BOUND_LOCKED);
        const res = await startTool.execute(`plain-${title}`, { title, note: "不填 cwd" });
        expect(res.isError, label).not.toBe(true);
        expect(hob.runtime.store.jobs().find((j) => j.title === title)!.cwd, label).toBe(expectedCwd);
        mkdirSync(join(expectedCwd, "wt"), { recursive: true });
        const sub = await startTool.execute(`sub-${title}`, { title: `${title}-子目录`, note: "子目录", cwd: "wt" });
        expect(sub.isError, label).not.toBe(true);
        expect(hob.runtime.store.jobs().find((j) => j.title === `${title}-子目录`)!.cwd, label).toBe(join(expectedCwd, "wt"));
      }
      await hob.runtime.jobs.waitIdle();

      // 3. open_topic：群已绑定 cwd 时隐藏 cwd（且强传不透传）；群未绑定 cwd 时暴露 cwd
      const lockedOpenTopic = findTool(buildRouterTools(hob.runtime, "hob", lockedGroup.id, grpDir), "open_topic");
      expect("cwd" in lockedOpenTopic.parameters.properties).toBe(false);
      const lockedOpenRes = await lockedOpenTopic.execute("ot-locked", { title: "群绑话题", note: "交接", cwd: otherDir });
      expect(lockedOpenRes.isError).not.toBe(true);
      const createdLockedTopic = hob.runtime.groups.topicsOf(lockedGroup.id).find((t) => t.name === "群绑话题")!;
      expect(createdLockedTopic.cwd).toBeUndefined();
      expect(resolveWorkspaceCwd(hob.runtime.store, hob.home, "hob", createdLockedTopic.id).bound).toBe(grpDir);

      const freeOpenTopic = findTool(buildRouterTools(hob.runtime, "hob", freeGroup.id), "open_topic");
      expect("cwd" in freeOpenTopic.parameters.properties).toBe(true);
      expect(freeOpenTopic.parameters.properties.cwd.description).toBe(
        "仅创建新话题（填 title）时可选，话题的工作目录（绝对路径，创建后不可修改）。",
      );
      const freeOpenRes = await freeOpenTopic.execute("ot-free", { title: "自由新话题", note: "交接", cwd: otherDir });
      expect(freeOpenRes.isError).not.toBe(true);
      const createdFreeTopic = hob.runtime.groups.topicsOf(freeGroup.id).find((t) => t.name === "自由新话题")!;
      expect(createdFreeTopic.cwd).toBe(otherDir);
    } finally {
      hob.close();
    }
  });

  it("send_file 无条件拦截工作目录外敏感文件与目录内软链逃逸敏感文件，绝不复制到 files/sent/", async () => {
    const hob = makeHob({}, { memory: "off" });
    const boundDir = makeTempDir("hob-ws-send-bound-");
    const outsideDir = makeTempDir("hob-ws-send-out-");
    try {
      const dev = addAssistant(hob, "dev", { name: "开发", cwd: boundDir });
      const devTools = buildRouterTools(hob.runtime, dev.id, undefined, boundDir);
      const sendFile = devTools.find((t) => t.name === "send_file")!;

      // 构造外部敏感文件（.env、id_rsa、.aws/credentials、.ssh/config、.git/config、.bak）
      const extEnv = join(outsideDir, ".env");
      const extKey = join(outsideDir, "id_rsa");
      const extAwsDir = join(outsideDir, ".aws");
      const extSshDir = join(outsideDir, ".ssh");
      const extGitDir = join(outsideDir, ".git");
      mkdirSync(extAwsDir, { recursive: true });
      mkdirSync(extSshDir, { recursive: true });
      mkdirSync(extGitDir, { recursive: true });
      const extAwsCreds = join(extAwsDir, "credentials");
      const extSshConfig = join(extSshDir, "config");
      const extGitConfig = join(extGitDir, "config");
      const extBak = join(outsideDir, "dump.sql.bak");
      writeFileSync(extEnv, "API_KEY=secret");
      writeFileSync(extKey, "PRIVATE KEY");
      writeFileSync(extAwsCreds, "[default]\naws_secret_access_key=xxx");
      writeFileSync(extSshConfig, "Host prod\nIdentityFile ~/.ssh/id_rsa");
      writeFileSync(extGitConfig, "[core]\nrepositoryformatversion = 0");
      writeFileSync(extBak, "secret backup");

      // HOB_HOME/system/secrets.json
      const hobSecret = join(hob.home, "system", "secrets.json");
      mkdirSync(join(hob.home, "system"), { recursive: true });
      writeFileSync(hobSecret, '{"token":"top-secret"}');

      // 1. 绑定目录内软链指向外部 .env / id_rsa / .ssh/config / HOB_HOME/system/secrets.json
      symlinkSync(extEnv, join(boundDir, "report-env.txt"));
      symlinkSync(extKey, join(boundDir, "report-key.txt"));
      symlinkSync(extSshConfig, join(boundDir, "report-ssh.txt"));
      symlinkSync(hobSecret, join(boundDir, "report-hob.txt"));

      const sentDir = join(hob.home, "assistants", dev.id, "files", "sent");
      for (const rel of ["report-env.txt", "report-key.txt", "report-ssh.txt", "report-hob.txt"]) {
        const res = await sendFile.execute(`sym-${rel}`, { path: rel });
        expect(res.isError, rel).toBe(true);
        expect((res.content[0] as { text: string }).text, rel).toContain("这个文件不对页面开放");
      }

      // 2. 直接对绑定目录外的敏感路径调用 send_file
      for (const abs of [extAwsCreds, extSshConfig, extGitConfig, extEnv, extKey, extBak, hobSecret]) {
        const res = await sendFile.execute(`abs-${abs}`, { path: abs });
        expect(res.isError, abs).toBe(true);
        expect((res.content[0] as { text: string }).text, abs).toContain("这个文件不对页面开放");
      }

      // 核验 files/sent/ 未产生任何复制文件，也未发出任何 file item
      expect(existsSync(sentDir) ? readdirSync(sentDir) : []).toHaveLength(0);
      expect(hob.runtime.router.items(dev.id).items.filter((item) => item.kind === "file")).toHaveLength(0);

      // checkSensitivePath 直接单测：普通文件放行，敏感文件拒绝
      const normalFile = join(outsideDir, "notes.txt");
      writeFileSync(normalFile, "hello");
      expect(checkSensitivePath(normalFile, hob.home)).toBeUndefined();
      expect(checkSensitivePath(extAwsCreds, hob.home)).toBe("这个文件不对页面开放");
      expect(checkSensitivePath(join(boundDir, "report-key.txt"), hob.home)).toBe("这个文件不对页面开放");
    } finally {
      hob.close();
    }
  });

  it("群里不看成员自己的目录：未绑定的群和话题里，绑了目录的成员和没绑的一样", async () => {
    const hob = makeHob({}, { memory: "off" });
    const dirA = makeTempDir("hob-ws-cross-a-");
    const dirC = makeTempDir("hob-ws-cross-c-");
    const otherDir = makeTempDir("hob-ws-cross-other-");
    const grpDir = makeTempDir("hob-ws-cross-grp-");
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue(true);

      const memberA = addAssistant(hob, "dev-a", { name: "开发A", cwd: dirA });
      const memberB = addAssistant(hob, "writer-b", { name: "写手B" });
      const memberC = addAssistant(hob, "ops-c", { name: "运维C", cwd: dirC });
      const freeGroup = hob.runtime.groups.create({
        name: "自由协作群",
        purpose: "跨成员协作",
        ownerId: memberA.id,
        members: [memberA.id, memberB.id, memberC.id],
      });
      const freeTopic = hob.runtime.groups.createTopic(freeGroup.id, "临时话题", memberA.id);
      const lockedGroup = hob.runtime.groups.create({
        name: "固定项目群",
        purpose: "项目维护",
        ownerId: memberA.id,
        members: [memberA.id, memberB.id],
        cwd: grpDir,
      });

      // 1. 绑了目录的 A 在未绑定的群和话题里：start_job 的 cwd 说明和没绑定的会话一样
      const unboundDescription = buildRouterTools(hob.runtime, memberB.id, freeGroup.id).find((t) => t.name === "start_job")!.parameters.properties.cwd.description;
      const startAInFreeGroup = buildRouterTools(hob.runtime, memberA.id, freeGroup.id).find((t) => t.name === "start_job")!;
      const startAInFreeTopic = buildRouterTools(hob.runtime, memberA.id, freeTopic.id).find((t) => t.name === "start_job")!;
      expect(startAInFreeGroup.parameters.properties.cwd.description).toBe(unboundDescription);
      expect(startAInFreeTopic.parameters.properties.cwd.description).toBe(unboundDescription);

      hob.faux.setResponses([
        call("report", { outcome: "done", result: "1" }),
        call("report", { outcome: "done", result: "2" }),
        call("report", { outcome: "done", result: "3" }),
      ]);

      // 2. 不填 cwd：派给自己、派给绑了目录的 C，都落在任务自己的目录，不用成员自己的目录
      await startAInFreeGroup.execute("x1", { title: "A派自己默认", note: "执行" });
      const aSelf = hob.runtime.store.jobs().find((j) => j.title === "A派自己默认")!;
      expect(aSelf.cwd).toBe(join(hob.home, "assistants", memberA.id, "jobs", aSelf.id, "work"));
      await startAInFreeGroup.execute("x2", { title: "A派C默认", note: "执行", assistantId: memberC.id });
      const aToC = hob.runtime.store.jobs().find((j) => j.title === "A派C默认")!;
      expect(aToC.cwd).toBe(join(hob.home, "assistants", memberC.id, "jobs", aToC.id, "work"));

      // 3. 填了 cwd：群里不受成员自己绑定的限制
      const aToCExplicit = await startAInFreeGroup.execute("x3", { title: "A派C显式目录", note: "执行", assistantId: memberC.id, cwd: otherDir });
      expect(aToCExplicit.isError).not.toBe(true);
      expect(hob.runtime.store.jobs().find((j) => j.title === "A派C显式目录")?.cwd).toBe(otherDir);

      await hob.runtime.jobs.waitIdle();

      // 4. 提示词：单聊用助手自己的目录，绑定的群用群的
      const basePromptOpts = { timezone: "Asia/Shanghai", aboutYou: { name: "", language: "", notes: "" }, memory: "off" as const };
      const dmPrompt = buildSystemPrompt(hob.runtime.store, memberA.id, {
        ...basePromptOpts,
        workspace: { cwd: dirA, source: "assistant", ownDir: "/own" },
      });
      expect(dmPrompt).toContain(`当前工作目录：${dirA}（来源：你的设置）。命令、文件读写和派出的任务都在这个目录进行。`);

      const lockedGroupPrompt = buildSystemPrompt(hob.runtime.store, memberA.id, {
        ...basePromptOpts,
        group: lockedGroup,
        workspace: { cwd: grpDir, source: "group", ownDir: "/own" },
      });
      expect(lockedGroupPrompt).toContain(`当前工作目录：${grpDir}（来源：本群）。命令、文件读写和派出的任务都在这个目录进行。你自己的目录是 /own：技能草稿、临时文件和中间产物放在那里，项目目录里只留项目要的改动。`);
    } finally {
      hob.close();
    }
  });
});
