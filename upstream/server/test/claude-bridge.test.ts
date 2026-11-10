import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeHob } from "./helpers.ts";

describe("Claude 订阅模型", () => {
  it("只在启用且本机已登录时注册桥的模型，停用后移除", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const executable = join(hob.home, "claude");
      writeFileSync(executable, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('2.1.296'); else console.log(JSON.stringify({loggedIn:true, subscriptionType:'max'}));\n`);
      chmodSync(executable, 0o755);
      expect((await hob.runtime.models.get()).some((m) => m.provider === "claude-bridge")).toBe(false);
      expect(existsSync(join(hob.home, "system", "engine", "claude-bridge.json"))).toBe(false);
      hob.runtime.settings.setClaude(hob.runtime.settings.get().revision, { enabled: true, plan: "max", executable });
      await hob.runtime.providers.apply();
      expect((await hob.runtime.models.get()).some((m) => m.provider === "claude-bridge" && m.id.includes("sonnet"))).toBe(true);
      const config = JSON.parse(readFileSync(join(hob.home, "system", "engine", "claude-bridge.json"), "utf8"));
      expect(config).toEqual({ provider: { plan: "max", strictMcpConfig: true, autoMemoryEnabled: false, pathToClaudeCodeExecutable: executable }, askClaude: { enabled: false } });
      mkdirSync(join(hob.home, ".pi"));
      writeFileSync(join(hob.home, ".pi", "claude-bridge.json"), JSON.stringify({ provider: { strictMcpConfig: false }, askClaude: { enabled: true } }));
      const path = new URL("../../vendor/claude-bridge/src/config.ts", import.meta.url).href;
      const bridgeConfig = await import(path);
      expect(bridgeConfig.loadConfig(hob.home)).toEqual(config);
      hob.runtime.settings.setClaude(hob.runtime.settings.get().revision, { enabled: false, plan: "max", executable });
      await hob.runtime.providers.apply();
      expect((await hob.runtime.models.get()).some((m) => m.provider === "claude-bridge")).toBe(false);
    } finally { hob.close(); }
  });

  it("回放历史不发历史图片，只留文字占位；当前消息纯文字时整条没有 image 块", async () => {
    const hob = makeHob({}, { memory: "off" });
    vi.stubEnv("HOME", hob.home);
    try {
      const path = new URL("../../vendor/claude-bridge/src/index.ts", import.meta.url).href;
      const bridge = await import(path);
      bridge.__test.resetSharedSession();
      const img = (data: string) => ({ type: "image", data, mimeType: "image/png" });
      const messages = [
        { role: "user", content: [{ type: "text", text: "第一句" }, img("aGkx"), img("aGky")], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "第一答" }], timestamp: 2 },
        { role: "user", content: [{ type: "text", text: "第二句" }, img("aGkz")], timestamp: 3 },
        { role: "assistant", content: [{ type: "text", text: "第二答" }], timestamp: 4 },
        { role: "user", content: "当前这句没有图", timestamp: 5 },
      ];
      const sync = bridge.__test.syncSharedSession(messages, hob.home, undefined, "sonnet", "test-session");
      expect(sync.sessionId).toBeNull();
      expect(sync.replay).toEqual(messages.slice(0, 4));
      const replay = bridge.__test.replayBlocks(sync.replay);
      const current = bridge.__test.extractUserPromptBlocks(messages) ?? [{ type: "text", text: "" }];
      const all = [...replay, ...current];
      // 整条（历史 + 当前）没有任何 image 块，历史图片的 base64 也不在里面
      expect(all.filter((block: { type: string }) => block.type === "image")).toHaveLength(0);
      expect(JSON.stringify(all)).not.toContain("aGk");
      // 三张历史图片 → 三处占位
      const joined = all.map((block: { type: string; text?: string }) => (block.type === "text" ? block.text : "")).join("\n");
      expect(joined.split("[图片：这条历史消息当时带了一张图片，不在当前消息里]").length - 1).toBe(3);
      expect(joined).toContain("第一句");
      expect(joined).toContain("第二答");
      expect(existsSync(join(hob.home, ".claude"))).toBe(false);
    } finally { vi.unstubAllEnvs(); hob.close(); }
  });

  it("当前消息带图时，唯一的 image 块在「以下是当前消息：」之后", async () => {
    const hob = makeHob({}, { memory: "off" });
    vi.stubEnv("HOME", hob.home);
    try {
      const path = new URL("../../vendor/claude-bridge/src/index.ts", import.meta.url).href;
      const bridge = await import(path);
      bridge.__test.resetSharedSession();
      const messages = [
        { role: "user", content: [{ type: "text", text: "第一句" }, { type: "image", data: "b2xk", mimeType: "image/png" }], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "第一答" }], timestamp: 2 },
        { role: "user", content: [{ type: "text", text: "看这张" }, { type: "image", data: "Y3Vy", mimeType: "image/png" }], timestamp: 3 },
      ];
      const sync = bridge.__test.syncSharedSession(messages, hob.home, undefined, "sonnet", "test-session");
      expect(sync.sessionId).toBeNull();
      const replay = bridge.__test.replayBlocks(sync.replay);
      const current = bridge.__test.extractUserPromptBlocks(messages);
      expect(current).not.toBeNull();
      const all = [...replay, ...current!];
      const imageIdxs = all.map((block: { type: string }, i: number) => (block.type === "image" ? i : -1)).filter((i: number) => i >= 0);
      expect(imageIdxs).toHaveLength(1);
      const markerIdx = all.findIndex((block: { type: string; text?: string }) => block.type === "text" && block.text === "以下是当前消息：");
      expect(markerIdx).toBeGreaterThan(-1);
      expect(imageIdxs[0]).toBeGreaterThan(markerIdx);
      // 这张图就是当前那张，不是历史那张
      const image = all[imageIdxs[0]] as { type: "image"; source: { data: string } };
      expect(image.source.data).toBe("Y3Vy");
      expect(JSON.stringify(all)).not.toContain("b2xk");
    } finally { vi.unstubAllEnvs(); hob.close(); }
  });

  it("未登录时即使开启也不显示模型", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const executable = join(hob.home, "claude");
      writeFileSync(executable, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('2.1.296'); else { console.log(JSON.stringify({loggedIn:false, token:'do-not-expose'})); process.exitCode=1; }\n`);
      chmodSync(executable, 0o755);
      hob.runtime.settings.setClaude(hob.runtime.settings.get().revision, { enabled: true, plan: "pro", executable });
      await hob.runtime.providers.apply();
      expect((await hob.runtime.models.get()).some((m) => m.provider === "claude-bridge")).toBe(false);
    } finally { hob.close(); }
  });

  it("找不到程序时即使开启也不显示模型", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.settings.setClaude(hob.runtime.settings.get().revision, { enabled: true, plan: "pro", executable: join(hob.home, "missing") });
      await hob.runtime.providers.apply();
      expect((await hob.runtime.models.get()).some((m) => m.provider === "claude-bridge")).toBe(false);
    } finally { hob.close(); }
  });
});
