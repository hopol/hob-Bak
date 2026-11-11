import {
  createAgentSession,
  createExtensionRuntime,
  createMcpExtension,
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
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ClaudeCodeSettings, MemoryProvider } from "../../shared/types.ts";
import { claudeStatus } from "./claude-status.ts";
import type { ThinkingLevel } from "./config.ts";
import { MEMORY_TOOL_PATTERNS } from "./memory.ts";

export interface PiHostOptions {
  /** Hob 自己的引擎目录（凭据、资源、记忆），通常在 HOB_HOME/engine */
  engineDir: string;
  /** 引擎的模型配置（内置服务商的思考档写成 modelOverrides）；缺省 HOB_HOME/engine/models.json */
  modelsPath?: string | null;
  /** 测试注入的假 provider */
  nativeProviders?: Provider[];
  /** 服务商套进引擎（设 Key、注册兼容接口），引擎建好、拿到之前调一次 */
  configure?: (runtime: ModelRuntime) => Promise<void>;
}

export interface OpenSessionOptions {
  file: string;
  cwd: string;
  model: string;
  thinking: ThinkingLevel;
  systemPrompt: () => string;
  tools: string[];
  customTools: ToolDefinition<any, any>[];
  /** 这一轮用哪个记忆提供者：决定加载哪个捆绑插件（off = 两个都不加载） */
  memory?: MemoryProvider;
  /** 任务会话加载 MCP 服务（引擎目录的 mcp.json）；对话会话不加载。 */
  mcp?: boolean;
  /** 任务使用的技能；对话会话不加载。 */
  skills?: Skill[];
  disabledSkills?: string[];
  /** Router 大结果落盘目录；任务不传。 */
  spillDir?: string;
}

export interface OpenedSession {
  session: AgentSession;
  manager: SessionManager;
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

function emptyLoader(systemPrompt: () => string): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    // 每轮现读 store：换了规矩/记忆下一轮就生效
    getSystemPrompt: () => systemPrompt(),
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/**
 * 记忆插件互斥断言 + 本地记忆的工具修剪。只看捆绑插件（additionalExtensionPaths）：
 * 内联工厂（MCP、按需搜索）不是记忆插件，直接放行。
 *
 * 一次只加载一家的插件：万一哪天两条路径同时挂上，这里立刻报错，而不是把用户的记忆
 * 分裂成两份。pi-memory 没带 qmd，`memory_search` 只会报错，所以在注册前就去掉。
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
    if (!extension.tools?.has("memory_search")) return extension;
    const tools = new Map(extension.tools);
    tools.delete("memory_search");
    return { ...extension, tools };
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
      // 任务会话的 MCP：读引擎目录的 mcp.json，会话启动（bindExtensions）时连服务。
      // 按需搜索（deferred）的服务靠 tool_search 加载，codemode 不提供：不加载那个扩展。
      extensionFactories: [
        ...(this.claudeFactory ? [this.claudeFactory] : []),
        ...(options.mcp ? [createMcpExtension(), createToolSearchExtension()] : []),
        ...(options.spillDir ? [((pi) => {
          pi.on("tool_result", async (event) => {
            if (event.toolName === "read") return;
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
      ...emptyLoader(options.systemPrompt),
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
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true } });
    const resourceLoader = await this.resourceLoader(options, settingsManager);
    const memoryTools = MEMORY_TOOL_PATTERNS[options.memory ?? "off"];
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
      customTools: options.customTools,
    });
    // resources_discover 由 bindExtensions 触发；Lore 注册技能目录，MCP 连服务（都在后台）
    if (options.memory === "lore") {
      this.loreSkillPaths = [];
      await session.bindExtensions({ mode: "print" });
    } else if (options.mcp || this.claudeFactory) {
      await session.bindExtensions({ mode: "print" });
    }
    return { session, manager };
  }
}
