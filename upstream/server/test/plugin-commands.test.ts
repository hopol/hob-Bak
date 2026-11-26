import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { engineDir } from "../src/config.ts";
import { binDeclaration } from "../src/plugin-config.ts";
import { PluginStore } from "../src/plugin-store.ts";
import { ensurePlaywrightCli } from "../src/playwright-cli.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

const exec = promisify(execFile);
const CAP_FIXTURE = fileURLToPath(new URL("./fixtures/cap-plugin", import.meta.url));

function seedLocalOfficial(home: string, plugins: { id: string; dir: string }[]): void {
  const root = join(home, "cache", "plugin-sources", "official");
  mkdirSync(root, { recursive: true });
  for (const plugin of plugins) {
    cpSync(plugin.dir, join(root, plugin.id), { recursive: true });
  }
  writeFileSync(
    join(root, "index.json"),
    JSON.stringify({ plugins: plugins.map((p) => ({ id: p.id, path: p.id })) }),
  );
}

describe("plugin commands (extensions.com.hob.plugins.bin & _meta['hob/command'])", () => {
  it("validates extensions.com.hob.plugins.bin declarations", () => {
    expect(binDeclaration({ extensions: { "com.hob.plugins": { bin: "bin" } } })).toBe("bin");
    expect(binDeclaration({ extensions: { "com.hob.plugins": { bin: "scripts/bin/" } } })).toBe("scripts/bin");
    expect(binDeclaration({ extensions: { "com.hob.plugins": {} } })).toBeUndefined();
    expect(() => binDeclaration({ extensions: { "com.hob.plugins": { bin: "/abs/bin" } } })).toThrow();
    expect(() => binDeclaration({ extensions: { "com.hob.plugins": { bin: "../escape" } } })).toThrow();
    expect(() => binDeclaration({ extensions: { "com.hob.plugins": { bin: "a\\b" } } })).toThrow();
  });

  it("preserves executable permissions when installing from both git and JSON sources", async () => {
    const temp = mkdtempSync(join(tmpdir(), "hob-plugin-bin-src-"));
    const homeGit = mkdtempSync(join(tmpdir(), "hob-bin-git-"));
    const homeJson = mkdtempSync(join(tmpdir(), "hob-bin-json-"));
    const server = createServer((req, res) => {
      const rel = decodeURIComponent((req.url ?? "/").replace(/^\/+/, ""));
      const file = join(temp, "json-repo", rel);
      try {
        const body = readFileSync(file);
        res.writeHead(200);
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end("not found");
      }
    });
    try {
      // 1. Local git repository with executable bin/cap-cli
      const gitRepo = join(temp, "git-repo");
      mkdirSync(join(gitRepo, "cap-plugin"), { recursive: true });
      cpSync(CAP_FIXTURE, join(gitRepo, "cap-plugin"), { recursive: true });
      chmodSync(join(gitRepo, "cap-plugin", "bin", "cap-cli"), 0o755);
      writeFileSync(join(gitRepo, "index.json"), JSON.stringify({ name: "Git Src", plugins: [{ id: "cap-plugin", path: "cap-plugin" }] }));
      const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
      await exec("git", ["init", "-q"], { cwd: gitRepo, env: gitEnv });
      await exec("git", ["add", "."], { cwd: gitRepo, env: gitEnv });
      await exec("git", ["commit", "-q", "-m", "init"], { cwd: gitRepo, env: gitEnv });

      const storeGit = new PluginStore(homeGit, undefined, gitRepo);
      await storeGit.sources.refresh("official");
      storeGit.install("cap-plugin");
      const gitBin = join(homeGit, "plugins", "cap-plugin", "bin", "cap-cli");
      expect(statSync(gitBin).mode & 0o111).toBeGreaterThan(0);

      // 2. Local JSON HTTP source (HTTP drops file modes; install must restore execute bits)
      const jsonRepo = join(temp, "json-repo");
      mkdirSync(join(jsonRepo, "cap-plugin"), { recursive: true });
      cpSync(CAP_FIXTURE, join(jsonRepo, "cap-plugin"), { recursive: true });
      chmodSync(join(jsonRepo, "cap-plugin", "bin", "cap-cli"), 0o644);
      writeFileSync(
        join(jsonRepo, "index.json"),
        JSON.stringify({
          name: "JSON Src",
          plugins: [{ id: "cap-plugin", path: "cap-plugin", files: ["plugin.json", "mcp.json", "server.mjs", "bin/cap-cli"] }],
        }),
      );
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const port = (server.address() as { port: number }).port;
      const storeJson = new PluginStore(homeJson, undefined, `http://127.0.0.1:${port}/index.json`);
      await storeJson.sources.refresh("official");
      storeJson.install("cap-plugin");
      const jsonBin = join(homeJson, "plugins", "cap-plugin", "bin", "cap-cli");
      expect(statSync(jsonBin).mode & 0o111).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(temp, { recursive: true, force: true });
      rmSync(homeGit, { recursive: true, force: true });
      rmSync(homeJson, { recursive: true, force: true });
    }
  });

  it("orders PATH as hob bin -> plugin bins (install order) -> system PATH and never leaks plugin secrets", async () => {
    const hob = makeHob();
    const extraDir = mkdtempSync(join(tmpdir(), "hob-plugin-extra-"));
    try {
      ensurePlaywrightCli(engineDir(hob.home));
      // Build a second plugin with bin + a sensitive userConfig value
      const secondDir = join(extraDir, "second-plugin");
      mkdirSync(join(secondDir, "bin"), { recursive: true });
      writeFileSync(join(secondDir, "plugin.json"), JSON.stringify({
        name: "second-plugin",
        version: "1.0.0",
        userConfig: { API_SECRET: { type: "string", sensitive: true } },
        extensions: { "com.hob.plugins": { bin: "bin" } },
      }));
      writeFileSync(join(secondDir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
      writeFileSync(join(secondDir, "bin", "second-cli"), "#!/usr/bin/env bash\necho ok\n", { mode: 0o755 });

      seedLocalOfficial(hob.home, [
        { id: "cap-plugin", dir: CAP_FIXTURE },
        { id: "second-plugin", dir: secondDir },
      ]);
      hob.runtime.plugins.store.install("cap-plugin");
      hob.runtime.plugins.store.install("second-plugin");
      hob.runtime.plugins.store.saveConfig("second-plugin", { API_SECRET: "super-secret-value-999" });

      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        name: "检查 PATH 和环境",
        instruction: "检查",
        schedules: ["0 9 * * *"],
        check: { script: "echo \"$PATH\"\nenv | grep -c super-secret-value-999 || true", then: "notify" },
      });
      const result = await hob.runtime.routines.trial(routine);
      expect(result.outcome).toBe("hit");
      const lines = (result.outcome === "hit" ? result.output : "").trim().split("\n");
      const entries = lines[0]!.split(delimiter);
      const hobBin = join(engineDir(hob.home), "bin");
      const capBin = join(hob.home, "plugins", "cap-plugin", "bin");
      const secondBin = join(hob.home, "plugins", "second-plugin", "bin");
      expect(entries[0]).toBe(hobBin);
      expect(entries[1]).toBe(capBin);
      expect(entries[2]).toBe(secondBin);
      expect(lines[1]).toBe("0");
    } finally {
      hob.runtime.scriptTools.close();
      await hob.runtime.plugins.close();
      rmSync(extraDir, { recursive: true, force: true });
      hob.close();
    }
  });

  it("exposes plugin commands & hob/command tools to private chat, group chat, jobs, and check scripts; blocks non-command hidden tools; respects disable/unassign and revokes credentials", async () => {
    const hob = makeHob();
    try {
      seedLocalOfficial(hob.home, [{ id: "cap-plugin", dir: CAP_FIXTURE }]);
      hob.runtime.plugins.store.install("cap-plugin");
      await hob.runtime.plugins.reload("cap-plugin");

      const outDir = join(hob.home, "cmd-outputs");
      mkdirSync(outDir, { recursive: true });

      // --- 1. Routine check script ---
      const capturePath = join(outDir, "check-cred.json");
      const routine = hob.runtime.routines.create({
        assistantId: "hob",
        name: "命令检查",
        instruction: "检查",
        schedules: ["0 9 * * *"],
        check: {
          script: [
            `node -e 'require("node:fs").writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ url: process.env.HOB_TOOLS_URL, token: process.env.HOB_TOOLS_TOKEN }))'`,
            "TOKEN=$(cap-cli token)",
            "INTERNAL_ERR=$(cap-cli internal 2>&1 || true)",
            "LIST=$(node -e 'tools.$list().then(l => console.log(l.map(x => x.name).join(\",\")))')",
            "echo \"TOKEN=$TOKEN\"",
            "echo \"INTERNAL=$INTERNAL_ERR\"",
            "echo \"LIST=$LIST\"",
          ].join("\n"),
          then: "notify",
        },
      });
      const checkRes = await hob.runtime.routines.trial(routine);
      expect(checkRes.outcome).toBe("hit");
      const checkOut = checkRes.outcome === "hit" ? checkRes.output : "";
      expect(checkOut).toContain("TOKEN=fixture-token-267");
      expect(checkOut).toContain("INTERNAL=工具不可用：cap-plugin_internal_secret");
      const listLine = checkOut.split("\n").find((line) => line.startsWith("LIST=")) ?? "";
      expect(listLine).toContain("cap-plugin_ping");
      expect(listLine).not.toContain("cap-plugin_command_token");
      expect(listLine).not.toContain("cap-plugin_internal_secret");

      // Credential must be revoked right after check finishes
      const captured = JSON.parse(readFileSync(capturePath, "utf8")) as { url: string; token: string };
      const replay = await fetch(captured.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${captured.token}` },
        body: JSON.stringify({ name: "cap-plugin_command_token", args: {} }),
      });
      expect(replay.status).toBe(401);

      // --- 2. Private chat (router bash) ---
      const chatOut = join(outDir, "chat.txt");
      const chatCred = join(outDir, "chat-cred.json");
      hob.faux.setResponses([
        call("bash", {
          command: `cap-cli token > ${JSON.stringify(chatOut)} && node -e 'require("node:fs").writeFileSync(${JSON.stringify(chatCred)}, JSON.stringify({ url: process.env.HOB_TOOLS_URL, token: process.env.HOB_TOOLS_TOKEN }))'`,
        }),
        text("单聊已拿到"),
      ]);
      await hob.runtime.router.send("hob", { text: "测试单聊命令" });
      await waitFor(() => existsSync(chatOut) && existsSync(chatCred) && !hob.runtime.router.isBusy("hob"));
      expect(readFileSync(chatOut, "utf8").trim()).toBe("fixture-token-267");

      // Credential revoked after bash command ends
      const chatCaptured = JSON.parse(readFileSync(chatCred, "utf8")) as { url: string; token: string };
      const chatReplay = await fetch(chatCaptured.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${chatCaptured.token}` },
        body: JSON.stringify({ name: "cap-plugin_command_token", args: {} }),
      });
      expect(chatReplay.status).toBe(401);

      // --- 3. Group chat (group member bash) ---
      const group = hob.runtime.groups.create({ name: "测试群", purpose: "测插件命令", ownerId: "hob", members: ["hob"] });
      const groupOut = join(outDir, "group.txt");
      hob.faux.setResponses([
        call("bash", { command: `cap-cli token > ${JSON.stringify(groupOut)}` }),
        text("群里已拿到"),
      ]);
      await hob.runtime.groups.send(group.id, { text: "测试群命令" });
      await waitFor(() => existsSync(groupOut) && !hob.runtime.router.isBusy("hob", group.id));
      expect(readFileSync(groupOut, "utf8").trim()).toBe("fixture-token-267");

      // --- 4. Background job (worker bash) ---
      const jobOut = join(outDir, "job.txt");
      hob.faux.setResponses([
        call("bash", { command: `cap-cli token > ${JSON.stringify(jobOut)}` }),
        call("report", { outcome: "done", result: "任务完成" }),
        text("收到任务结果"),
      ]);
      const job = await hob.runtime.jobs.start("hob", { title: "测试任务命令", instruction: "跑 cap-cli" });
      await waitFor(() => hob.runtime.store.job(job.id)?.status === "done" && !hob.runtime.router.isBusy("hob"));
      expect(readFileSync(jobOut, "utf8").trim()).toBe("fixture-token-267");

      // --- 5. Unassign from assistant -> next command cannot find cap-cli ---
      hob.runtime.plugins.store.patch("cap-plugin", { assistants: ["other-assistant"] });
      const missingUnassigned = hob.runtime.routines.create({
        assistantId: "hob",
        name: "取消分配后检查",
        instruction: "检查",
        schedules: ["0 9 * * *"],
        check: { script: "command -v cap-cli && echo FOUND || echo MISSING", then: "notify" },
      });
      const resUnassigned = await hob.runtime.routines.trial(missingUnassigned);
      expect(resUnassigned.outcome).toBe("hit");
      expect(resUnassigned.outcome === "hit" ? resUnassigned.output : "").toBe("MISSING");

      // Re-assign, then disable plugin -> next command in existing or new session cannot find cap-cli
      hob.runtime.plugins.store.patch("cap-plugin", { assistants: null });
      hob.runtime.plugins.store.patch("cap-plugin", { enabled: false });
      await hob.runtime.plugins.reload("cap-plugin");

      const disabledOut = join(outDir, "disabled.txt");
      hob.faux.setResponses([
        call("bash", { command: `(command -v cap-cli && echo FOUND || echo MISSING) > ${JSON.stringify(disabledOut)}` }),
        text("已检查"),
      ]);
      await hob.runtime.router.send("hob", { text: "停用后再查" });
      await waitFor(() => existsSync(disabledOut) && !hob.runtime.router.isBusy("hob"));
      expect(readFileSync(disabledOut, "utf8").trim()).toBe("MISSING");
    } finally {
      hob.runtime.scriptTools.close();
      await hob.runtime.plugins.close();
      hob.close();
    }
  });
});
