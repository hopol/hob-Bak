import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PluginHost } from "../src/plugin-host.ts";

it("shows why a local service exited on start", async () => {
  const home = mkdtempSync(join(tmpdir(), "hob-plugin-stderr-"));
  const host = new PluginHost(home);
  try {
    host.store.addCustom("sample", { command: process.execPath, args: ["-e", "console.error('登录失败：密钥不对'); process.exit(1)"] });
    await host.start();
    const state = host.states("sample")[0];
    expect(state.status).toBe("error");
    expect(state.error).toContain("登录失败：密钥不对");
  } finally {
    await host.close();
    rmSync(home, { recursive: true, force: true });
  }
});
