import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { serveStatic } from "@hono/node-server/serve-static";
import type {
  AboutInfo,
  ClaudeCodeSettings,
  Assistant,
  HobEvent,
  ImageKeyView,
  ImageSettingsSaved,
  ImageTestResult,
  AnswerApprovalBody,
  FileMeta,
  JobStatus,
  ModelThinkingPatch,
  ModelThinkingSaved,
  ModelsView,
  PushSubscriptionJson,
  RoutineCheck,
  SettingsPatch,
  UsagePricePatch,
  UsagePriceSaved,
} from "../../shared/types.ts";
import { parseSprite } from "../../shared/sprites.ts";
import { answerApproval, archiveAssistant, createFromDraft, dismissDraft } from "./actions.ts";
import { setPassword, assistantFilesDir, cacheDir } from "./config.ts";
import { newId } from "./ids.ts";
import { claudeStatus } from "./claude-status.ts";
import { checkDesktopUrl } from "./desktop.ts";
import { desktopProfile, openDesktopBrowser } from "./desktop-tools.ts";
import { listJobFiles, lookupFile, MAX_TEXT_BYTES } from "./files.ts";
import { thumbnail } from "./thumbs.ts";
import { localLoreHome, readLocalLore, readLocalLoreConnection } from "./imports.ts";
import { importMcpServers, listMcpImports, mcpView, patchMcpServer, removeMcpServer, saveMcpServer, testMcpServer } from "./mcp.ts";
import type { McpServerPatch, McpServerSave } from "../../shared/mcp.ts";
import { checkImageSettings, generateImage, imageConfigured, imageKey, IMAGE_KEY_SECRET } from "./image.ts";
import { checkEmbeddingSettings, embed, embeddingKey, embeddingModel, EMBEDDING_KEY_SECRET } from "./embedding.ts";
import { checkAssistantModels, checkModelsPatch } from "./models.ts";
import { saveLoreConnection, testLoreConnection } from "./memory.ts";
import { verifyPassword } from "./password.ts";
import type { HobRuntime } from "./runtime.ts";
import { readSecrets, writeSecret } from "./secrets.ts";
import { SEARCH_PROVIDERS } from "../../shared/search.ts";
import { WebSearch } from "./search.ts";
import { clampDuty } from "./text.ts";
import { deleteOwnSkill, importSkills, listImportSkills, skillViews } from "./skills.ts";
import { listAssistantSkills, rollbackAssistantSkill, setAssistantSkillEnabled } from "./assistant-skills.ts";
import { deleteSkill } from "./delete-skill.ts";
import type { SkillImportSource } from "../../shared/skills.ts";

const COOKIE = "hob";
const THIRTY_DAYS = 30 * 24 * 3600;
const JOB_STATUSES: JobStatus[] = ["queued", "running", "waiting", "done", "stuck", "failed", "stopped"];

function signature(secret: string, token: string): string {
  return createHmac("sha256", secret).update(token).digest("hex");
}

function issueCookie(config: HobRuntime["config"]): string {
  const token = randomBytes(24).toString("hex");
  return `${token}.${signature(config.cookieSecret, token)}`;
}

export function validCookie(config: HobRuntime["config"], value: string | undefined): boolean {
  if (!value) return false;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;
  const token = value.slice(0, dot);
  const given = value.slice(dot + 1);
  const expected = signature(config.cookieSecret, token);
  if (given.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
  } catch {
    return false;
  }
}

