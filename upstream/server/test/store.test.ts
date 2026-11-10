import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";
import { makeHob } from "./helpers.ts";
import { cronToChinese } from "../src/cron-text.ts";
import { createApp } from "../src/http.ts";

describe("store", () => {
  it("原子写和读回", () => {
    const hob = makeHob();
    try {
      const store = hob.runtime.store;
      const hobAssistant = store.assistant("hob")!;
      store.saveAssistant({ ...hobAssistant, name: "Hob2" });
      expect(new Store(hob.home).assistant("hob")!.name).toBe("Hob2");
      // 没有残留的临时文件
      const dir = join(hob.home, "assistants", "hob");
      expect(readFileSync(join(dir, "profile.json"), "utf8")).toContain("Hob2");
    } finally {
      hob.close();
    }
  });

  it("委派记录可落盘、读取和更新", () => {
    const hob = makeHob();
    try {
      const record = {
        id: "delegation-1", from: "hob" as const, to: "server", text: "检查服务器",
        createdAt: new Date().toISOString(), status: "running" as const, jobIds: ["t-1"],
      };
      hob.runtime.store.saveDelegation(record);
      const reopened = new Store(hob.home);
      expect(reopened.delegation(record.id)).toEqual(record);
      reopened.saveDelegation({ ...record, status: "done", reply: "完成", endedAt: new Date().toISOString() });
      expect(hob.runtime.store.delegations()).toHaveLength(1);
      expect(hob.runtime.store.delegation(record.id)).toMatchObject({ status: "done", reply: "完成" });
    } finally {
      hob.close();
    }
  });

  it("文件坏了退回默认值，不炸", () => {
    const hob = makeHob();
    try {
      writeFileSync(join(hob.home, "assistants", "hob", "rules.json"), "{坏掉的");
      expect(hob.runtime.store.rules("hob")).toEqual([]);
    } finally {
      hob.close();
    }
  });

  it("首次启动只建一个主助手", () => {
    const hob = makeHob();
    try {
      const again = hob.runtime.store.ensurePrimary();
      expect(again.id).toBe("hob");
      expect(hob.runtime.store.assistants()).toHaveLength(1);
      expect(hob.runtime.store.assistant("hob")).toMatchObject({ primary: true, pinned: true, sprite: "hob" });
    } finally {
      hob.close();
    }
  });
});

describe("cron 中文", () => {
  it("常见几种", () => {
    expect(cronToChinese("0 9 * * *")).toBe("每天 09:00");
    expect(cronToChinese("30 17 * * 5")).toBe("每周五 17:30");
    expect(cronToChinese("0 9 L * *")).toBe("每月最后一天 09:00");
    expect(cronToChinese("0 9 1 * *")).toBe("每月 1 日 09:00");
    expect(cronToChinese("*/15 * * * *")).toBe("每 15 分钟");
    expect(cronToChinese("乱七八糟")).toBe("乱七八糟");
  });
});

describe("静态文件", () => {
  it("根目录的 apple-touch-icon 各种名字都给同一张图；带扩展名找不到是 404；其余路径回网页", async () => {
    const hob = makeHob();
    try {
      const webDir = join(hob.home, "web");
      mkdirSync(join(webDir, "icons"), { recursive: true });
      writeFileSync(join(webDir, "index.html"), "<!doctype html><title>Hob</title>");
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      writeFileSync(join(webDir, "icons", "apple-touch-icon-180.png"), png);
      const app = createApp(hob.runtime, { home: hob.home, webDir });

      for (const path of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png", "/apple-touch-icon-180x180.png"]) {
        const res = await app.request(path);
        expect(res.status, path).toBe(200);
        expect(res.headers.get("content-type")).toBe("image/png");
        expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
      }
      expect((await app.request("/icons/apple-touch-icon-180.png?v=3")).status).toBe(200);
      expect((await app.request("/favicon.ico")).status).toBe(404);
      const page = await app.request("/some/page");
      expect(page.status).toBe(200);
      expect(await page.text()).toContain("<title>Hob</title>");
    } finally {
      hob.close();
    }
  });
});

