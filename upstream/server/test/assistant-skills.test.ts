import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveAssistantSkill, listAssistantSkills, recordAssistantSkillUse, rollbackAssistantSkill, saveAssistantSkill, setAssistantSkillEnabled } from "../src/assistant-skills.ts";

const homes: string[] = [];
function home() { const dir = mkdtempSync(join(tmpdir(), "hob-assistant-skills-")); homes.push(dir); return dir; }
const input = { name: "daily-check", title: "每日巡检", description: "日常巡检时使用", content: "步骤", files: [{ path: "scripts/check.sh", content: "echo ok" }] };
afterEach(() => { for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("助手技能存储", () => {
  it("保存、修补、保留五版并回退", () => {
    const dir = home();
    expect(saveAssistantSkill(dir, "hob", input, "job-1").version).toBe(1);
    for (let i = 2; i <= 7; i++) saveAssistantSkill(dir, "hob", { ...input, content: `步骤 ${i}` });
    const history = join(dir, "assistants/hob/skills/daily-check/.history");
    expect(readdirSync(history).sort()).toEqual(["2", "3", "4", "5", "6"]);
    const result = rollbackAssistantSkill(dir, "hob", input.name);
    expect(result.version).toBe(8);
    expect(readFileSync(result.path, "utf8")).toContain("步骤 6");
    expect(result.fromJobId).toBe("job-1");
  });
  it("覆盖当前版本更新日期并保留历史", () => {
    const dir = home();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      saveAssistantSkill(dir, "hob", input);
      const version = saveAssistantSkill(dir, "hob", { ...input, content: "第二版" });
      vi.setSystemTime(new Date("2026-01-02T00:00:00Z"));
      const saved = saveAssistantSkill(dir, "hob", { ...input, content: "覆盖版" }, "job-1", false, { overwriteVersion: true });
      expect(saved.version).toBe(version.version);
      expect(saved.updatedAt).toBe("2026-01-02T00:00:00.000Z");
      expect(saved.createdAt).toBe(version.createdAt);
      expect(readdirSync(join(dir, "assistants/hob/skills/daily-check/.history"))).toEqual(["1"]);
    } finally { vi.useRealTimers(); }
  });
  it("累计附件和路径冲突在修改前拒绝", () => {
    const dir = home();
    saveAssistantSkill(dir, "hob", { ...input, files: Array.from({ length: 20 }, (_, i) => ({ path: `scripts/${i}`, content: "x" })) });
    expect(() => saveAssistantSkill(dir, "hob", { ...input, files: [{ path: "scripts/extra", content: "x" }] })).toThrow(/20/);
    expect(() => saveAssistantSkill(dir, "hob", { ...input, files: [{ path: "scripts/0/sub", content: "x" }] })).toThrow();
    expect(listAssistantSkills(dir, "hob")[0].version).toBe(1);
  });
  it("记录用量、停用和归档", () => {
    const dir = home();
    saveAssistantSkill(dir, "hob", input);
    recordAssistantSkillUse(dir, "hob", input.name);
    const skill = setAssistantSkillEnabled(dir, "hob", input.name, false);
    expect(skill).toMatchObject({ uses: 1, enabled: false });
    expect(skill.lastUsedAt).toBeTruthy();
    archiveAssistantSkill(dir, "hob", input.name);
    expect(listAssistantSkills(dir, "hob")).toEqual([]);
    expect(readdirSync(join(dir, "assistants/hob/skills/.archive"))).toHaveLength(1);
  });
  it("拒绝越界、符号链接和超限内容", () => {
    const dir = home();
    for (const name of ["../bad", "a", "UPPER"]) expect(() => saveAssistantSkill(dir, "hob", { ...input, name })).toThrow();
    for (const path of ["scripts/../../evil", "references/../evil", "/tmp/evil"]) expect(() => saveAssistantSkill(dir, "hob", { ...input, files: [{ path, content: "x" }] })).toThrow();
    expect(() => saveAssistantSkill(dir, "hob", { ...input, content: "x".repeat(20001) })).toThrow();
    expect(() => saveAssistantSkill(dir, "hob", { ...input, files: [{ path: "scripts/a", content: "x".repeat(200 * 1024 + 1) }] })).toThrow();
    expect(() => saveAssistantSkill(dir, "hob", { ...input, files: Array.from({ length: 21 }, (_, i) => ({ path: `scripts/${i}`, content: "x" })) })).toThrow();
    saveAssistantSkill(dir, "hob", input);
    const scripts = join(dir, "assistants/hob/skills/daily-check/scripts");
    rmSync(scripts, { recursive: true }); symlinkSync(join(dir, "outside"), scripts);
    expect(() => saveAssistantSkill(dir, "hob", input)).toThrow();
    expect(existsSync(join(dir, "outside/check.sh"))).toBe(false);
    mkdirSync(join(dir, "assistants/other"), { recursive: true });
    symlinkSync(join(dir, "outside"), join(dir, "assistants/other/skills"));
    expect(() => saveAssistantSkill(dir, "other", input)).toThrow();
  });
});
