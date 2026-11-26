import {
  createAgentSession,
  createBashTool,
  createExtensionRuntime,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type LoadExtensionsResult,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { Model, Provider } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionFactory, Skill, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ClaudeCodeSettings, MemoryProvider } from "../../shared/types.ts";
import { claudeStatus } from "./claude-status.ts";
import type { ThinkingLevel } from "./config.ts";
import { MEMORY_TOOL_PATTERNS } from "./memory.ts";
import { limitToolCalls } from "./tool-timeout.ts";
import { retryStalledModel } from "./model-stall.ts";
import { protectedFileTools } from "./write-protection.ts";

export interface PiHostOptions {
  /** Hob 自己的引擎目录（凭据、资源、记忆），通常在 HOB_HOME/engine */
  engineDir: string;
  /** 引擎的模型配置（内置服务商的思考档写成 modelOverrides）；缺省 HOB_HOME/engine/models.json */
  modelsPath?: string | null;
  /** 测试注入的假 provider */
  nativeProviders?: Provider[];
  /** 服务商套进引擎（设 Key、注册兼容接口），引擎建好、拿到之前调一次 */
  configure?: (runtime: ModelRuntime) => Promise<void>;
  /** 引擎的重试预算：不给就是三次、间隔 2 秒起；测试把间隔调小，失败用例不用干等 */
  retry?: { maxRetries?: number; baseDelayMs?: number };
}

export interface OpenSessionOptions {
  file: string;
  cwd: string;
  model: string;
  thinking: ThinkingLevel;
  systemPrompt: () => string;
  tools: string[];
  customTools: ToolDefinition<any, any>[];
  writeGuard?: { home: string; roots: () => string[] };
  /** 每次执行 bash 前注入会话级环境（云桌面 CLI 连接信息）。 */
  bashSpawnHook?: (context: { command: string; cwd: string; env: NodeJS.ProcessEnv }) => { command: string; cwd: string; env: NodeJS.ProcessEnv };
  /** 这一轮用哪个记忆提供者：决定加载哪个捆绑插件（off = 两个都不加载） */
  memory?: MemoryProvider;
  /** 只加载工具搜索；插件连接由 Hob 共享。 */
  toolSearch?: boolean;
  /** 任务使用的技能；对话会话不加载。 */
  skills?: Skill[];
  disabledSkills?: string[];
  /** 会话打开时快照好的项目指令文件（通常仅绑定工作目录根的 AGENTS.md） */
  agentsFiles?: Array<{ path: string; content: string }>;
  /** Router 大结果落盘目录；任务不传。 */
  spillDir?: string;
  /** 工具和模型各自的无响应时限；每次调用时读取当前设置。 */
  stall?: { milliseconds: () => number; onRetry: () => void };
}

export interface OpenedSession {
  session: AgentSession;
  manager: SessionManager;
}

/**
 * 兼容接口（GPT、DeepSeek、GLM 走的都是这条）不传「这次调用出错了」，只有 Anthropic 的接口带 is_error，
 * 所以失败要写在文字里，模型才看得出来这回事没办成。
 */
const FAILED_PREFIX = "调用失败：";

/** 读文件的工具：出错就是「文件不存在」这类，模型看得懂，不用再加开头。 */
const PLAIN_FAILURE_TOOLS = new Set(["read", "edit", "write", "save_skill", "review_job"]);

/** 不认识的参数原样报错：静默丢掉会让模型以为做到了（比如把检查脚本写在 create_routine 顶层，建出没有检查的定时任务）。 */
function strictSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(strictSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: any = {};
  for (const [key, value] of Object.entries(schema)) out[key] = key === "properties" ? Object.fromEntries(Object.entries(value as object).map(([k, v]) => [k, strictSchema(v)])) : (value && typeof value === "object" ? strictSchema(value) : value);
  if (out.type === "object" && out.properties && out.additionalProperties === undefined) out.additionalProperties = false;
  return out;
}

/** Hob 自己定义的工具参数一律严格；插件工具（带 namespace）用服务给的 schema，不动。 */
export function strictTools(tools: ToolDefinition<any, any>[]): ToolDefinition<any, any>[] {
  return tools.map((tool) => tool.namespace ? tool : { ...tool, parameters: strictSchema(tool.parameters) });
}

/**
 * 给会话装自定义工具时统一包一层：返回 isError 的，或者直接抛异常的，发给模型的文字前面加「调用失败：」。
 * 抛出去的话引擎自己把异常文字做成错误结果，不经过这里，模型就看不到这回事没办成。
 * 引擎自带工具的报错不动，各工具只写自己的原因。
 */
