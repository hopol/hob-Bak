// Hob 共享 Bun 供应商插件宿主进程：运行 OpenCode V1 函数式供应商插件，通过 stdio NDJSON 与 Hob 主进程通信。
// 凭据永不落盘到宿主：每次 RPC 只在内存里传入当前账号的 auth 副本；插件调用 client.auth.set 时通过 stdout 事件交回主进程保存。
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const rpcWrite = process.stdout.write.bind(process.stdout);

// 防止插件里的 console.log 污染 stdio JSON-RPC 通道：全部转到 stderr。
const writeErr = (...args) => {
  try {
    const line = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a))).join(" ");
    process.stderr.write(line + "\n");
  } catch { /* ignore */ }
};
console.log = writeErr;
console.info = writeErr;
console.warn = writeErr;
console.debug = () => {};

// 插件可访问 process.stdout，但它不能再把协议行写进 Hob 的协议通道。
process.stdout.write = ((chunk, encoding, callback) => {
  try {
    process.stderr.write(chunk, encoding, callback);
  } catch { /* ignore plugin logging failures */ }
  return true;
});

// 防止单个插件内部未捕获的后台 Promise 拒绝把共享宿主进程整进程带崩
process.on("unhandledRejection", (reason) => {
  writeErr("unhandledRejection:", reason);
});

// ---- 有序输出队列 ----------------------------------------------------------

const outq = [];
let pumping = false;
let outFailed = false;

function waitDrain() {
  return new Promise((resolve) => {
    const done = () => {
      process.stdout.removeListener("drain", done);
      process.stdout.removeListener("error", fail);
      process.stdout.removeListener("close", fail);
      resolve();
    };
    const fail = () => {
      outFailed = true;
      done();
    };
    process.stdout.once("drain", done);
    process.stdout.once("error", fail);
    process.stdout.once("close", fail);
  });
}

function pump() {
  if (pumping) return;
  pumping = true;
  while (outq.length) {
    const item = outq.shift();
    if (outFailed) {
      item.resolve();
      continue;
    }
    const ok = rpcWrite(item.line);
    item.resolve();
    if (!ok) {
      waitDrain().then(() => {
        pumping = false;
        pump();
      });
      return;
    }
  }
  pumping = false;
}

function send(msg) {
  return new Promise((resolve) => {
    outq.push({ line: JSON.stringify(msg) + "\n", resolve });
    pump();
  });
}

// ---- 作用域与状态 ----------------------------------------------------------

/** @type {AsyncLocalStorage<{ pluginId: string, provider: string, accountId: string, auth: any, rpcId: string }>} */
const scopeStorage = new AsyncLocalStorage();
const requestStorage = new AsyncLocalStorage();

// pluginId -> { pluginId, dataDir, packages: [{ package, dir }], hooks: [{ spec, dir, hooks }], providers: Map<providerId, ProviderEntry>, error? }
const pluginRegistry = new Map();
// `${pluginId}\0${providerId}\0${accountId}` -> { authSig, options }
const loaderCache = new Map();
// sign-in sessionId -> { pluginId, providerId, accountId, auth, authorizeResult, inputs, methodIndex }
const signInSessions = new Map();
let nextSessionSeq = 1;

const INDEX_FILES = ["index.mjs", "index.js", "index.ts", "dist/index.js", "dist/index.mjs"];
const MAX_CHUNK_BYTES = 64 * 1024;
const LOAD_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 25_000;

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function clone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function bounded(promise, signal, timeoutMs) {
  let timer;
  const p = Promise.resolve(promise);
  const racers = [p];
  if (signal) {
    racers.push(new Promise((_, reject) => {
      if (signal.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      p.then(cleanup, cleanup);
    }));
  }
  if (timeoutMs && timeoutMs > 0) {
    racers.push(new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`操作超时（${Math.round(timeoutMs / 1000)}s）`)), timeoutMs);
    }));
  }
  return Promise.race(racers).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ---- V1 插件入口解析（与 Magpie 一致：优先 main / ./server，再看 exports["."]） ----

function resolveEntries(target) {
  const stat = fs.statSync(target, { throwIfNoEntry: false });
  if (!stat) throw new Error(`找不到插件包目录：${target}`);
  if (!stat.isDirectory()) return [target];
  const out = [];
  const add = (v) => {
    if (typeof v === "string" && v.trim()) out.push(path.resolve(target, v.trim()));
  };
  const pick = (x) => (typeof x === "string" ? x : x?.import ?? x?.default);
  const pkg = readJSON(path.join(target, "package.json"));
  if (pkg) {
    const ex = pkg.exports && typeof pkg.exports === "object" && !Array.isArray(pkg.exports) ? pkg.exports : undefined;
    if (ex) add(pick(ex["./server"]));
    add(pkg.main);
    if (ex) add(pick(ex["."]));
    if (typeof pkg.exports === "string") add(pkg.exports);
  }
  for (const f of INDEX_FILES) {
    const p = path.join(target, f);
    if (fs.existsSync(p)) out.push(p);
  }
  if (!out.length) {
    throw new Error(`${pkg?.name || target} 不是有效的 OpenCode V1 供应商插件：package.json 没有 main 或 exports 入口`);
  }
  return [...new Set(out)];
}

