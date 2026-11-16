import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { importSkills, listImportSkills, skillViews, visibleSkills, loadedVisibleSkills } from "../src/skills.ts";
import { archiveSkill } from "../src/assistant-skills.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { saveLoreConnection, testLoreConnection } from "../src/memory.ts";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";

describe("技能来源", () => {
  it("只发现通用和 Hob 目录，重名时 Hob 优先", () => {
    const root = mkdtempSync(join(tmpdir(), "hob-skills-"));
    try {
      const home = join(root, "home");
      const hob = join(root, "hob");
      const skill = (rootDir: string, name: string, description: string) => {
        const dir = join(rootDir, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n正文\n`);
      };
      skill(join(home, ".agents/skills"), "a", "本机");
      skill(join(home, ".agents/skills"), "c", "本机版本");
      skill(join(hob, "skills"), "b", "Hob");
      skill(join(hob, "skills"), "c", "Hob版本");
      skill(join(hob, "skills"), "d", "Hob 停用的");
      skill(join(hob, "engine/skills"), "ignored", "不加载");
      const runtime = makeHob();
      try {
        const views = skillViews(hob, ["hob:d"], [], home);
        expect(views.map((item) => `${item.source}:${item.name}`).sort()).toEqual(["common:a", "common:c", "hob:b", "hob:c", "hob:d"]);
        expect(views.find((item) => item.source === "hob" && item.name === "c")?.overridden).toBe(false);
        expect(views.find((item) => item.source === "common" && item.name === "c")?.overridden).toBe(true);
        expect(views.find((item) => item.name === "d")?.enabled).toBe(false);
      } finally { runtime.close(); }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("任务会话加载 Lore 发现的目录并按 Hob、Lore、本机顺序去重", async () => {
    const hob = makeHob();
    try {
      const lore = join(hob.home, "system", "lore");
      const loreRoot = join(lore, "skills", "proj");
      const ownRoot = join(hob.home, "skills");
      const commonRoot = join(hob.home, "user", ".agents", "skills");
      const create = (root: string, name: string, description: string) => {
        const dir = join(root, name); mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n正文\n`);
      };
      create(ownRoot, "own", "Hob"); create(ownRoot, "shared", "Hob 优先");
      create(loreRoot, "shared", "Lore 次之"); create(loreRoot, "loreonly", "Lore 技能");
      create(commonRoot, "shared", "本机"); create(commonRoot, "commononly", "本机技能");
      const project = join(hob.home, "project"); create(join(project, ".agents", "skills"), "projectonly", "项目技能");
      writeFileSync(join(lore, "config.json"), JSON.stringify({ base_url: "http://127.0.0.1:30198", api_token: "fake", server_profile: { base_url: "http://127.0.0.1:30198", capabilities: { skills: true } } }));
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ project_id: "proj", catalog_revision: "1", skills: [] }), { status: 200 })));
      await hob.runtime.pi.discoverLoreSkills();
      expect(hob.runtime.pi.loreSkillPaths).toEqual([loreRoot]);
      const skills = visibleSkills(hob.runtime, "hob", undefined, join(hob.home, "user"));
      const opened = await hob.runtime.pi.open({ file: join(hob.home, "session.jsonl"), cwd: project, model: "hob-faux/faux-1", thinking: "off", memory: "lore", systemPrompt: () => "测试", tools: ["read"], customTools: [], skills: loadedVisibleSkills(skills) });
      const loaded = opened.session.resourceLoader.getSkills().skills;
      expect(loaded.map((skill) => skill.name).sort()).toEqual(["commononly", "loreonly", "own", "shared"]);
      expect(loaded.find((skill) => skill.name === "shared")?.description).toBe("Hob 优先");
      expect(opened.session.systemPrompt).toContain("loreonly");
      expect(opened.session.getActiveToolNames()).toContain("lore_search");
      expect(opened.session.getActiveToolNames().some((name) => name.startsWith("lore_skill_"))).toBe(false);
      opened.session.dispose();
      const disabled = ["hob:shared", "lore:loreonly"];
      hob.runtime.settings.patch(hob.runtime.settings.get().revision, { skills: { disabled } });
      const next = await hob.runtime.pi.open({ file: join(hob.home, "session2.jsonl"), cwd: project, model: "hob-faux/faux-1", thinking: "off", memory: "lore", systemPrompt: () => "测试", tools: ["read"], customTools: [], skills: loadedVisibleSkills(visibleSkills(hob.runtime, "hob", undefined, join(hob.home, "user"))), disabledSkills: disabled });
      const nextSkills = next.session.resourceLoader.getSkills().skills;
      expect(nextSkills.find((skill) => skill.name === "shared")?.description).toBe("Lore 次之");
      expect(nextSkills.some((skill) => skill.name === "loreonly")).toBe(false);
      next.session.dispose();
    } finally { vi.unstubAllGlobals(); hob.close(); }
  });

  it("测试已保存的 Lore 连接后记录服务端技能能力", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-lore-capabilities-"));
    try {
      saveLoreConnection(home, { baseUrl: "http://127.0.0.1:30198", token: "fake" });
      const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({ capabilities: { skills: true } }), { status: 200 });
      expect(await testLoreConnection(home, {}, { fetchImpl })).toEqual({ ok: true, baseUrl: "http://127.0.0.1:30198" });
      const config = JSON.parse(readFileSync(join(home, "system", "lore", "config.json"), "utf8"));
      expect(config.server_profile).toEqual({ base_url: "http://127.0.0.1:30198", capabilities: { skills: true } });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("导入、跳过、覆盖、越界链接和大小限制", () => {
    const root = mkdtempSync(join(tmpdir(), "hob-skills-import-"));
    try {
      const user = join(root, "user"); const hob = join(root, "hob");
      expect(listImportSkills(hob, "codex", user)).toEqual({ found: false, skills: [], skipped: [] });
      const src = join(user, ".pi", "agent", "skills", "a");
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, "SKILL.md"), "---\nname: a\ndescription: 测试\n---\n正文\n");
      writeFileSync(join(root, "secret"), "secret");
      symlinkSync(join(root, "secret"), join(src, "outside"));
      symlinkSync(join(src, ".."), join(src, "..", "loop"));
      symlinkSync(root, join(src, "..", "external-root"));
      expect(listImportSkills(hob, "pi", user).skipped.join()).toContain("external-root");
      mkdirSync(join(src, "node_modules")); writeFileSync(join(src, "node_modules", "x"), "x");
      const first = importSkills(hob, "pi", ["a"], false, user);
      expect(first.imported).toEqual(["a"]); expect(first.skipped.join()).toContain("越界");
      expect(existsSync(join(hob, "skills", "a", "outside"))).toBe(false);
      expect(existsSync(join(hob, "skills", "a", "node_modules"))).toBe(false);
      expect(importSkills(hob, "pi", ["a"], false, user).skipped.join()).toContain("已存在");
      writeFileSync(join(src, "extra"), "new");
      expect(importSkills(hob, "pi", ["a"], true, user).imported).toEqual(["a"]);
      expect(readFileSync(join(hob, "skills", "a", "extra"), "utf8")).toBe("new");
      writeFileSync(join(src, "large"), ""); truncateSync(join(src, "large"), 20 * 1024 * 1024 + 1);
      expect(importSkills(hob, "pi", ["a"], true, user).errors.join()).toContain("超过 20MB");
      expect(readFileSync(join(hob, "skills", "a", "extra"), "utf8")).toBe("new");
      // 覆盖算一次新版本：旧的进历史，索引升一版
      expect(readdirSync(join(hob, "skills", "a", ".history")).some((entry) => /^\d+$/.test(entry))).toBe(true);
      expect(archiveSkill).toBeTypeOf("function");
      archiveSkill(join(hob, "skills"), "a"); expect(existsSync(join(hob, "skills", "a"))).toBe(false);
      expect(readdirSync(join(hob, "skills", ".archive")).length).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("技能接口要求登录，只能删除 Hob 自己的技能", async () => {
    const hob = makeHob();
    try {
      const dir = join(hob.home, "skills", "mine"); mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "---\nname: mine\ndescription: 自有技能\n---\n正文\n");
      hob.runtime.settings.setThinking("hob-faux/faux-1", { high: "custom" });
      const updated = hob.runtime.settings.patch(hob.runtime.settings.get().revision, { skills: { disabled: ["hob:mine"] } });
      expect(updated?.settings.models.thinking?.["hob-faux/faux-1"]?.high).toBe("custom");
      const app = createApp(hob.runtime, { home: hob.home });
      expect((await app.request("/api/skills")).status).toBe(401);
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const response = await app.request("/api/skills", { headers: { cookie } });
      const result = await response.json() as { skills: { name: string; source: string }[]; loreActive: boolean };
      expect(result.loreActive).toBe(false);
      expect(result.skills).toContainEqual(expect.objectContaining({ name: "mine", source: "hob" }));
      const memory = hob.runtime.settings.memory();
      hob.runtime.settings.memory = () => ({ ...memory, provider: "lore" });
      hob.runtime.pi.discoverLoreSkills = async () => { throw new Error("Lore 连不上"); };
      const broken = await (await app.request("/api/skills", { headers: { cookie } })).json() as { skills: { name: string }[]; loreError?: string };
      expect(broken.loreError).toBe("Lore 连不上");
      expect(broken.skills).toContainEqual(expect.objectContaining({ name: "mine" }));
      expect((await app.request("/api/skills/mine", { method: "DELETE", headers: { cookie } })).status).toBe(200);
      expect(existsSync(dir)).toBe(false);
      expect(readdirSync(join(hob.home, "skills", ".archive")).some((entry) => entry.startsWith("mine"))).toBe(true);
    } finally { hob.close(); }
  });

  it("Router 只在存在技能时列出技能清单", () => {
    const hob = makeHob();
    try {
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      const options = { timezone, aboutYou, memory: "off" as const };
      expect(buildSystemPrompt(hob.runtime.store, "hob", options)).not.toContain("你能用的技能");
      const skill = { name: "a", title: "甲", description: "说明", path: "/skills/a/SKILL.md", dir: "/skills/a", scope: "general" as const, editable: true, version: 1, updatedAt: "2026-11-05T15:57:00Z" };
      const prompt = buildSystemPrompt(hob.runtime.store, "hob", { ...options, skills: [skill] });
      expect(prompt).toContain("你能用的技能（括号里是它的文件，需要时可以读）：\n- a「甲」· 通用 · 第 1 版 · ");
    } finally {
      hob.close();
    }
  });
});