export function toolFailureText(tools: ToolDefinition<any, any>[]): ToolDefinition<any, any>[] {
  return tools.map((tool) => {
    if (PLAIN_FAILURE_TOOLS.has(tool.name)) return tool;
    return {
      ...tool,
      execute: async (...args: Parameters<typeof tool.execute>) => {
        let result: Awaited<ReturnType<typeof tool.execute>>;
        try {
          result = await tool.execute(...args);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: "text" as const, text: `${FAILED_PREFIX}${message}` }], details: undefined, isError: true };
        }
        if (!result.isError) return result;
        let marked = false;
        const content = result.content.map((block) => {
          if (marked || block.type !== "text") return block;
          marked = true;
          return { ...block, text: `${FAILED_PREFIX}${block.text}` };
        });
        return { ...result, content };
      },
    };
  });
}

/**
 * pi 的 AgentSession 在构建时就把系统提示词算进缓存，之后 ResourceLoader 现读 store 也用不上，
 * 所以要每轮开始前调一次：重设一遍当前工具集会让它按 loader 重算提示词，下一轮生效。
 */
export function refreshSystemPrompt(session: AgentSession, tools = session.getActiveToolNames()): void {
  session.setActiveToolsByName(tools);
}

const requireFromHere = createRequire(import.meta.url);

/** 捆绑的记忆插件包名（pi-memory 在 package.json 里钉死版本）。 */
const MEMORY_PACKAGES = { local: "pi-memory", lore: "@local/lore-pi-extension" } as const;

/**
 * 不在 npm 上的插件：源码（固定版本）直接放在 vendor/ 下随包发布，按路径加载。
 * 不用 bundleDependencies：npm 全局安装带捆绑依赖的包会去编译 macOS 才有的 fsevents，直接装失败。
 */
const VENDORED_PLUGINS: Record<string, string> = {
  "@local/lore-pi-extension": fileURLToPath(new URL("../../vendor/lore-pi-extension/package.json", import.meta.url)),
};

/** 每个插件注册的工具都属于自己那一家：用来做互斥断言。 */
const PI_MEMORY_TOOLS = /^memory_(?:write|read|forget|restore|search|status)$|^scratchpad$/;

/** 捆绑插件的入口文件（包 manifest 里 `pi.extensions` 的第一项）。 */
export function bundledPluginEntry(packageName: string): string {
  const manifest = VENDORED_PLUGINS[packageName] ?? requireFromHere.resolve(`${packageName}/package.json`);
  const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { pi?: { extensions?: unknown } };
  const declared = Array.isArray(pkg.pi?.extensions) ? pkg.pi?.extensions[0] : undefined;
  const entry = typeof declared === "string" && declared ? declared : "./index.ts";
  return join(dirname(manifest), entry);
}

function emptyLoader(systemPrompt: () => string, agentsFiles: Array<{ path: string; content: string }> = []): ResourceLoader {
  const frozenAgents = agentsFiles.map((file) => ({ ...file }));
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: frozenAgents }),
    // 每轮现读 store：换了规矩/记忆下一轮就生效
    getSystemPrompt: () => systemPrompt(),
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