function extractPluginFns(mod) {
  const d = mod?.default;
  if (d && typeof d === "object" && ("server" in d || "id" in d || "tui" in d)) {
    return typeof d.server === "function" ? [d.server] : [];
  }
  const seen = new Set();
  const out = [];
  for (const v of Object.values(mod ?? {})) {
    if (seen.has(v)) continue;
    seen.add(v);
    if (typeof v === "function") out.push(v);
    else if (v && typeof v === "object" && typeof v.server === "function") out.push(v.server);
  }
  return out;
}

// ---- PluginInput 兼容层 ----------------------------------------------------

function makeStubProxy() {
  return new Proxy(() => Promise.resolve({ data: undefined }), {
    get(_target, prop) {
      if (prop === "then") return undefined;
      return makeStubProxy();
    },
    apply() {
      return Promise.resolve({ data: undefined });
    },
  });
}

function makeClient(pluginId, getConfigSnapshot) {
  return new Proxy({}, {
    get(_target, prop) {
      if (prop === "auth") {
        return {
          async set(arg) {
            const ctx = scopeStorage.getStore();
            const body = arg?.body;
            if (!ctx || !body || typeof body !== "object") return { data: undefined };
            ctx.auth = clone(body);
            const cacheKey = `${ctx.pluginId}\0${ctx.provider}\0${ctx.accountId}`;
            loaderCache.delete(cacheKey);
            send({
              requestId: ctx.rpcId,
              pluginId: ctx.pluginId,
              provider: ctx.provider,
              accountId: ctx.accountId,
              auth: ctx.auth,
            });
            return { data: undefined };
          },
        };
      }
      if (prop === "app") {
        return {
          async log(arg) {
            const level = arg?.body?.level ?? arg?.level ?? "info";
            const message = arg?.body?.message ?? arg?.message ?? "";
            if (message) send({ event: "log", pluginId, level: String(level), message: String(message).slice(0, 500) });
            return { data: undefined };
          },
        };
      }
      if (prop === "tui") {
        return {
          async showToast(arg) {
            const message = arg?.body?.message ?? arg?.message ?? "";
            if (message) send({ event: "toast", pluginId, message: String(message).slice(0, 500) });
            return { data: undefined };
          },
        };
      }
      if (prop === "config") {
        return {
          async get() {
            return { data: clone(getConfigSnapshot()) };
          },
        };
      }
      return makeStubProxy();
    },
  });
}

function iconOf(auth, pkgDir) {
  const ok = (v) => {
    const s = typeof v === "string" ? v.trim() : "";
    return s.length <= 3 << 19 && /^(https:\/\/|data:image\/)/i.test(s) ? s : "";
  };
  const own = ok(auth?.icon);
  if (own || !pkgDir) return own;
  return ok(readJSON(path.join(pkgDir, "package.json"))?.magpie?.icon);
}

function cliMetaOf(auth) {
  const c = auth?.cli;
  if (!c || typeof c !== "object" || typeof c.installed !== "function" || typeof c.install !== "function") return null;
  const name = typeof c.name === "string" ? c.name.trim().slice(0, 80) : "";
  if (!name) return null;
  const manual = typeof c.manual === "string" ? c.manual.trim().slice(0, 300) : "";
  return { name, ...(manual ? { manual } : {}) };
}

function methodsOf(auth) {
  const raw = Array.isArray(auth?.methods) ? auth.methods : [];
  return raw.map((m, index) => {
    const labels = m?.labels && typeof m.labels === "object" ? Object.fromEntries(Object.entries(m.labels).filter(([, v]) => typeof v === "string")) : undefined;
    return {
      index,
      type: m?.type === "api" ? "api" : "oauth",
      label: typeof m?.label === "string" ? m.label : m?.type === "api" ? "API Key" : "OAuth",
      ...(labels && Object.keys(labels).length ? { labels } : {}),
      ...(m?.keyless === true ? { keyless: true } : {}),
      ...(typeof m?.placeholder === "string" && m.placeholder ? { placeholder: m.placeholder } : {}),
      hasPrompts: (Array.isArray(m?.prompts) && m.prompts.length > 0) || typeof m?.ask === "function",
    };
  });
}

