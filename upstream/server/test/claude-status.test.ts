import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeStatus } from "../src/claude-status.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fakeClaude(): { home: string; executable: string } {
  const home = mkdtempSync(join(tmpdir(), "hob-claude-status-"));
  dirs.push(home);
  const executable = join(home, "claude");
  writeFileSync(executable, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('2.1.296 (Claude Code)');\nelse console.log(JSON.stringify({loggedIn: !Object.keys(process.env).some(k => k.startsWith('CLAUDE_CODE_') || ['CLAUDE_CONFIG_DIR','ANTHROPIC_API_KEY','ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN','CLAUDECODE'].includes(k)), email:'user@example.com', subscriptionType:'max', token:'secret-token'}));\n`);
  chmodSync(executable, 0o755);
  return { home, executable };
}

describe("Claude Code 状态", () => {
  it("只返回允许展示的字段，子进程不继承其他客户端的配置或密钥", async () => {
    const { home, executable } = fakeClaude();
    const status = await claudeStatus(home, executable, {
      PATH: home,
      CLAUDE_CONFIG_DIR: "/other",
      CLAUDE_CODE_OAUTH_TOKEN: "secret",
      ANTHROPIC_API_KEY: "secret",
      ANTHROPIC_BASE_URL: "secret",
      ANTHROPIC_AUTH_TOKEN: "secret",
      CLAUDECODE: "1",
    });
    expect(status).toEqual({ found: true, executable, version: "2.1.296", loggedIn: true, email: "user@example.com", plan: "max" });
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("状态输出损坏时报告检测失败，而不是当成未登录", async () => {
    const { home, executable } = fakeClaude();
    writeFileSync(executable, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('2.1.296'); else { console.error('secret-token'); process.exitCode = 2; }\n`);
    const status = await claudeStatus(home, executable, {});
    expect(status).toMatchObject({ found: true, loggedIn: false, error: "无法检测 Claude Code 登录状态。" });
    expect(JSON.stringify(status)).not.toContain("secret-token");
  });

  it("找不到程序时明确报告不可用", async () => {
    const { home } = fakeClaude();
    expect(await claudeStatus(home, join(home, "missing"), {})).toEqual({ found: false, loggedIn: false });
  });
});