const MEMORY_SNAPSHOT_HEADER = /(\n\n## Memory\n\()Snapshot [^\n.]* at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\. /;

/** 去掉 pi-memory 注入头里会变的快照原因和秒级时间戳，保留后面的指引和记忆正文。 */
export function stabilizeMemorySnapshot(text: string): string {
  return text.replace(MEMORY_SNAPSHOT_HEADER, "$1");
}

/**
 * 记忆插件互斥断言 + 本地记忆的工具修剪与快照去抖。只看捆绑插件（additionalExtensionPaths）：
 * 内联工厂（MCP、按需搜索）不是记忆插件，直接放行。
 *
 * 一次只加载一家的插件：万一哪天两条路径同时挂上，这里立刻报错，而不是把用户的记忆
 * 分裂成两份。pi-memory 没带 qmd，`memory_search` 只会报错，所以在注册前就去掉；
 * 它在 before_agent_start 里拼的快照行带原因和秒级时间，重开会话会改写 system，这里一并去掉。
 */
export function filterMemoryExtensions(
  result: LoadExtensionsResult,
  provider: MemoryProvider,
): LoadExtensionsResult {
  const isInline = (extension: LoadExtensionsResult["extensions"][number]) => extension.path.startsWith("<inline:");
  const bundled = result.extensions.filter((extension) => !isInline(extension));
  if (bundled.length > 1) throw new Error("记忆插件互斥：一次只能加载一个记忆插件。");
  const families = new Set<MemoryProvider>();
  for (const extension of bundled) {
    for (const name of extension.tools?.keys() ?? []) {
      if (PI_MEMORY_TOOLS.test(name)) families.add("local");
      else if (name.startsWith("lore_")) families.add("lore");
    }
  }
  if (families.size > 1) throw new Error("记忆插件互斥：本地记忆与 Lore 不能同时加载。");
  const loaded = [...families][0];
  if (provider === "off" ? loaded !== undefined : loaded !== provider) {
    throw new Error(`记忆插件与当前记忆来源不一致：期望 ${provider}，实际 ${loaded ?? "无"}。`);
  }
  const extensions = bundled.map((extension) => {
    let next = extension;
    if (next.tools?.has("memory_search")) {
      const tools = new Map(next.tools);
      tools.delete("memory_search");
      next = { ...next, tools };
    }
    if (provider === "local" && next.handlers?.has("before_agent_start")) {
      const handlers = new Map(next.handlers);
      const wrapped = (handlers.get("before_agent_start") ?? []).map((handler) => async (event: any, ctx: any) => {
        const out = await handler(event, ctx) as { systemPrompt?: unknown; [key: string]: unknown } | undefined;
        return out && typeof out.systemPrompt === "string" ? { ...out, systemPrompt: stabilizeMemorySnapshot(out.systemPrompt) } : out;
      });
      handlers.set("before_agent_start", wrapped);
      next = { ...next, handlers };
    }
    return next;
  });
  return { ...result, extensions: [...result.extensions.filter(isInline), ...extensions] };
}

/**
 * pi SDK 的宿主：模型运行时 + 会话工厂。不发现用户扩展、技能、AGENTS.md；
 * 扩展只有按记忆提供者挑出来的那一个捆绑插件。
 */
export class PiHost {
  /** Hob 自己的引擎目录：凭据和资源都在 HOB_HOME 里，不碰任何别的工具。 */
  readonly engineDir: string;
  /** 引擎的模型配置：只读 Hob 自己写的那份（内置服务商的思考档），不读别的工具的 models.json。 */
  readonly modelsPath: string;
  /** 服务商套进引擎（设 Key、注册兼容接口）；引擎建好、返回之前调一次。 */
  configure?: (runtime: ModelRuntime) => Promise<void>;
  private runtimePromise?: Promise<ModelRuntime>;
  private claudeFactory?: ExtensionFactory;
  /** Lore 插件在 resources_discover 中注册的目录。 */
  loreSkillPaths: string[] = [];

  constructor(private readonly options: PiHostOptions) {
    this.engineDir = options.engineDir;
    this.modelsPath = options.modelsPath ?? join(this.engineDir, "models.json");
    this.configure = options.configure;
  }

  runtime(): Promise<ModelRuntime> {
    this.runtimePromise ??= (async () => {
      mkdirSync(this.engineDir, { recursive: true });
      const runtime = await ModelRuntime.create({
        authPath: join(this.engineDir, "auth.json"),
        modelsPath: this.modelsPath,
        allowModelNetwork: false,
      });
      for (const provider of this.options.nativeProviders ?? []) runtime.registerNativeProvider(provider);
      await this.configure?.(runtime);
      return runtime;
    })();
    return this.runtimePromise;
  }

  /** 会话尚未打开时先注册桥的模型目录，之后会话复用同一扩展模块。 */
  async configureClaude(runtime: ModelRuntime, home: string, config: ClaudeCodeSettings | undefined): Promise<void> {
    const status = config?.enabled ? await claudeStatus(home, config.executable || undefined) : undefined;
    if (!config?.enabled || !status?.found || !status.loggedIn || !status.executable) {
      this.claudeFactory = undefined;
      runtime.unregisterProvider("claude-bridge");
      return;
    }
    mkdirSync(this.engineDir, { recursive: true });
    writeFileSync(join(this.engineDir, "claude-bridge.json"), JSON.stringify({
      provider: { plan: config.plan, strictMcpConfig: true, autoMemoryEnabled: false, pathToClaudeCodeExecutable: status.executable },
      askClaude: { enabled: false },
    }, null, 2) + "\n", { mode: 0o600 });
    const path = new URL("../../vendor/claude-bridge/src/index.ts", import.meta.url).href;
    const factory = (await import(path)).default as ExtensionFactory;
    const loader = new DefaultResourceLoader({
      cwd: home, agentDir: this.engineDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [factory],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    if (loaded.errors.length) throw new Error(`Claude Code 扩展加载失败：${loaded.errors[0].error}`);
    const registration = loaded.runtime.pendingProviderRegistrations.find((entry) => entry.name === "claude-bridge");
    if (!registration) throw new Error("Claude Code 扩展未注册模型。");
    runtime.registerProvider(registration.name, registration.config);
    this.claudeFactory = factory;
  }

  /** 设置页先于任何会话打开时，也通过插件自己的发现流程取得目录。 */
  async discoverLoreSkills(): Promise<void> {
    const pluginDir = dirname(bundledPluginEntry(MEMORY_PACKAGES.lore));
    const api = await import(pathToFileURL(join(pluginDir, "api.ts")).href);
    const skills = await import(pathToFileURL(join(pluginDir, "skills.ts")).href);
    const config = api.pickPluginConfig({});
    if (!config.skillsEnabled) { this.loreSkillPaths = []; return; }
    let discover: (() => Promise<{ skillPaths?: string[] } | undefined>) | undefined;
    skills.registerSkillResourceDiscovery({ on: (event: string, handler: typeof discover) => { if (event === "resources_discover") discover = handler; } }, config);
    const result = await discover?.();
    if (!result?.skillPaths?.length) throw new Error("无法从 Lore 获取技能目录，请检查连接和服务端技能能力。");
    this.loreSkillPaths = result.skillPaths;
  }

  async model(ref: string): Promise<Model<any>> {
    const runtime = await this.runtime();
    const slash = ref.indexOf("/");
    const provider = slash === -1 ? "" : ref.slice(0, slash);
    const id = slash === -1 ? ref : ref.slice(slash + 1);
    const model = provider ? runtime.getModel(provider, id) : undefined;
    if (!model) throw new Error(`无法使用模型 ${ref}：该模型的服务商已删除或未配置 Key。`);
    return model;
  }

  /**
   * 会话用的资源：只加载当前记忆提供者的那个捆绑插件。
   * 别的工具装的扩展、技能、提示词、主题一份都不加载（`noExtensions` 只放我们给的路径）。
   */
  private async resourceLoader(
    options: OpenSessionOptions,
    settingsManager: SettingsManager,
  ): Promise<ResourceLoader> {
    const provider = options.memory ?? "off";
    const pluginPath = provider === "off" ? undefined : provider === "lore" ? fileURLToPath(new URL("./lore-entry.ts", import.meta.url)) : bundledPluginEntry(MEMORY_PACKAGES.local);
    if (provider === "local") {
      // 会话被频繁回收，退出总结只会白花一次模型调用（和参考产品一致）
      process.env.PI_MEMORY_EXIT_SUMMARY = "0";
    }
    const base = new DefaultResourceLoader({
      cwd: options.cwd,
      agentDir: this.engineDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: pluginPath ? [pluginPath] : [],
      // 按需工具通过 tool_search 加载，连接由 Hob 的插件宿主管理。
      extensionFactories: [
        ...(this.claudeFactory ? [this.claudeFactory] : []),
        ...(options.toolSearch ? [createToolSearchExtension()] : []),
        ...(options.spillDir ? [((pi) => {
          pi.on("tool_result", async (event) => {
            if (event.toolName === "read" || event.toolName === "show_assistant") return;
            const full = event.content.filter((block) => block.type === "text").map((block) => block.text).join("");
            if (full.length <= 4000) return;
            const dir = resolve(options.spillDir!);
            const file = join(dir, `${event.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "") || "tool"}.txt`);
            try {
              mkdirSync(dir, { recursive: true });
              writeFileSync(file, full);
            } catch (error) {
              console.error(`工具结果落盘失败：${file}`, error);
              return;
            }
            let first = true;
            const content = event.content.flatMap<(typeof event.content)[number]>((block) => {
              if (block.type !== "text") return [block];
              if (!first) return [];
              first = false;
              return [{ type: "text" as const, text: `${full.slice(0, 4000)}\n\n（共 ${full.length} 字，这里是前 4,000 字；全文：${file}）` }];
            });
            return { content };
          });
        }) satisfies ExtensionFactory] : []),
      ],
      extensionsOverride: (result) => filterMemoryExtensions(result, provider),
    });
    await base.reload();
    // 系统提示词仍由我们每轮现读（DefaultResourceLoader 的提示词只在 reload 时算一次）
    return {
      ...emptyLoader(options.systemPrompt, options.agentsFiles),
      getExtensions: () => base.getExtensions(),
      getSkills: () => {
        if (!options.skills) return { skills: [], diagnostics: [] };
        const discovered = base.getSkills();
        const assistant = options.skills.filter((skill) => skill.sourceInfo.source === "assistant");
        const own = options.skills.filter((skill) => skill.sourceInfo.source === "hob");
        const common = options.skills.filter((skill) => skill.sourceInfo.source !== "assistant" && skill.sourceInfo.source !== "hob");
        const seen = new Set<string>();
        const skills = [...assistant, ...own, ...discovered.skills, ...common].filter((skill) => {
          if (discovered.skills.includes(skill) && options.disabledSkills?.includes(`lore:${skill.name}`)) return false;
          if (seen.has(skill.name)) return false;
          seen.add(skill.name);
          return true;
        });
        return { skills, diagnostics: discovered.diagnostics };
      },
      extendResources: (paths) => {
        if (provider !== "lore") return;
        this.loreSkillPaths = (paths.skillPaths ?? []).map((entry) => entry.path);
        base.extendResources({ skillPaths: paths.skillPaths });
      },
    };
  }

  async open(options: OpenSessionOptions): Promise<OpenedSession> {
    mkdirSync(dirname(options.file), { recursive: true });
    const model = await this.model(options.model);
    const manager = SessionManager.open(options.file, dirname(options.file), options.cwd);
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "streaming", compaction: { enabled: true }, retry: { enabled: true, ...(this.options.retry ?? {}) } });
    const resourceLoader = await this.resourceLoader(options, settingsManager);
    const memoryTools = MEMORY_TOOL_PATTERNS[options.memory ?? "off"];
    const customTools = [
      ...(options.bashSpawnHook ? [createBashTool(options.cwd, { spawnHook: options.bashSpawnHook })] : []),
      ...(options.writeGuard ? protectedFileTools(options.cwd, options.writeGuard.home, options.writeGuard.roots) : []),
      ...strictTools(options.customTools ?? []),
    ];
    const { session } = await createAgentSession({
      cwd: options.cwd,
      agentDir: this.engineDir,
      model,
      thinkingLevel: options.thinking,
      modelRuntime: await this.runtime(),
      resourceLoader,
      sessionManager: manager,
      settingsManager,
      tools: [...options.tools, ...memoryTools],
      customTools: toolFailureText(customTools),
    });
    if (options.stall) {
      const stall = options.stall;
      const agentState = session.agent.state;
      const descriptor = Object.getOwnPropertyDescriptor(agentState, "tools")!;
      Object.defineProperty(agentState, "tools", {
        ...descriptor,
        set(tools) { descriptor.set!.call(agentState, limitToolCalls(tools, stall.milliseconds)); },
      });
      agentState.tools = agentState.tools;
      const originalStream = session.agent.streamFunction;
      const retryStream = retryStalledModel(originalStream, stall.milliseconds, stall.onRetry);
      session.agent.streamFunction = (model, context, request) => request?.sessionId === session.agent.sessionId
        ? retryStream(model, context, request)
        : originalStream(model, context, request);
      // 保留 SDK 对运行时鉴权的标记：压缩摘要不应预解析凭据再传回同一运行时。
      // 1.5.2 的公开入口没有导出这个标记函数，只能使用固定版本的内部文件。
      const sdkPackage = requireFromHere.resolve.paths("@earendil-works/pi-coding-agent")?.map(path => join(path, "@earendil-works/pi-coding-agent/package.json")).find(existsSync);
      if (!sdkPackage) throw new Error("找不到引擎包。");
      const { markRuntimeStreamFunction } = await import(pathToFileURL(join(dirname(sdkPackage), "dist/core/agent-session.js")).href);
      markRuntimeStreamFunction(session.agent.streamFunction, await this.runtime());
    }
    // resources_discover 由 bindExtensions 触发；Lore 注册技能目录，MCP 连服务（都在后台）
    if (options.memory === "lore") {
      this.loreSkillPaths = [];
      await session.bindExtensions({ mode: "print" });
    } else if (options.toolSearch || this.claudeFactory) {
      await session.bindExtensions({ mode: "print" });
    }
    // SDK 的 tools 同时决定注册白名单和初始激活集；deferred 工具要留在注册表里，
    // 但不能随白名单直接声明。搜索后 pi 仍允许按原名激活这些普通工具。
    const deferred = new Set((options.customTools ?? []).filter(tool => tool.exposure === "deferred").map(tool => tool.name));
    if (deferred.size) session.setActiveToolsByName(session.getActiveToolNames().filter(name => !deferred.has(name)));
    return { session, manager };
  }
}