function normalizeModel(id, m, providerConfig) {
  const obj = m && typeof m === "object" ? m : {};
  const modelId = typeof obj.id === "string" && obj.id ? obj.id : id;
  const npm = obj.api?.npm ?? providerConfig?.npm ?? "";
  const url = obj.api?.url ?? providerConfig?.api ?? "";
  const apiId = obj.api?.id ?? modelId;
  const context = Number(obj.limit?.context) || 0;
  const output = Number(obj.limit?.output) || 0;
  const capInput = obj.capabilities?.input;
  const modalitiesInput = Array.isArray(obj.modalities?.input) ? obj.modalities.input : [];
  const hasImage = Boolean(capInput?.image) || modalitiesInput.includes("image");
  const variants = obj.variants && typeof obj.variants === "object" ? Object.keys(obj.variants) : [];
  const reasoning = Boolean(obj.capabilities?.reasoning) || Boolean(obj.reasoning) || variants.length > 0;
  const cost = obj.cost && typeof obj.cost === "object"
    ? { input: Number(obj.cost.input) || 0, output: Number(obj.cost.output) || 0 }
    : undefined;
  const also = Array.isArray(obj.also) ? obj.also.filter((x) => typeof x === "string" && x) : [];
  return {
    id: modelId,
    apiId,
    name: typeof obj.name === "string" && obj.name ? obj.name : modelId,
    npm,
    url,
    context,
    output,
    reasoning,
    image: hasImage,
    variants,
    ...(cost ? { cost } : {}),
    ...(obj.free === true ? { free: true } : {}),
    ...(also.length ? { also } : {}),
  };
}

function normalizeModelsRecord(rawModels, providerConfig) {
  if (!rawModels || typeof rawModels !== "object") return [];
  const out = [];
  for (const [key, m] of Object.entries(rawModels)) {
    if (!m || typeof m !== "object") continue;
    if (m.status === "deprecated") continue;
    out.push(normalizeModel(key, m, providerConfig));
  }
  return out;
}

// ---- 插件加载 --------------------------------------------------------------