describe("登录和接口鉴权", () => {
  it("密码错了 401，对了发 cookie，没 cookie 401", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home, webDir: join(hob.home, "no-web") });

      const bad = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "nope" }),
      });
      expect(bad.status).toBe(401);
      expect(await bad.json()).toEqual({ error: "密码不正确" });

      const good = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      expect(good.status).toBe(200);
      const cookie = (good.headers.get("set-cookie") ?? "").split(";")[0];
      expect(cookie).toMatch(/^hob=/);
      expect(good.headers.get("set-cookie")).toContain("HttpOnly");

      const noCookie = await app.request("/api/bootstrap");
      expect(noCookie.status).toBe(401);

      const bootstrap = await app.request("/api/bootstrap", { headers: { cookie } });
      expect(bootstrap.status).toBe(200);
      const body = (await bootstrap.json()) as { assistants: { id: string; primary: boolean }[] };
      expect(body.assistants.map((item) => item.id)).toEqual(["hob"]);
      expect(body.assistants[0].primary).toBe(true);
    } finally {
      hob.close();
    }
  });
});

describe("配置", () => {
  it("密码为空时拒绝启动并说清原因；明文密码转成哈希写回", async () => {
    const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { loadConfig } = await import("../src/config.ts");
    const { verifyPassword } = await import("../src/password.ts");
    const home = mkdtempSync(join(tmpdir(), "hob-cfg-"));
    try {
      expect(() => loadConfig(home, {} as NodeJS.ProcessEnv)).toThrow(/密码/);
      const config = loadConfig(home, { HOB_PASSWORD: "abc" } as NodeJS.ProcessEnv);
      expect(verifyPassword(config.passwordHash, "abc")).toBe(true);
      expect(config.cookieSecret.length).toBeGreaterThan(20);
      expect(loadConfig(home, {} as NodeJS.ProcessEnv).cookieSecret).toBe(config.cookieSecret);

      // 文件里存的是哈希，没有明文
      const raw = JSON.parse(readFileSync(join(home, "system", "config.json"), "utf8")) as Record<string, unknown>;
      expect(raw.password).toBeUndefined();
      expect(String(raw.passwordHash)).toMatch(/^scrypt\$/);
      // 不再需要明文或环境变量：哈希验得过去
      expect(verifyPassword(String(raw.passwordHash), "abc")).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("host 默认只听本机，HOB_HOST 能覆盖", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { loadConfig } = await import("../src/config.ts");
    const home = mkdtempSync(join(tmpdir(), "hob-cfg-"));
    try {
      expect(loadConfig(home, { HOB_PASSWORD: "abc" } as NodeJS.ProcessEnv).host).toBe("127.0.0.1");
      expect(loadConfig(home, { HOB_PASSWORD: "abc", HOB_HOST: "0.0.0.0" } as NodeJS.ProcessEnv).host).toBe(
        "0.0.0.0",
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("设置里的时区默认系统时区，写错时拒绝启动", async () => {
    const { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { SettingsStore } = await import("../src/settings.ts");
    const home = mkdtempSync(join(tmpdir(), "hob-set-"));
    try {
      const system = Intl.DateTimeFormat().resolvedOptions().timeZone;
      expect(new SettingsStore(home).settings.general.timezone).toBe(system);
      const file = join(home, "system", "settings.json");
      const raw = JSON.parse(readFileSync(file, "utf8")) as { revision: number; settings: { general: { timezone: string } } };
      raw.settings.general.timezone = "Asia/ShangHaii";
      writeFileSync(file, JSON.stringify(raw));
      expect(() => new SettingsStore(home).get()).toThrow(/时区不合法/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("模型：没有服务商时名单是空的；config.json 里的旧字段搬走并从文件里删掉", async () => {
    const { mkdtempSync, rmSync, readFileSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { loadConfig } = await import("../src/config.ts");
    const { readLegacyModels, SettingsStore } = await import("../src/settings.ts");
    const home = mkdtempSync(join(tmpdir(), "hob-cfg-"));
    const legacyHome = mkdtempSync(join(tmpdir(), "hob-cfg-"));
    try {
      // 一个服务商都没配：名单是空的，不拿别的工具的默认模型来凑
      const plain = new SettingsStore(home).settings.models;
      expect(plain.roster).toEqual([]);
      expect(plain.conversation.ref).toBe("");
      expect(plain.work.ref).toBe("");

      // 旧 config.json 里的 routerModel/workerModel 搬进设置，搬完从 config.json 删掉
      mkdirSync(join(legacyHome, "system"), { recursive: true });
      writeFileSync(
        join(legacyHome, "system", "config.json"),
        JSON.stringify({ password: "abc", routerModel: "x/fast", routerThinking: "low", workerModel: "x/smart", workerThinking: "high" }),
      );
      const legacy = readLegacyModels(legacyHome);
      loadConfig(legacyHome, {} as NodeJS.ProcessEnv);
      const raw = JSON.parse(readFileSync(join(legacyHome, "system", "config.json"), "utf8")) as Record<string, unknown>;
      expect(raw.routerModel).toBeUndefined();
      expect(raw.workerModel).toBeUndefined();

      const store = new SettingsStore(legacyHome, { legacyModels: legacy });
      const moved = store.settings.models;
      expect(moved.conversation).toEqual({ ref: "x/fast", thinking: "low" });
      expect(moved.work).toEqual({ ref: "x/smart", thinking: "high" });
      expect(moved.roster.map((entry) => entry.ref)).toEqual(["x/fast", "x/smart"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(legacyHome, { recursive: true, force: true });
    }
  });

  it("已有 settings.json 但没有 models 节：搬来的模型马上落盘，重启后还在", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { SettingsStore } = await import("../src/settings.ts");
    const home = mkdtempSync(join(tmpdir(), "hob-set-"));
    try {
      mkdirSync(join(home, "system"), { recursive: true });
      writeFileSync(
        join(home, "system", "settings.json"),
        JSON.stringify({ revision: 2, settings: { general: { timezone: "Europe/Berlin" } } }),
      );
      new SettingsStore(home, { legacyModels: { conversation: "x/fast", work: "x/smart" } });
      // 第二次启动：config.json 里的旧键已经删了，settings.json 里的还在
      const again = new SettingsStore(home).get();
      expect(again.revision).toBe(2);
      expect(again.settings.general.timezone).toBe("Europe/Berlin");
      expect(again.settings.models.conversation.ref).toBe("x/fast");
      expect(again.settings.models.work.ref).toBe("x/smart");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("旧 config.json 里的 theme/timezone/maxJobs/routerStallMs 搬到 settings.json", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { SettingsStore } = await import("../src/settings.ts");
    const home = mkdtempSync(join(tmpdir(), "hob-set-"));
    try {
      mkdirSync(join(home, "system"), { recursive: true });
      writeFileSync(
        join(home, "system", "config.json"),
        JSON.stringify({ theme: "dark", timezone: "Europe/Berlin", maxJobs: 4, routerStallMs: 120_000 }),
      );
      const settings = new SettingsStore(home).settings;
      expect(settings.general.theme).toBe("dark");
      expect(settings.general.timezone).toBe("Europe/Berlin");
      expect(settings.work.maxJobs).toBe(4);
      expect(settings.work.routerStallMinutes).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("定时时区", () => {
  it("cron 按设置里的时区算，不看服务器系统时区", async () => {
    const { RoutineScheduler } = await import("../src/routines.ts");
    const hob = makeHob();
    try {
      const routines = new RoutineScheduler(hob.runtime);
      const routine = routines.create({
        assistantId: "hob",
        name: "早报",
        instruction: "给我早报",
        schedules: ["0 9 * * *"],
      });
      // 北京时间 9 点 = UTC 1 点
      expect(routines.nextRuns(routine.id)[0]).toMatch(/T01:00:00\.000Z$/);
      routines.stop();
    } finally {
      hob.close();
    }
  });
});