export function createApp(runtime: HobRuntime, options: { webDir?: string; home: string }): Hono {
  const { store, bus, router, jobs, routines, config } = runtime;  const app = new Hono();
  // ponytail: 每次取文件都扫一遍 job.json（几十上百个），慢了再缓存
  const workDirs = () => store.jobs().flatMap((job) => (job.cwd ? [job.cwd] : []));

  app.use("/api/*", async (c, next) => {
    if (c.req.path === "/api/login") return next();
    if (!validCookie(config, getCookie(c, COOKIE))) return c.json({ error: "未登录" }, 401);
    return next();
  });

  app.post("/api/login", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { password?: string };
    if (!verifyPassword(runtime.config.passwordHash, body.password ?? "")) {
      return c.json({ error: "密码不正确" }, 401);
    }
    setCookie(c, COOKIE, issueCookie(config), {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: THIRTY_DAYS,
    });
    return c.json({ ok: true });
  });

  app.post("/api/logout", (c) => {
    setCookie(c, COOKIE, "", { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 0 });
    return c.json({ ok: true });
  });

  app.get("/api/me", (c) => c.json({ ok: true }));

  app.get("/api/bootstrap", (c) => c.json(router.bootstrap()));

  app.get("/api/rules", (c) => c.json({ rules: store.globalRules() }));
  app.put("/api/rules", async (c) => {
    const body = await c.req.json().catch(() => null) as { rules?: unknown } | null;
    if (!Array.isArray(body?.rules) || body.rules.some((rule) => !rule || typeof rule.text !== "string" || !rule.text.trim() || (rule.mode !== "ask" && rule.mode !== "allow") || (rule.id !== undefined && (typeof rule.id !== "string" || !rule.id.trim())))) {
      return c.json({ error: "规则格式无效，文字不能为空" }, 400);
    }
    const changedAt = new Date().toISOString();
    const existing = new Map(store.globalRules().map((rule) => [rule.id, rule]));
    const rules = body.rules.map((rule) => {
      const previous = existing.get(rule.id);
      const text = rule.text.trim();
      return { id: rule.id ?? newId("r-"), text, mode: rule.mode as "ask" | "allow", changedAt: previous && previous.text === text && previous.mode === rule.mode ? previous.changedAt : changedAt };
    });
    store.saveGlobalRules(rules);
    bus.emit({ type: "rules" });
    return c.json({ rules });
  });

  // 设置页：整份设置（带 revision）与按节合并的写入（revision 不对 → 409）
  app.get("/api/settings", (c) => c.json(runtime.settings.get()));

  app.put("/api/settings", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { revision?: number; patch?: SettingsPatch };
    if (typeof body.revision !== "number") return c.json({ error: "缺 revision" }, 400);
    const patch = body.patch ?? {};
    // VAPID subject 要用它，写得不像邮箱就直接拒
    const email = patch.push?.email;
    if (typeof email === "string" && email.trim() && !/^[^\s@]+@[^\s@]+$/.test(email.trim())) {
      return c.json({ error: "邮箱格式无效" }, 400);
    }
    // 名单和角色要对照当前可用的模型校验（不可用的模型不能新加进名单）
    try {
      await checkModelsPatch(patch, runtime.settings.settings.models, runtime.models);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    let next;
    try {
      next = runtime.settings.patch(body.revision, patch);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (!next) return c.json({ error: "设置已在别处修改，已刷新" }, 409);
    // 改了设置立即生效：并发、无响应判定、定时时区都不需要重启
    if (patch.models || patch.general?.showPage !== undefined) router.releaseSessions();
    runtime.jobs.pump();
    runtime.routines.reload();
    return c.json(next);
  });

  app.get("/api/desktop", (c) => c.json(runtime.desktop.view()));
  app.put("/api/desktop", async (c) => {
    if (runtime.desktop.deployed) return c.json({ error: "云桌面由部署配置，不能在此修改。" }, 403);
    const body = await c.req.json().catch(() => ({})) as { revision?: unknown; url?: unknown; enabled?: unknown; token?: unknown };
    if (typeof body.revision !== "number" || typeof body.url !== "string" || typeof body.enabled !== "boolean" || (body.token !== undefined && typeof body.token !== "string")) return c.json({ error: "云桌面配置无效。" }, 400);
    try {
      const url = checkDesktopUrl(body.url);
      const saved = runtime.settings.setDesktop(body.revision, { url, enabled: body.enabled });
      if (!saved) return c.json({ error: "设置已在别处修改，已刷新" }, 409);
      if (body.token !== undefined) writeSecret(options.home, "desktop:token", body.token);
      router.releaseSessions();
      runtime.desktopEvents.restart();
      return c.json(runtime.desktop.view());
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.put("/api/desktop/public", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { revision?: unknown; assistants?: unknown };
    if (typeof body.revision !== "number" || !Array.isArray(body.assistants) || !body.assistants.every((id) => typeof id === "string" && !!runtime.store.assistant(id))) return c.json({ error: "助手列表无效。" }, 400);
    const current = runtime.settings.settings.desktop ?? { url: "", enabled: false };
    const saved = runtime.settings.setDesktop(body.revision, { ...current, publicAssistants: [...new Set(body.assistants)] });
    if (!saved) return c.json({ error: "设置已在别处修改，已刷新" }, 409);
    router.releaseSessions();
    return c.json(runtime.desktop.view());
  });
  const validScreen = (id: string) => id === "public" || runtime.store.assistants().some((assistant) => desktopProfile(assistant.id) === id);
  app.get("/api/desktop/screens", (c) => c.json({ screens: runtime.desktopEvents.screens, profiles: Object.fromEntries(runtime.store.assistants().map((assistant) => [assistant.id, desktopProfile(assistant.id)])) }));
  app.post("/api/desktop/screens/:id/start", async (c) => {
    const id = c.req.param("id");
    if (!/^[a-z0-9-]{1,64}$/.test(id)) return c.json({ error: "屏幕 id 无效。" }, 400);
    if (!validScreen(id)) return c.json({ error: "屏幕不存在。" }, 404);
    try { await runtime.desktop.request(`/api/screens/${id}/start`, { method: "POST" }); return c.json({ ok: true }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 502); }
  });
  app.get("/api/desktop/control", (c) => {
    const screen = c.req.query("screen") ?? "hob";
    if (!validScreen(screen)) return c.json({ error: "屏幕不存在。" }, 404);
    return c.json(runtime.desktopControl.state(c.req.query("client") ?? "", screen));
  });
  app.post("/api/desktop/control", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { client?: string; action?: string; screen?: string };
    const screen = typeof body.screen === "string" ? body.screen : "hob";
    if (!validScreen(screen)) return c.json({ error: "屏幕不存在。" }, 404);
    try {
      if (body.action === "take") runtime.desktopControl.take(body.client ?? "", screen);
      else if (body.action === "release") runtime.desktopControl.release(body.client ?? "", screen);
      else throw new Error("操作无效。");
      return c.json(runtime.desktopControl.state(body.client ?? "", screen));
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });
  app.post("/api/desktop/paste", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { client?: unknown; screen?: unknown; text?: unknown };
    if (typeof body.client !== "string" || typeof body.screen !== "string" || !validScreen(body.screen) || typeof body.text !== "string" || !body.text || body.text.includes("\0") || new TextEncoder().encode(body.text).length > 512 * 1024) return c.json({ error: "文字或屏幕无效。" }, 400);
    if (!runtime.desktopControl.state(body.client, body.screen).mine) return c.json({ error: "当前设备没有接管云桌面。" }, 403);
    try {
      await runtime.desktop.request(`/api/screens/${body.screen}/paste`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: body.text }) });
      return c.json({ ok: true });
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 502); }
  });
  // 接管后要自己登录网站：在云桌面里打开某个助手的浏览器（每个助手的登录状态分开）
  app.post("/api/desktop/browser", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { assistantId?: unknown };
    const id = typeof body.assistantId === "string" ? body.assistantId : "";
    if (!runtime.store.assistant(id)) return c.json({ error: "助手不存在" }, 404);
    try { await openDesktopBrowser(runtime, id); return c.json({ ok: true }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 502); }
  });
  app.post("/api/desktop/test", async (c) => {
    try { return c.json({ ok: true, health: await (await runtime.desktop.request("/api/health")).json() }); }
    catch (error) { return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/skills", async (c) => {
    const memory = runtime.settings.memory();
    let loreError: string | undefined;
    try { if (memory.provider === "lore" && !runtime.pi.loreSkillPaths.length) await runtime.pi.discoverLoreSkills(); }
    catch (error) { loreError = error instanceof Error ? error.message : String(error); }
    return c.json({ skills: skillViews(options.home, runtime.settings.settings.skills?.disabled ?? [], memory.provider === "lore" ? runtime.pi.loreSkillPaths : []), loreActive: memory.provider === "lore", loreUrl: memory.lore.baseUrl, loreError });
  });
  app.get("/api/skills/import/:source", (c) => {
    try { return c.json(listImportSkills(options.home, c.req.param("source") as SkillImportSource)); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.post("/api/skills/import/:source", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { ids?: unknown; overwrite?: unknown };
    if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string") || typeof body.overwrite !== "boolean") return c.json({ error: "导入参数无效" }, 400);
    try { return c.json(importSkills(options.home, c.req.param("source") as SkillImportSource, body.ids, body.overwrite)); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.delete("/api/skills/:id", (c) => {
    try { deleteOwnSkill(options.home, c.req.param("id")); return c.json({ ok: true }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });

  // 设置 → MCP：列表（密钥不回传）。文件坏了返回错误，不当成空列表
  app.get("/api/mcp", (c) => {
    try {
      return c.json(mcpView(options.home));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  });

  // 新建或改一个服务（名称在地址里；env / headers 逐键保留、替换、删除）
  app.put("/api/mcp/:name", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as McpServerSave;
    try {
      return c.json(await saveMcpServer(options.home, c.req.param("name"), body));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // 启用开关、提供方式、单独关掉的工具
  app.patch("/api/mcp/:name", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as McpServerPatch;
    try {
      return c.json(await patchMcpServer(options.home, c.req.param("name"), body));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.delete("/api/mcp/:name", async (c) => {
    try {
      return c.json(await removeMcpServer(options.home, c.req.param("name")));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // 测试连接：连接 → 列工具 → 关闭；失败也是 200，原因在返回值里
  app.post("/api/mcp/:name/test", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { refresh?: boolean };
    try {
      return c.json(await testMcpServer(options.home, c.req.param("name"), body.refresh !== false));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // 从本机导入：只读 pi / Claude Code / Cursor 的配置，同名跳过
  app.get("/api/mcp/import", (c) => c.json(listMcpImports(options.home)));

  app.post("/api/mcp/import", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
    if (!ids.length) return c.json({ error: "请选择要导入的服务。" }, 400);
    try {
      return c.json(await importMcpServers(options.home, ids));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // 设置 → 模型：引擎注册表里现在能用的聊天模型 + 名单里哪些已经不可用
  app.get("/api/models", async (c) => {
    const models = await runtime.models.get();
    const roster = runtime.settings.settings.models.roster;
    const view: ModelsView = {
      models,
      roster: roster.map((entry) => ({ ...entry, ...(runtime.models.find(entry.ref) ? {} : { unavailable: true }) })),
    };
    return c.json(view);
  });

  // 设置 → 服务商 → 模型：存一个模型的自定义思考档（levels 为 null 就恢复默认）
  app.put("/api/models/thinking", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<ModelThinkingPatch>;
    const ref = typeof body.ref === "string" ? body.ref.trim() : "";
    if (!ref) return c.json({ error: "未指定模型。" }, 400);
    // 只给已配置服务商里的模型存：存不到不存在的模型上
    if (!(await runtime.providers.thinkingOf(ref))) {
      return c.json({ error: `模型 ${ref} 不在已配置的服务商里。` }, 400);
    }
    let next;
    try {
      next = runtime.settings.setThinking(ref, body.levels);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    // 存完马上套进引擎（兼容接口的模型配置 / 内置服务商的 modelOverrides），并把模型名单缓存失效
    await runtime.providers.apply();
    const thinking = await runtime.providers.thinkingOf(ref);
    if (!thinking) return c.json({ error: `模型 ${ref} 不在已配置的服务商里。` }, 400);
    return c.json({ settings: next, thinking } satisfies ModelThinkingSaved);
  });

  // 设置 → 消耗：会话文件里的用量和价格表；改单价走 settings.json，price 为 null 恢复默认
  app.get("/api/usage", async (c) => c.json(await runtime.usage.view()));

  app.put("/api/usage/price", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Partial<UsagePricePatch>;
    if (typeof body.revision !== "number") return c.json({ error: "缺 revision" }, 400);
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) return c.json({ error: "未指定模型。" }, 400);
    let next;
    try {
      next = runtime.settings.setUsagePrice(body.revision, model, body.price ?? null);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (!next) return c.json({ error: "设置已在别处修改，已刷新" }, 409);
    return c.json({ settings: next, price: await runtime.usage.priceOf(model) } satisfies UsagePriceSaved);
  });

  // 设置 → 服务商：列表（Key 只报配没配）、引擎自带的服务商目录、整份设置
  app.get("/api/providers/claude-status", async (c) => c.json(await claudeStatus(runtime.home, runtime.settings.settings.claude?.executable || undefined)));
  app.get("/api/claude", async (c) => {
    await runtime.providers.apply();
    return c.json({ settings: runtime.settings.get(), status: await claudeStatus(runtime.home, runtime.settings.settings.claude?.executable || undefined) });
  });
  app.put("/api/claude", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { revision?: number; claude?: ClaudeCodeSettings };
    try {
      if (!body.claude) throw new Error("Claude Code 设置无效。");
      const settings = runtime.settings.setClaude(body.revision ?? -1, body.claude);
      if (!settings) return c.json({ error: "设置已更改，请刷新后重试。" }, 409);
      await runtime.providers.apply();
      router.releaseSessions();
      return c.json({ settings, status: await claudeStatus(runtime.home, settings.settings.claude?.executable || undefined) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
  app.get("/api/providers", async (c) => c.json(await runtime.providers.view()));

  // 新建或改一个服务商；Key 可选，留空就沿用已存的
  app.put("/api/providers/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    try {
      const view = await runtime.providers.put(c.req.param("id"), body);
      router.releaseSessions();
      return c.json(view);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // 删服务商：Key 一起删，名单里用到它的模型变成不可用
  app.delete("/api/providers/:id", async (c) => {
    let view;
    try {
      view = await runtime.providers.remove(c.req.param("id"));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (!view) return c.json({ error: "服务商不存在" }, 404);
    router.releaseSessions();
    return c.json(view);
  });

  app.post("/api/providers/test", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      await runtime.providers.testConnection(body);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // 从兼容接口拉模型列表：失败也是 200 以外的具体原因
  app.post("/api/providers/discover", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      return c.json(await runtime.providers.discover(body));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // 从本机已有的配置导入服务商：只读来源文件，返回里没有 Key 明文
  app.get("/api/providers/import", async (c) => c.json(await runtime.providers.importView()));

  app.post("/api/providers/import", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
    if (!ids.length) return c.json({ error: "请选择要导入的服务商。" }, 400);
    try {
      const view = await runtime.providers.importFromLocal(ids);
      router.releaseSessions();
      return c.json(view);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  // 设置 → 记忆：提供者 + Lore 连接（Token 只写不读）
  app.get("/api/memory", (c) => c.json(runtime.settings.memory()));

  app.put("/api/memory", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { revision?: number; provider?: unknown };
    if (typeof body.revision !== "number") return c.json({ error: "缺 revision" }, 400);
    let next;
    try {
      next = runtime.settings.setMemoryProvider(body.revision, body.provider);
    } catch (error) {
      // 选 Lore 但没配好：fail-closed，绝不静默回退到本地记忆
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (!next) return c.json({ error: "设置已在别处修改，已刷新" }, 409);
    // 新会话立即用新提供者：空闲的 Router 释放，在回复的等这一轮跑完再释放
    router.releaseSessions();
    return c.json(next);
  });

  app.get("/api/search", (c) => {
    const keys = readSecrets(options.home);
    return c.json({ providers: runtime.settings.settings.search.map((p) => ({ ...p, keyConfigured: Boolean(keys[`search:${p.name}`]) })) });
  });

  app.put("/api/search", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { revision?: number; providers?: unknown; keys?: Record<string, unknown> };
    if (typeof body.revision !== "number" || !Array.isArray(body.providers)) return c.json({ error: "联网搜索配置无效。" }, 400);
    const settings = runtime.settings.setSearch(body.revision, body.providers);
    if (!settings) return c.json({ error: "设置已在别处修改，已刷新" }, 409);
    for (const name of SEARCH_PROVIDERS) if (typeof body.keys?.[name] === "string") writeSecret(options.home, `search:${name}`, (body.keys[name] as string).trim());
    router.releaseSessions();
    return c.json(settings);
  });

  app.post("/api/search/test", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { name?: string; baseUrl?: string; apiKey?: string };
    const saved = runtime.settings.settings.search.find((p) => p.name === body.name);
    const provider = saved && { ...saved, ...(typeof body.baseUrl === "string" ? { baseUrl: body.baseUrl.trim() } : {}) };
    if (!provider) return c.json({ ok: false, error: "服务商不存在。" });
    try {
      const overrides = typeof body.apiKey === "string" && body.apiKey.trim() ? { [`search:${provider.name}`]: body.apiKey.trim() } : {};
      const result = await new WebSearch(options.home, () => [{ ...provider, enabled: true }], undefined, overrides).search("hob");
      return c.json(result.errors.length ? { ok: false, error: result.errors[0].error } : { ok: true, count: result.results.length });
    } catch (error) { return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get("/api/knowledge/embedding", (c) => c.json({ keyConfigured: Boolean(embeddingKey(options.home)) }));

  app.put("/api/knowledge/embedding", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { revision?: number; embedding?: unknown; apiKey?: unknown };
    if (typeof body.revision !== "number") return c.json({ error: "缺 revision" }, 400);
    try {
      const previous = embeddingModel(runtime.settings.settings.knowledge?.embedding ?? { source: "off" });
      const settings = runtime.settings.setEmbedding(body.revision, body.embedding);
      if (!settings) return c.json({ error: "设置已在别处修改，已刷新" }, 409);
      const keyChanged = typeof body.apiKey === "string" && Boolean(body.apiKey.trim());
      if (keyChanged) writeSecret(options.home, EMBEDDING_KEY_SECRET, String(body.apiKey).trim());
      // 换模型要全部重算；只换 Key 时向量还能用，只重试之前失败的
      if (previous !== embeddingModel(settings.settings.knowledge?.embedding ?? { source: "off" })) await runtime.knowledge.refreshIndexes(true);
      else if (keyChanged) await runtime.knowledge.reindex();
      return c.json({ settings, keyConfigured: Boolean(embeddingKey(options.home)) });
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });

  app.post("/api/knowledge/embedding/test", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { embedding?: unknown; apiKey?: unknown };
    try {
      const config = body.embedding ? checkEmbeddingSettings(body.embedding) : runtime.settings.settings.knowledge?.embedding ?? { source: "off" };
      const key = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : embeddingKey(options.home);
      const vectors = await embed(config, key, ["知识库连接测试"]);
      return c.json({ ok: true, dims: vectors[0]!.length });
    } catch (error) { return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
  });

  // 设置 → 图像生成：接口的 Key 配没配（Key 永不回显）
  app.get("/api/image", (c) => {
    const view: ImageKeyView = { keyConfigured: Boolean(imageKey(options.home)) };
    return c.json(view);
  });

  // 保存图像生成配置；带了新 Key 就写进 secrets.json（留空 = 沿用已保存的）
  app.put("/api/image", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { revision?: number; image?: unknown; apiKey?: unknown };
    if (typeof body.revision !== "number") return c.json({ error: "缺 revision" }, 400);
    let settings;
    try {
      settings = runtime.settings.setImage(body.revision, body.image);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (!settings) return c.json({ error: "设置已在别处修改，已刷新" }, 409);
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      writeSecret(options.home, IMAGE_KEY_SECRET, body.apiKey.trim());
    }
    router.releaseSessions();
    const saved: ImageSettingsSaved = { settings, keyConfigured: Boolean(imageKey(options.home)) };
    return c.json(saved);
  });

  // 生成测试图片：真生成一张图（用户点了才发生），失败也是 200，原因原样给页面
  app.post("/api/image/test", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { image?: unknown; apiKey?: unknown };
    let config;
    try {
      config = body.image ? checkImageSettings(body.image) : runtime.settings.settings.image;
    } catch (error) {
      const failed: ImageTestResult = { ok: false, error: error instanceof Error ? error.message : String(error) };
      return c.json(failed);
    }
    if (!imageConfigured(config)) {
      const failed: ImageTestResult = {
        ok: false,
        error: "尚未配置图像生成：请在「设置 → 图像生成」中选择 OpenAI 兼容接口。",
      };
      return c.json(failed);
    }
    try {
      const path = await generateImage(
        {
          home: options.home,
          dir: join(cacheDir(options.home), "previews"),
          config,
          ...(typeof body.apiKey === "string" && body.apiKey.trim() ? { apiKey: body.apiKey.trim() } : {}),
        },
        { prompt: "一只橘猫，简笔画" },
      );
      const done: ImageTestResult = { ok: true, path };
      return c.json(done);
    } catch (error) {
      const failed: ImageTestResult = { ok: false, error: error instanceof Error ? error.message : String(error) };
      return c.json(failed);
    }
  });

  app.put("/api/memory/lore", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { baseUrl?: unknown; token?: unknown };
    try {
      saveLoreConnection(options.home, body);
      await testLoreConnection(options.home, {});
      runtime.pi.loreSkillPaths = [];
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    router.releaseSessions();
    return c.json(runtime.settings.memory());
  });

  app.post("/api/memory/lore-test", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { baseUrl?: unknown; token?: unknown };
    return c.json(await testLoreConnection(options.home, body));
  });

  // 从本机已有的 Lore 配置导入（只读来源文件，Token 不回显）
  app.get("/api/memory/lore/import", (c) => c.json(readLocalLore(localLoreHome())));

  app.post("/api/memory/lore/import", async (c) => {
    const local = readLocalLoreConnection(localLoreHome());
    if (!local.view.found || !local.view.baseUrl) return c.json({ error: "未找到可导入的配置。" }, 400);
    try {
      saveLoreConnection(options.home, {
        baseUrl: local.view.baseUrl,
        ...(local.token ? { token: local.token } : {}),
      });
      await testLoreConnection(options.home, {});
      runtime.pi.loreSkillPaths = [];
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    router.releaseSessions();
    return c.json(runtime.settings.memory());
  });

  // 设置 → 通知：推送公开密钥 + 已订阅设备（VAPID 密钥和订阅在 HOB_HOME/push.json）
  app.get("/api/push", (c) => c.json(runtime.push.view()));

  app.post("/api/push/subscribe", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { subscription?: PushSubscriptionJson; label?: unknown };
    try {
      const device = runtime.push.subscribe(body.subscription as PushSubscriptionJson, typeof body.label === "string" ? body.label : "");
      return c.json({ device, push: runtime.push.view() });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.delete("/api/push/subscribe", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
    if (typeof body.endpoint !== "string" || !body.endpoint) return c.json({ error: "缺 endpoint" }, 400);
    runtime.push.unsubscribe(body.endpoint);
    return c.json(runtime.push.view());
  });

  app.post("/api/push/test", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { endpoint?: unknown };
    const endpoint = typeof body.endpoint === "string" && body.endpoint ? body.endpoint : undefined;
    const result = await runtime.push.test(endpoint);
    if (endpoint && result.skipped === "no-devices") return c.json({ error: "这台设备尚未订阅推送" }, 404);
    if (!result.sent && result.error) return c.json({ error: `发送失败：${result.error}` }, 502);
    return c.json(result);
  });

  // 页面有没有在前台：只存内存，SSE 断掉就当不可见
  app.post("/api/visibility", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { clientId?: unknown; visible?: unknown };
    if (typeof body.clientId !== "string" || !body.clientId) return c.json({ error: "缺 clientId" }, 400);
    runtime.push.setVisibility(body.clientId, body.visible === true);
    return c.json({ ok: true });
  });

  app.post("/api/password", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { old?: string; new?: string };
    if (!verifyPassword(runtime.config.passwordHash, body.old ?? "")) {
      return c.json({ error: "旧密码不正确" }, 403);
    }
    const next = (body.new ?? "").trim();
    if (next.length < 4) return c.json({ error: "新密码至少 4 位" }, 400);
    runtime.config = setPassword(options.home, runtime.config, next);
    return c.json({ ok: true });
  });

  // 设置 → 关于
  app.get("/api/about", (c) => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    const about: AboutInfo = { version: pkg.version ?? "0.0.0", home: options.home };
    return c.json(about);
  });

  // 任务记录：全部任务，新的在前，可按助手 / 状态筛选
  app.get("/api/jobs", (c) => {
    const assistantId = c.req.query("assistantId");
    const status = c.req.query("status");
    if (status && !JOB_STATUSES.includes(status as JobStatus)) {
      return c.json({ error: `无效的状态：${status}` }, 400);
    }
    const limit = Number(c.req.query("limit") ?? 30);
    return c.json(
      jobs.page({
        ...(assistantId ? { assistantId } : {}),
        ...(status ? { status: status as JobStatus } : {}),
        ...(c.req.query("before") ? { before: c.req.query("before")! } : {}),
        ...(Number.isFinite(limit) ? { limit } : {}),
      }),
    );
  });

  // 任务详情：从任务会话推导完整过程
  app.get("/api/jobs/:id/transcript", (c) => {
    const job = store.job(c.req.param("id"));
    if (!job) return c.json({ error: "任务不存在" }, 404);
    return c.json({ job, steps: jobs.transcript(job.id) });
  });

  app.get("/api/assistants/:id/skills", (c) => {
    const id = c.req.param("id");
    if (!store.assistant(id)) return c.json({ error: "助手不存在" }, 404);
    try { return c.json(listAssistantSkills(options.home, id)); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.patch("/api/assistants/:id/skills/:name", async (c) => {
    const id = c.req.param("id");
    if (!store.assistant(id)) return c.json({ error: "助手不存在" }, 404);
    const body = await c.req.json().catch(() => ({})) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return c.json({ error: "启用状态无效" }, 400);
    try {
      const skill = setAssistantSkillEnabled(options.home, id, c.req.param("name"), body.enabled);
      bus.emit({ type: "skills", assistantId: id });
      return c.json(skill);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.post("/api/assistants/:id/skills/:name/rollback", (c) => {
    const id = c.req.param("id");
    if (!store.assistant(id)) return c.json({ error: "助手不存在" }, 404);
    try {
      const skill = rollbackAssistantSkill(options.home, id, c.req.param("name"));
      bus.emit({ type: "skills", assistantId: id });
      return c.json(skill);
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });
  app.delete("/api/assistants/:id/skills/:name", (c) => {
    const id = c.req.param("id");
    if (!store.assistant(id)) return c.json({ error: "助手不存在" }, 404);
    try {
      deleteSkill(runtime, id, c.req.param("name"));
      return c.json({ ok: true });
    } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 400); }
  });

  app.get("/api/assistants/:id/items", (c) => {
    const id = c.req.param("id");
    if (!store.assistant(id)) return c.json({ error: "助手不存在" }, 404);
    const limit = Number(c.req.query("limit") ?? 50);
    const before = c.req.query("before") ?? undefined;
    return c.json(router.items(id, { ...(before ? { before } : {}), limit }));
  });

  app.get("/api/assistants/:id/profile", (c) => {
    const id = c.req.param("id");
    if (!store.assistant(id)) return c.json({ error: "助手不存在" }, 404);
    return c.json(router.profile(id));
  });

  app.post("/api/assistants/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!store.assistant(id)) return c.json({ error: "助手不存在" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      text?: string;
      quote?: { itemId: string; text: string };
      files?: string[];
    };
    const text = (body.text ?? "").trim();
    // 和 Telegram 一样，只发图片 / 文件不写字也行
    if (!text && !body.files?.length) return c.json({ error: "消息内容为空" }, 400);
    const item = await router.send(id, {
      text,
      ...(body.quote ? { quote: body.quote } : {}),
      ...(body.files?.length ? { files: body.files } : {}),
    });
    return c.json({ item }, 202);
  });

  app.post("/api/assistants/:id/stop", async (c) => {
    await router.stop(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.post("/api/assistants/:id/read", (c) => {
    router.read(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.patch("/api/assistants/:id", async (c) => {
    const id = c.req.param("id");
    const assistant = store.assistant(id);
    if (!assistant) return c.json({ error: "助手不存在" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as Partial<Assistant> & { rule?: { id?: unknown; text?: unknown; mode?: unknown } };
    if (body.rule !== undefined) {
      const edit = body.rule;
      if (!edit || typeof edit !== "object" || (edit.id !== undefined && (typeof edit.id !== "string" || !edit.id))) return c.json({ error: "规则无效。" }, 400);
      if ((edit.id === undefined || edit.text !== undefined) && (typeof edit.text !== "string" || !edit.text.trim() || edit.text.trim().length > 1000)) return c.json({ error: "规则内容不能为空或超过 1000 字。" }, 400);
      if ((edit.id === undefined || edit.mode !== undefined) && edit.mode !== "ask" && edit.mode !== "allow") return c.json({ error: "规则模式无效。" }, 400);
      const rules = store.rules(id);
      const existing = edit.id === undefined ? undefined : rules.find((item) => item.id === edit.id);
      if (edit.id !== undefined && !existing) return c.json({ error: "规则不存在。" }, 404);
      const text = typeof edit.text === "string" ? edit.text.trim() : existing!.text;
      if (rules.some((item) => item.id !== edit.id && item.text === text)) return c.json({ error: "规则内容已存在。" }, 400);
      const mode = edit.mode === "ask" || edit.mode === "allow" ? edit.mode : existing!.mode;
      const rule = { id: existing?.id ?? newId("r-"), text, mode, changedAt: new Date().toISOString() };
      if (existing) Object.assign(existing, rule);
      else rules.push(rule);
      store.saveRules(id, rules);
      bus.emit({ type: "profile", assistantId: id });
      return c.json({ ok: true, rule });
    }
    if (body.knowledge !== undefined) {
      if (!Array.isArray(body.knowledge) || body.knowledge.some((id) => typeof id !== "string")) return c.json({ error: "知识库绑定无效。" }, 400);
      const collections = (await runtime.knowledge.list()).collections;
      if (body.knowledge.some((id) => !collections.some((item) => item.id === id))) return c.json({ error: "知识库不存在。" }, 400);
    }
    if (typeof body.sprite === "string" && body.sprite !== assistant.sprite) {
      const parsed = parseSprite(body.sprite);
      // custom 要有画法数据才收（画法在 prop 字段上，PATCH 不改它）；否则渲染成空手火苗，不如拒绝
      if (!parsed || (parsed.prop === "custom" && !assistant.prop)) return c.json({ error: "头像无效。" }, 400);
    }
    let models;
    let abilities;
    try {
      await runtime.models.get();
      ({ models, abilities } = checkAssistantModels(
        { ...(body.models ? { models: body.models } : {}), ...(body.abilities ? { abilities: body.abilities } : {}) },
        runtime.settings.settings.models.roster,
        runtime.models,
      ));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    const next: Assistant = {
      ...assistant,
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.duty === "string" ? { duty: clampDuty(body.duty) } : {}),
      ...(typeof body.dutyLong === "string" ? { dutyLong: body.dutyLong } : {}),
      ...(typeof body.sprite === "string" ? { sprite: body.sprite } : {}),
      ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
      // 置顶区里的位置：拖动头像换位置后按 0、1、2… 存，取整且不为负
      ...(typeof body.pinOrder === "number" && Number.isFinite(body.pinOrder) ? { pinOrder: Math.max(0, Math.round(body.pinOrder)) } : {}),
      ...(typeof body.hidden === "boolean" ? { hidden: body.hidden } : {}),
      ...(typeof body.notify === "boolean" ? { notify: body.notify } : {}),
      ...(models ? { models } : {}),
      ...(abilities ? { abilities } : {}),
      ...(typeof body.instructions === "string" ? { instructions: body.instructions } : {}),
      ...(body.knowledge !== undefined ? { knowledge: [...new Set(body.knowledge)] } : {}),
    };
    store.saveAssistant(next);
    // 工具说明和注册取决于模型及助手能力，变化后重开会话
    if (models || abilities) router.releaseSessions();
    const summary = router.summary(next);
    bus.emit({ type: "assistant", assistant: summary });
    return c.json({ assistant: summary });
  });

  // 归档助手：档案、对话、规则和定时进归档，助手从列表移除
  app.post("/api/assistants/:id/archive", async (c) => {
    const result = await archiveAssistant(runtime, c.req.param("id"));
    return c.json(result.body as Record<string, unknown>, result.status as 200);
  });

  app.delete("/api/assistants/:id/rules/:rid", (c) => {
    const id = c.req.param("id");
    const rules = store.rules(id).filter((rule) => rule.id !== c.req.param("rid"));
    store.saveRules(id, rules);
    bus.emit({ type: "profile", assistantId: id });
    return c.json({ ok: true });
  });

  app.post("/api/delegations/:id/retry", async (c) => {
    const record = store.delegation(c.req.param("id"));
    if (!record) return c.json({ error: "委派不存在" }, 404);
    if (record.status !== "interrupted") return c.json({ error: "只有已中断的委派可以重新转交" }, 400);
    try {
      return c.json({ delegation: await runtime.delegations.start(record.to, record.text) });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/approvals/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as AnswerApprovalBody;
    if (body.key === undefined && body.text === undefined) return c.json({ error: "缺答案：key 或 text 二选一" }, 400);
    const result = await answerApproval(runtime, c.req.param("id"), {
      ...(body.key !== undefined ? { key: body.key } : {}),
      ...(body.text !== undefined ? { text: body.text } : {}),
    });
    return c.json(result.body as Record<string, unknown>, result.status as 200);
  });

  app.post("/api/drafts/:id/create", async (c) => {
    const result = await createFromDraft(runtime, c.req.param("id"));
    return c.json(result.body as Record<string, unknown>, result.status as 200);
  });

  app.post("/api/drafts/:id/dismiss", (c) => {
    const result = dismissDraft(runtime, c.req.param("id"));
    return c.json(result.body as Record<string, unknown>, result.status as 200);
  });

  app.post("/api/routines", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      assistantId?: string;
      name?: string;
      instruction?: string;
      schedules?: string[];
      check?: RoutineCheck;
      once?: boolean;
    };
    if (!body.assistantId || !body.name || !body.instruction || !body.schedules?.length) {
      return c.json({ error: "缺字段：assistantId、name、instruction、schedules" }, 400);
    }
    try {
      const routine = routines.create({
        assistantId: body.assistantId,
        name: body.name,
        instruction: body.instruction,
        schedules: body.schedules,
        ...(body.check ? { check: body.check } : {}),
        ...(body.once ? { once: true } : {}),
      });
      return c.json({ routine });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.patch("/api/routines/:id", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: string;
      instruction?: string;
      schedules?: string[];
      active?: boolean;
      skill?: string | null;
      check?: RoutineCheck | null;
      once?: boolean;
    };
    try {
      const routine = routines.update(c.req.param("id"), body);
      return c.json({ routine });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return c.json({ error: message }, message.includes("不存在") ? 404 : 400);
    }
  });

  app.delete("/api/routines/:id", (c) => {
    try {
      routines.remove(c.req.param("id"));
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });

  app.post("/api/routines/:id/run", async (c) => {
    try {
      const result = await routines.runNow(c.req.param("id"));
      return c.json(result);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 404);
    }
  });

  app.post("/api/jobs/:id/sediment", (c) => {
    const id = c.req.param("id");
    if (!store.job(id)) return c.json({ error: "任务不存在" }, 404);
    try { jobs.startSediment(id); return c.json({ ok: true }); }
    catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
  });

  app.post("/api/jobs/:id/reply", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: string };
    if (!body.text?.trim()) return c.json({ error: "消息是空的" }, 400);
    try {
      await jobs.reply(c.req.param("id"), body.text.trim(), "user");
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  });

  app.post("/api/jobs/:id/stop", async (c) => {
    await jobs.stop(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/api/knowledge", async (c) => {
    const limit = Number(c.req.query("limit"));
    return c.json(await runtime.knowledge.list({ origin: c.req.query("origin"), collection: c.req.query("collection"), kind: c.req.query("kind"), assistantId: c.req.query("assistantId"), q: c.req.query("q"), before: c.req.query("before"), ...(Number.isFinite(limit) && limit > 0 ? { limit: Math.floor(limit) } : {}) }));
  });

  app.post("/api/knowledge/collections", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { name?: unknown };
    if (typeof body.name !== "string" || !body.name.trim()) return c.json({ error: "名称不能为空" }, 400);
    const collection = await runtime.knowledge.createCollection(body.name.trim());
    return c.json({ collection: { ...collection, count: 0 } });
  });

  app.patch("/api/knowledge/collections/:id", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { name?: unknown };
    if (typeof body.name !== "string" || !body.name.trim()) return c.json({ error: "名称不能为空" }, 400);
    const collection = await runtime.knowledge.renameCollection(c.req.param("id"), body.name.trim());
    if (!collection) return c.json({ error: "知识库不存在" }, 404);
    const count = (await runtime.knowledge.list()).collections.find((item) => item.id === collection.id)?.count ?? 0;
    return c.json({ collection: { ...collection, count } });
  });

  app.delete("/api/knowledge/collections/:id", async (c) => {
    const deleted = await runtime.knowledge.deleteCollection(c.req.param("id"));
    if (deleted === undefined) return c.json({ error: "知识库不存在" }, 404);
    return c.json({ deleted });
  });

  app.get("/api/knowledge/entries/:id", async (c) => {
    const raw = c.req.query("chunk");
    if (raw !== undefined && !/^\d+$/.test(raw)) return c.json({ error: "段号无效" }, 400);
    const view = await runtime.knowledge.entry(c.req.param("id"), raw === undefined ? undefined : Number(raw));
    return view ? c.json(view) : c.json({ error: "条目不存在" }, 404);
  });

  app.post("/api/knowledge/collections/:id/reindex", async (c) => {
    return await runtime.knowledge.reindex(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "知识库不存在" }, 404);
  });

  app.patch("/api/knowledge/entries/:id", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { name?: unknown; collections?: unknown };
    if ((body.name !== undefined && (typeof body.name !== "string" || !body.name.trim())) || (body.collections !== undefined && (!Array.isArray(body.collections) || !body.collections.every((id) => typeof id === "string")))) return c.json({ error: "条目参数无效" }, 400);
    try {
      const entry = await runtime.knowledge.updateEntry(c.req.param("id"), { ...(typeof body.name === "string" ? { name: body.name.trim() } : {}), ...(Array.isArray(body.collections) ? { collections: body.collections as string[] } : {}) });
      return entry ? c.json({ entry }) : c.json({ error: "条目不存在" }, 404);
    } catch (error) {
      if (error instanceof Error && error.message === "知识库不存在") return c.json({ error: error.message }, 404);
      throw error;
    }
  });

  app.delete("/api/knowledge/entries/:id", async (c) => {
    return await runtime.knowledge.deleteEntry(c.req.param("id")) ? c.json({ ok: true }) : c.json({ error: "条目不存在" }, 404);
  });

  app.post("/api/knowledge/upload", async (c) => {
    const collectionId = c.req.query("collection");
    if (!collectionId || !(await runtime.knowledge.list()).collections.some((item) => item.id === collectionId)) return c.json({ error: "知识库不存在" }, 404);
    const body = await c.req.parseBody({ all: true });
    const files = Object.values(body).flatMap((value) => Array.isArray(value) ? value : [value]).filter((value): value is File => value instanceof File);
    if (!files.length) return c.json({ error: "没有收到文件" }, 400);
    if (files.some((file) => file.size > 100 * 1024 * 1024)) return c.json({ error: "文件超过 100 MB" }, 400);
    const dir = join(options.home, "knowledge", "incoming");
    mkdirSync(dir, { recursive: true });
    const entries = [];
    for (const file of files) {
      const name = file.name.replace(/[/\\\\]/g, "_") || "file";
      const path = join(dir, `${newId("u-")}-${name}`);
      try {
        writeFileSync(path, Buffer.from(await file.arrayBuffer()), { mode: 0o600 });
        const entry = await runtime.knowledge.upload({ path, name }, collectionId);
        if (entry) entries.push(entry);
      } catch (error) {
        if (error instanceof Error && error.message === "知识库不存在") return c.json({ error: error.message }, 404);
        throw error;
      } finally { rmSync(path, { force: true }); }
    }
    return c.json({ entries });
  });

  app.post("/api/uploads", async (c) => {
    const assistantId = (c.req.query("assistantId") ?? "").trim();
    if (!assistantId) return c.json({ error: "缺少 assistantId：上传的文件要放在某个助手的目录下" }, 400);
    if (!store.assistant(assistantId)) return c.json({ error: `助手不存在：${assistantId}` }, 404);
    const body = await c.req.parseBody({ all: true });
    const uploads = assistantFilesDir(options.home, assistantId, "uploads");
    mkdirSync(uploads, { recursive: true });
    const saved: { path: string; name: string }[] = [];
    const values = Object.values(body).flatMap((value) => (Array.isArray(value) ? value : [value]));
    for (const value of values) {
      if (!(value instanceof File)) continue;
      const safeName = value.name.replace(/[/\\]/g, "_") || "file";
      const path = join(uploads, `${newId("u-")}-${safeName}`);
      writeFileSync(path, Buffer.from(await value.arrayBuffer()));
      saved.push({ path, name: safeName });
    }
    if (!saved.length) return c.json({ error: "没有收到文件" }, 400);
    return c.json({ files: saved.map((item) => item.path), file: saved[0] });
  });

  app.get("/api/files", async (c) => {
    const requested = c.req.query("path");
    const lookup = requested ? lookupFile(options.home, requested, workDirs()) : null;
    const nosniff = { "x-content-type-options": "nosniff" };
    if (!lookup) return c.json({ error: "缺 path" }, 400, nosniff);
    if (!lookup.ok) return c.json({ error: lookup.error }, lookup.status, nosniff);
    const { info } = lookup;
    // 能跑脚本的类型（html / svg / xml）：默认当附件下载，只有预览面板带 ?inline=1 才内联，并且始终加 sandbox CSP
    const scriptable = info.kind === "html" || info.kind === "svg" || info.kind === "xml";
    // 代码/纯文本按扩展名只有 octet-stream，不带 charset 会被浏览器当 latin1 解码，中文变乱码
    const mime = info.text && !info.mime.includes("charset") ? `${info.mime}; charset=utf-8` : info.mime;
    const headers: Record<string, string> = { ...nosniff, "content-type": mime };
    if (scriptable) {
      headers["content-security-policy"] = info.kind === "html"
        ? info.page && c.req.query("inline") === "1" ? "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox" : "sandbox allow-scripts"
        : "sandbox";
      const name = encodeURIComponent(info.name);
      headers["content-disposition"] = `${c.req.query("inline") === "1" ? "inline" : "attachment"}; filename*=UTF-8''${name}`;
    }
    // 对话里的图片只要缩略图（?thumb=1）；缩不了 / 不值得缩就给原图
    if (c.req.query("thumb") === "1" && info.kind === "image") {
      const thumb = await thumbnail(options.home, info);
      if (thumb) return c.body(new Uint8Array(thumb.data), 200, { ...nosniff, "content-type": thumb.mime, "cache-control": "private, max-age=604800" });
    }
    // 文本只拉 1 MB：预览面板对超大文件只显示前 1 MB，剩下的走下载
    const whole = readFileSync(info.path);
    const body = info.text && c.req.query("truncate") === "1" ? whole.subarray(0, MAX_TEXT_BYTES) : whole;
    return c.body(new Uint8Array(body), 200, headers);
  });

  // 预览面板要的元数据：大小、修改时间、类型、是不是文本
  app.get("/api/files/meta", (c) => {
    const requested = c.req.query("path");
    if (!requested) return c.json({ error: "缺 path" }, 400);
    const lookup = lookupFile(options.home, requested, workDirs());
    if (!lookup.ok) return c.json({ error: lookup.error }, lookup.status);
    const { info } = lookup;
    const meta: FileMeta = {
      path: info.path,
      name: info.name,
      size: info.size,
      modifiedAt: info.modifiedAt,
      mime: info.mime,
      kind: info.kind,
      text: info.text,
      ...(info.page ? { page: true } : {}),
    };
    return c.json(meta);
  });

  // 任务工作目录，一次只列一层。
  app.get("/api/jobs/:id/files", (c) => {
    const job = store.job(c.req.param("id"));
    if (!job) return c.json({ error: "任务不存在" }, 404);
    try {
      return c.json(listJobFiles(job.cwd ?? store.workDir(job.id), c.req.query("path")));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "无法读取工作目录" }, 400);
    }
  });

  app.get("/api/events", (c) => {
    // 页面在连接上带自己的 clientId：连接断了就把这台设备的可见性清掉
    const clientId = c.req.query("clientId") ?? "";
    return streamSSE(c, async (stream) => {
      await stream.write(": ok\n\n");
      const detach = runtime.push.attachClient(clientId);
      const unsubscribe = bus.subscribe((event: HobEvent) => {
        void stream.writeSSE({ data: JSON.stringify(event) }).catch(() => undefined);
      });
      const heartbeat = setInterval(() => {
        void stream.write(": ping\n\n").catch(() => undefined);
      }, 25_000);
      heartbeat.unref?.();
      try {
        await new Promise<void>((resolveDone) => {
          c.req.raw.signal.addEventListener("abort", () => resolveDone());
        });
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
        detach();
      }
    });
  });

  const webDir = options.webDir;
  if (webDir && existsSync(join(webDir, "index.html"))) {
    // iOS 添加到主屏幕时还会去根目录要 /apple-touch-icon(-180x180)(-precomposed).png，一律给同一张
    app.get("/:icon{apple-touch-icon.*\\.png}", serveStatic({ path: join(webDir, "icons/apple-touch-icon-180.png") }));
    app.use("*", serveStatic({ root: webDir }));
    // 带扩展名的路径找不到就是 404：/favicon.ico、/apple-touch-icon.png 这类请求拿到网页会被当成坏图标
    app.get("*", async (c, next) => (/\.[a-z0-9]+$/i.test(c.req.path) ? c.notFound() : next()));
    app.get("*", serveStatic({ path: join(webDir, "index.html") }));
  } else {
    app.get("/", (c) => c.text("Hob 服务端正在运行。前端尚未构建：请执行 npm run build。"));
  }

  return app;
}