async function loadSinglePlugin(item) {
  const { pluginId, dataDir, packages, userConfig } = item;
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const cfg = { provider: clone(userConfig?.provider ?? {}) };
  const client = makeClient(pluginId, () => cfg);
  const input = {
    client,
    project: { id: `hob-${pluginId}`, worktree: dataDir, vcs: undefined, time: { created: Date.now() } },
    directory: dataDir,
    worktree: dataDir,
    experimental_workspace: { register() {} },
    serverUrl: new URL("http://127.0.0.1:4096"),
    ...(typeof globalThis.Bun !== "undefined" ? { $: globalThis.Bun.$ } : {}),
    magpie: {
      option: () => undefined,
      options: () => ({}),
      load: () => {},
      usage: () => {},
      account: () => scopeStorage.getStore()?.accountId ?? "",
    },
  };

  const loadedHooks = [];
  const errors = [];

  for (const pkg of packages ?? []) {
    try {
      let fns = [];
      for (const file of resolveEntries(pkg.dir)) {
        const mod = await import(pathToFileURL(file).href);
        fns = extractPluginFns(mod);
        if (fns.length) break;
      }
      if (!fns.length) throw new Error(`包 ${pkg.package} 没有导出任何 OpenCode V1 插件函数`);
      for (const fn of fns) {
        const h = await bounded(fn(input), undefined, LOAD_TIMEOUT_MS);
        loadedHooks.push({ spec: pkg.package, dir: pkg.dir, hooks: h ?? {} });
      }
    } catch (error) {
      errors.push(`${pkg.package}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const h of loadedHooks) {
    if (typeof h.hooks.config === "function") {
      try {
        await bounded(h.hooks.config(cfg), undefined, LOAD_TIMEOUT_MS);
      } catch (error) {
        send({ event: "log", pluginId, level: "error", message: `${h.spec}: config hook: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }

  const providers = new Map();
  const providerModelsHooks = new Map();
  const chatHeaderHooks = [];

  for (const h of loadedHooks) {
    if (h.hooks.provider?.id && typeof h.hooks.provider.models === "function") {
      providerModelsHooks.set(h.hooks.provider.id, h.hooks.provider.models);
    }
    if (typeof h.hooks["chat.headers"] === "function") {
      chatHeaderHooks.push({ spec: h.spec, fn: h.hooks["chat.headers"] });
    }
  }

  for (const h of loadedHooks) {
    const auth = h.hooks.auth;
    if (!auth || typeof auth.provider !== "string" || !auth.provider) continue;
    const providerId = auth.provider;
    const pCfg = cfg.provider?.[providerId] ?? {};
    providers.set(providerId, {
      pluginId,
      providerId,
      spec: h.spec,
      dir: h.dir,
      auth,
      config: pCfg,
      modelsHook: providerModelsHooks.get(providerId) ?? null,
      chatHeaderHooks,
    });
  }

  const entry = {
    pluginId,
    dataDir,
    cfg,
    hooks: loadedHooks,
    providers,
    error: errors.length ? errors.join("；") : undefined,
  };
  pluginRegistry.set(pluginId, entry);

  return {
    pluginId,
    ...(entry.error ? { error: entry.error } : {}),
    providers: [...providers.values()].map((p) => ({
      providerId: p.providerId,
      name: typeof p.config?.name === "string" && p.config.name ? p.config.name : p.providerId,
      npm: typeof p.config?.npm === "string" ? p.config.npm : "",
      api: typeof p.config?.api === "string" ? p.config.api : "",
      icon: iconOf(p.auth, p.dir),
      single: p.auth.single === true,
      methods: methodsOf(p.auth),
      usageSupported: typeof p.auth.usage === "function",
      refreshSupported: typeof p.auth.refresh === "function",
      refreshLead: Number.isFinite(p.auth.refreshLead) && p.auth.refreshLead >= 0 ? p.auth.refreshLead : 5 * 60 * 1000,
      cli: cliMetaOf(p.auth),
      models: normalizeModelsRecord(p.config?.models, p.config),
    })),
  };
}

function getProvider(pluginId, providerId) {
  const plugin = pluginRegistry.get(pluginId);
  if (!plugin) throw new Error(`插件 ${pluginId} 未在宿主中加载`);
  const provider = plugin.providers.get(providerId);
  if (!provider) throw new Error(`插件 ${pluginId} 没有声明供应商 ${providerId}`);
  return provider;
}

function runInScope(pluginId, providerId, accountId, auth, fn) {
  const store = { pluginId, provider: providerId, accountId: accountId || "", auth: clone(auth), rpcId: requestStorage.getStore() || "" };
  return scopeStorage.run(store, fn);
}

function authSignature(auth) {
  try {
    return JSON.stringify(auth ?? null);
  } catch {
    return "";
  }
}

async function resolveLoaderOptions(p, accountId, auth, seedProvider) {
  const key = `${p.pluginId}\0${p.providerId}\0${accountId || ""}`;
  const sig = authSignature(auth);
  const cached = loaderCache.get(key);
  if (cached && cached.authSig === sig) return cached.options;

  let opts = {};
  if (typeof p.auth.loader === "function" && auth) {
    const providerArg = clone({
      id: p.providerId,
      name: p.config?.name ?? p.providerId,
      npm: p.config?.npm ?? "",
      api: p.config?.api ?? "",
      options: p.config?.options ?? {},
      models: { ...(p.config?.models ?? {}) },
    });
    opts = (await p.auth.loader(async () => clone(scopeStorage.getStore()?.auth ?? auth), providerArg)) ?? {};
  }
  if (!opts.apiKey && auth?.type === "api" && typeof auth.key === "string") {
    opts = { ...opts, apiKey: auth.key };
  }
  loaderCache.set(key, { authSig: sig, options: opts });
  return opts;
}

function sdkHeaders(npm, apiKey) {
  if (!apiKey) return {};
  if (npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic") {
    return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
  }
  return { authorization: `Bearer ${apiKey}` };
}

function appliesPrompt(prompt, inputs) {
  if (prompt.when) {
    const v = inputs[prompt.when.key];
    if (v === undefined) return false;
    const eq = v === prompt.when.value;
    if (prompt.when.op === "eq" ? !eq : eq) return false;
  }
  if (typeof prompt.condition === "function" && !prompt.condition(inputs)) return false;
  return true;
}

function extractAccountInfo(result, auth) {
  const src = result && typeof result === "object" ? result : auth ?? {};
  const displayName =
    (typeof src.email === "string" && src.email) ||
    (typeof src.accountId === "string" && src.accountId) ||
    (typeof src.user === "string" && src.user) ||
    (typeof src.metadata?.email === "string" && src.metadata.email) ||
    (typeof src.metadata?.user === "string" && src.metadata.user) ||
    (typeof src.metadata?.site === "string" && src.metadata.site) ||
    (typeof src.enterpriseUrl === "string" && src.enterpriseUrl) ||
    "";
  const hint =
    (typeof src.enterpriseUrl === "string" && src.enterpriseUrl) ||
    (typeof src.metadata?.site === "string" && src.metadata.site) ||
    "";
  return { displayName, hint };
}

function normalizeAuthResult(r, apiKey, methodObj, inputs) {
  if (!r || r.type !== "success") return null;
  if ("refresh" in r || typeof r.access === "string") {
    const { type: _t, provider: _p, ...rest } = r;
    return { type: "oauth", refresh: typeof rest.refresh === "string" ? rest.refresh : "", ...rest };
  }
  if ("key" in r || apiKey) {
    const plain = {};
    const prompts = Array.isArray(methodObj?.prompts) ? methodObj.prompts : [];
    for (const [k, v] of Object.entries(inputs ?? {})) {
      if (prompts.some((p) => p?.key === k && p.type === "select")) plain[k] = v;
    }
    const md = { ...plain, ...(r.metadata && typeof r.metadata === "object" ? r.metadata : {}) };
    return { type: "api", key: r.key ?? apiKey, ...(Object.keys(md).length ? { metadata: md } : {}) };
  }
  return null;
}

function normalizeUsage(u) {
  if (!u || typeof u !== "object") return { windows: [] };
  const text = (v) => (typeof v === "string" ? v.trim() : "");
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const when = (v) => {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
    if (typeof v === "string" && v.trim()) {
      const parsed = Date.parse(v);
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : v.trim();
    }
    return undefined;
  };
  const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : undefined);
  return {
    ...(text(u.plan) ? { plan: text(u.plan) } : {}),
    ...(text(u.user) ? { user: text(u.user) } : {}),
    ...(when(u.until) ? { until: when(u.until) } : {}),
    ...(u.renew === "auto" || u.renew === "off" ? { renew: u.renew } : {}),
    ...(text(u.balance) ? { balance: text(u.balance) } : {}),
    ...(text(u.error) ? { error: text(u.error) } : {}),
    ...(typeof u.signIn === "string" && ["expired", "kept", "renewed"].includes(u.signIn) ? { signIn: u.signIn } : {}),
    ...(u.resets && typeof u.resets === "object"
      ? {
          resets: {
            count: num(u.resets.count),
            ...(when(u.resets.until) ? { until: when(u.resets.until) } : {}),
            ...(u.resets.byWindow ? { byWindow: true } : {}),
            ...(num(u.resets.fiveHour) ? { fiveHour: num(u.resets.fiveHour) } : {}),
            ...(num(u.resets.weekly) ? { weekly: num(u.resets.weekly) } : {}),
            ...(u.resets.team ? { team: true } : {}),
          },
        }
      : {}),
    windows: (Array.isArray(u.windows) ? u.windows : []).map((w) => ({
      name: text(w?.name),
      used: w?.used == null ? null : Math.max(0, num(w?.used)),
      ...(when(w?.resetsAt) ? { resetsAt: when(w?.resetsAt) } : {}),
      ...(num(w?.resetSecs) > 0 ? { resetSecs: Math.round(num(w?.resetSecs)) } : {}),
      ...(text(w?.display) ? { display: text(w?.display) } : {}),
      ...(num(w?.amount) > 0 ? { amount: num(w?.amount) } : {}),
      ...(num(w?.limit) > 0 ? { limit: num(w?.limit) } : {}),
      ...(text(w?.unit) ? { unit: text(w?.unit) } : {}),
      ...(num(w?.span) > 0 ? { span: num(w?.span) } : {}),
      ...(text(w?.model) ? { model: text(w?.model) } : {}),
      ...(ids(w?.models)?.length ? { models: ids(w?.models) } : {}),
      ...(w?.aside ? { aside: true } : {}),
      ...(typeof w?.balance === "number" && Number.isFinite(w.balance) ? { balance: Math.max(0, w.balance) } : {}),
    })),
  };
}

// ---- RPC 处理器 ------------------------------------------------------------

const handlers = {
  async init(params) {
    pluginRegistry.clear();
    loaderCache.clear();
    const list = Array.isArray(params?.plugins) ? params.plugins : [];
    const results = await Promise.all(list.map((item) => loadSinglePlugin(item)));
    return { plugins: results };
  },

  async models(params, signal) {
    const p = getProvider(params.pluginId, params.provider);
    const seedModels = params.seedModels && typeof params.seedModels === "object" ? params.seedModels : {};
    const providerArg = clone({
      id: p.providerId,
      name: p.config?.name ?? p.providerId,
      npm: p.config?.npm ?? "",
      api: p.config?.api ?? "",
      options: p.config?.options ?? {},
      models: { ...seedModels, ...(p.config?.models ?? {}) },
    });
    if (typeof p.modelsHook !== "function") {
      return { models: normalizeModelsRecord(p.config?.models ?? {}, p.config), dynamic: false };
    }
    const raw = await runInScope(params.pluginId, params.provider, params.accountId, params.auth, () =>
      bounded(
        p.modelsHook(providerArg, { auth: clone(params.auth), signal }),
        signal,
        LIST_TIMEOUT_MS,
      ),
    );
    if (!raw || typeof raw !== "object") {
      throw new Error(`${p.providerId} 的模型列表钩子没有返回模型对象`);
    }
    return { models: normalizeModelsRecord(raw, p.config), dynamic: true };
  },

  async prompt(params) {
    const p = getProvider(params.pluginId, params.provider);
    const m = p.auth.methods?.[params.method];
    if (!m) throw new Error(`找不到登录方式 #${params.method}`);
    const inputs = params.inputs && typeof params.inputs === "object" ? params.inputs : {};
    if (typeof m.ask === "function") {
      return { prompt: (await m.ask(inputs)) ?? null };
    }
    for (const q of m.prompts ?? []) {
      if (q.key in inputs) continue;
      if (!appliesPrompt(q, inputs)) continue;
      return {
        prompt: {
          type: q.type === "select" ? "select" : "text",
          key: q.key,
          message: q.message ?? q.key,
          ...(q.messages && typeof q.messages === "object" ? { messages: q.messages } : {}),
          ...(q.placeholder ? { placeholder: q.placeholder } : {}),
          ...(q.type === "select" && Array.isArray(q.options)
            ? {
                options: q.options.map((o) => ({
                  label: o.label ?? o.value,
                  value: o.value,
                  ...(o.hint ? { hint: o.hint } : {}),
                  ...(o.labels ? { labels: o.labels } : {}),
                  ...(o.hints ? { hints: o.hints } : {}),
                })),
              }
            : {}),
        },
      };
    }
    return { prompt: null };
  },

  validatePrompt(params) {
    const p = getProvider(params.pluginId, params.provider);
    const m = p.auth.methods?.[params.method];
    const q = (m?.prompts ?? []).find((x) => x.key === params.key);
    if (!q || typeof q.validate !== "function") return { error: null };
    return { error: q.validate(params.value) ?? null };
  },

  async apiKey(params, signal) {
    const p = getProvider(params.pluginId, params.provider);
    const m = p.auth.methods?.[params.method];
    if (!m || m.type !== "api") throw new Error("不是 API 密钥登录方式");
    const inputs = params.inputs && typeof params.inputs === "object" ? params.inputs : {};
    if (typeof m.authorize !== "function") {
      if (!params.key) return { ok: false, error: "请填写 API 密钥" };
      const plain = {};
      for (const [k, v] of Object.entries(inputs)) {
        if ((m.prompts ?? []).some((q) => q?.key === k && q.type === "select")) plain[k] = v;
      }
      const auth = { type: "api", key: params.key, ...(Object.keys(plain).length ? { metadata: plain } : {}) };
      return { ok: true, provider: p.providerId, auth, accountInfo: extractAccountInfo(auth, auth) };
    }
    const r = await runInScope(params.pluginId, params.provider, params.accountId, params.auth, () =>
      bounded(m.authorize(inputs, { signal }), signal),
    );
    if (signal?.aborted) throw new DOMException("登录已取消", "AbortError");
    if (!r || r.type !== "success") {
      const err = typeof r?.error === "string" && r.error.trim() ? r.error.trim().slice(0, 500) : "登录失败";
      return { ok: false, error: err };
    }
    const auth = normalizeAuthResult(r, params.key, m, inputs);
    if (!auth) return { ok: false, error: "插件登录成功但未返回凭据" };
    return {
      ok: true,
      provider: typeof r.provider === "string" && r.provider ? r.provider : p.providerId,
      auth,
      accountInfo: extractAccountInfo(r, auth),
    };
  },

  async authorize(params, signal) {
    const p = getProvider(params.pluginId, params.provider);
    const m = p.auth.methods?.[params.method];
    if (!m || m.type !== "oauth") throw new Error("不是 OAuth 登录方式");
    const inputs = params.inputs && typeof params.inputs === "object" ? params.inputs : {};
    const arg = m.prompts?.length ? inputs : undefined;
    const a = await runInScope(params.pluginId, params.provider, params.accountId, params.auth, () =>
      bounded(m.authorize(arg, { signal }), signal),
    );
    if (signal?.aborted) throw new DOMException("登录已取消", "AbortError");
    if (a?.type === "failed") {
      const err = typeof a.error === "string" && a.error.trim() ? a.error.trim().slice(0, 500) : "无法发起登录";
      return { ok: false, error: err };
    }
    if (typeof a?.callback !== "function") {
      return { ok: false, error: `${p.providerId} 的登录未返回回调函数` };
    }
    const session = String(nextSessionSeq++);
    signInSessions.set(session, {
      pluginId: params.pluginId,
      providerId: params.provider,
      accountId: params.accountId ?? "",
      auth: params.auth,
      a,
      inputs,
      methodObj: m,
    });
    return {
      ok: true,
      session,
      url: typeof a.url === "string" ? a.url : "",
      instructions: typeof a.instructions === "string" ? a.instructions : "",
      method: a.method === "code" ? "code" : "auto",
      opened: a.opened === true,
    };
  },

  async callback(params, signal) {
    const s = signInSessions.get(params.session);
    if (!s) throw new Error("登录会话不存在或已结束");
    signInSessions.delete(params.session);
    const r = await runInScope(s.pluginId, s.providerId, s.accountId, s.auth, () =>
      bounded(
        s.a.method === "code" ? s.a.callback(params.code ?? "", { signal }) : s.a.callback(undefined, { signal }),
        signal,
      ),
    );
    if (signal?.aborted) throw new DOMException("登录已取消", "AbortError");
    if (!r || r.type !== "success") {
      const err = typeof r?.error === "string" && r.error.trim() ? r.error.trim().slice(0, 500) : "登录未完成或被拒绝";
      return { ok: false, error: err };
    }
    const auth = normalizeAuthResult(r, undefined, s.methodObj, s.inputs);
    if (!auth) return { ok: false, error: `${s.providerId} 登录成功但未返回可保存的凭据` };
    return {
      ok: true,
      provider: typeof r.provider === "string" && r.provider ? r.provider : s.providerId,
      auth,
      accountInfo: extractAccountInfo(r, auth),
    };
  },

  async cliStatus(params) {
    const p = getProvider(params.pluginId, params.provider);
    const meta = cliMetaOf(p.auth);
    if (!meta) return { declared: false };
    try {
      const installed = (await p.auth.cli.installed()) === true;
      return { declared: true, name: meta.name, ...(meta.manual ? { manual: meta.manual } : {}), installed };
    } catch (error) {
      return { declared: true, name: meta.name, ...(meta.manual ? { manual: meta.manual } : {}), installed: false, error: error instanceof Error ? error.message : String(error) };
    }
  },

  async cliInstall(params, signal) {
    const p = getProvider(params.pluginId, params.provider);
    const meta = cliMetaOf(p.auth);
    if (!meta) throw new Error(`${p.providerId} 未声明可自动安装的 CLI`);
    await bounded(p.auth.cli.install({ signal }), signal);
    if (signal?.aborted) throw new DOMException("安装已取消", "AbortError");
    const installed = (await p.auth.cli.installed()) === true;
    return { installed };
  },

  async load(params) {
    const p = getProvider(params.pluginId, params.provider);
    const opts = await runInScope(params.pluginId, params.provider, params.accountId, params.auth, () =>
      resolveLoaderOptions(p, params.accountId, params.auth, params.seedProvider),
    );
    return {
      baseURL: typeof opts.baseURL === "string" ? opts.baseURL : "",
      apiKey: typeof opts.apiKey === "string" ? opts.apiKey : "",
      headers: opts.headers && typeof opts.headers === "object" ? opts.headers : {},
      hasFetch: typeof opts.fetch === "function",
    };
  },

  async refresh(params, signal) {
    const p = getProvider(params.pluginId, params.provider);
    if (typeof p.auth.refresh !== "function") return { refreshed: false };
    const providerArg = clone({
      id: p.providerId,
      name: p.config?.name ?? p.providerId,
      npm: p.config?.npm ?? "",
      api: p.config?.api ?? "",
      options: p.config?.options ?? {},
      models: p.config?.models ?? {},
    });
    try {
      const fields = await runInScope(params.pluginId, params.provider, params.accountId, params.auth, () =>
        bounded(p.auth.refresh(clone(params.auth), providerArg), signal, 20_000),
      );
      if (!fields || typeof fields !== "object") return { refreshed: false };
      const updated = { ...clone(params.auth), ...fields, type: "oauth" };
      loaderCache.delete(`${p.pluginId}\0${p.providerId}\0${params.accountId || ""}`);
      return { refreshed: true, auth: updated };
    } catch (error) {
      const signIn = error && typeof error === "object" && ["expired", "kept", "renewed"].includes(error.signIn) ? error.signIn : undefined;
      return {
        refreshed: false,
        error: error instanceof Error ? error.message : String(error),
        ...(signIn ? { signIn } : {}),
      };
    }
  },

  async usage(params, signal) {
    const p = getProvider(params.pluginId, params.provider);
    if (typeof p.auth.usage !== "function") throw new Error(`${p.providerId} 不支持额度查询`);
    const providerArg = clone({
      id: p.providerId,
      name: p.config?.name ?? p.providerId,
      npm: p.config?.npm ?? "",
      api: p.config?.api ?? "",
      options: p.config?.options ?? {},
      models: p.config?.models ?? {},
    });
    const raw = await runInScope(params.pluginId, params.provider, params.accountId, params.auth, () =>
      bounded(
        p.auth.usage(async () => clone(scopeStorage.getStore()?.auth ?? params.auth), providerArg, { signal }),
        signal,
        20_000,
      ),
    );
    return normalizeUsage(raw);
  },

  invalidateAccount(params) {
    if (params.accountId) {
      loaderCache.delete(`${params.pluginId}\0${params.provider}\0${params.accountId}`);
    } else {
      const prefix = `${params.pluginId}\0${params.provider}\0`;
      for (const k of [...loaderCache.keys()]) if (k.startsWith(prefix)) loaderCache.delete(k);
    }
    return null;
  },
};

// ---- 流式 Fetch ------------------------------------------------------------

async function handleFetch(id, params, signal) {
  const p = getProvider(params.pluginId, params.provider);
  await runInScope(params.pluginId, params.provider, params.accountId, params.auth, async () => {
    const opts = await resolveLoaderOptions(p, params.accountId, params.auth, params.seedProvider);
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");

    const h = new Headers();
    for (const [k, v] of Object.entries(sdkHeaders(params.npm, opts.apiKey))) h.set(k, v);
    for (const [k, v] of Object.entries(opts.headers ?? {})) h.set(k, String(v));
    for (const [k, v] of Object.entries(params.headers ?? {})) h.set(k, String(v));

    if (p.chatHeaderHooks.length) {
      const providerInfo = {
        id: p.providerId,
        name: p.config?.name ?? p.providerId,
        npm: p.config?.npm ?? "",
        api: p.config?.api ?? "",
        models: p.config?.models ?? {},
      };
      const modelInfo = providerInfo.models[params.model] ?? {
        id: params.model,
        providerID: p.providerId,
        api: { id: params.model, npm: params.npm ?? "" },
      };
      for (const hook of p.chatHeaderHooks) {
        const out = { headers: {} };
        try {
          await hook.fn(
            {
              sessionID: params.session ?? "",
              agent: "build",
              model: modelInfo,
              provider: { source: "custom", info: providerInfo, options: opts },
              message: {
                id: "",
                sessionID: params.session ?? "",
                role: "user",
                time: { created: Date.now() },
                agent: "build",
                model: { providerID: p.providerId, modelID: params.model },
              },
            },
            out,
          );
          for (const [k, v] of Object.entries(out.headers ?? {})) h.set(k, String(v));
        } catch (error) {
          send({ event: "log", pluginId: params.pluginId, level: "error", message: `${hook.spec}: chat.headers: ${error instanceof Error ? error.message : String(error)}` });
        }
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      }
    }

    const fetchFn = typeof opts.fetch === "function" ? opts.fetch : fetch;
    const body = params.bodyBase64 ? Buffer.from(params.bodyBase64, "base64") : undefined;
    const res = await fetchFn(params.url, {
      method: params.method ?? "POST",
      headers: h,
      ...(body !== undefined ? { body } : {}),
      signal,
    });
    if (signal.aborted) {
      await res.body?.cancel?.().catch(() => {});
      throw new DOMException("Aborted", "AbortError");
    }

    const rh = {};
    res.headers.forEach((v, k) => {
      rh[k] = v;
    });
    await send({ id, event: "head", status: res.status, headers: rh });

    if (res.body) {
      const reader = res.body.getReader();
      try {
        while (true) {
          if (signal.aborted) {
            await reader.cancel().catch(() => {});
            throw new DOMException("Aborted", "AbortError");
          }
          const { done, value } = await reader.read();
          if (done) break;
          const bytes = Buffer.isBuffer(value)
            ? value
            : ArrayBuffer.isView(value)
              ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
              : Buffer.from(value);
          for (let off = 0; off < bytes.length; off += MAX_CHUNK_BYTES) {
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            const slice = bytes.subarray(off, Math.min(off + MAX_CHUNK_BYTES, bytes.length));
            await send({ id, event: "chunk", data: slice.toString("base64") });
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    await send({ id, result: null });
  });
}

// ---- 主循环 ----------------------------------------------------------------

const inflight = new Map(); // id -> AbortController
let pending = 0;
let stdinClosed = false;

const done = () => {
  if (--pending === 0 && stdinClosed) process.exit(0);
};

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.method === "abort") {
    const ctl = inflight.get(msg.params?.id);
    if (ctl) ctl.abort();
    return;
  }
  const id = msg.id;
  const ctl = new AbortController();
  inflight.set(id, ctl);
  pending++;

  if (msg.method === "fetch") {
    requestStorage.run(id, () => handleFetch(id, msg.params ?? {}, ctl.signal))
      .catch((error) => {
        const signIn = error && typeof error === "object" && ["expired", "kept", "renewed"].includes(error.signIn) ? error.signIn : undefined;
        return send({
          id,
          error: {
            message: error instanceof Error ? error.message : String(error),
            ...(signIn ? { signIn } : {}),
          },
        });
      })
      .finally(() => {
        inflight.delete(id);
        done();
      });
    return;
  }

  const handler = handlers[msg.method];
  if (!handler) {
    send({ id, error: { message: `未知方法：${msg.method}` } }).finally(() => {
      inflight.delete(id);
      done();
    });
    return;
  }

  requestStorage.run(id, () => Promise.resolve()
    .then(() => handler(msg.params ?? {}, ctl.signal))
    .then(
      (result) => send({ id, result }),
      (error) => {
        const signIn = error && typeof error === "object" && ["expired", "kept", "renewed"].includes(error.signIn) ? error.signIn : undefined;
        return send({
          id,
          error: {
            message: error instanceof Error ? error.message : String(error),
            ...(signIn ? { signIn } : {}),
          },
        });
      },
    )
    .finally(() => {
      inflight.delete(id);
      done();
    }));
});

rl.on("close", () => {
  stdinClosed = true;
  for (const ctl of inflight.values()) ctl.abort();
  if (pending === 0) process.exit(0);
});
