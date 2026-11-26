import type { Page } from "playwright-core";
import { t } from "../../shared/i18n.ts";
import type { Approval, ApprovalOption, FillLoginApproval, FillLoginCandidate, LoginAutoEntry, LoginEntryApproval } from "../../shared/types.ts";
import type { HobRuntime } from "./runtime.ts";
import { DesktopToolSession, rememberFilledSecret } from "./desktop-tools.ts";
import { readLoginAuto, saveLoginAuto } from "./login-auto.ts";

/**
 * login 工具看过当前页面和密码管理器以后的决定。该出哪张卡只有 Hob 知道（页面上有什么框、密码管理器里有没有这个网站），模型只管「登录这个网站」：
 * - approval：存了账号、网址对得上 → 批准卡；entry：没存 → 录入卡；self：只能用户本人完成（验证码、扫码、第三方账号）→ 自己登录卡；
 * - message / failed：直接回模型一句话；mismatch：有候选但页面对不上（仿冒页），出「没有填写密码」卡。
 */
export type LoginPreparation =
  | { kind: "message"; text: string }
  | { kind: "failed"; text: string }
  | { kind: "mismatch"; text: string; approval: FillLoginApproval }
  | { kind: "approval"; approval: FillLoginApproval; title: string; detail: string }
  | { kind: "entry"; approval: LoginEntryApproval; title: string; detail: string }
  | { kind: "self"; title: string };

export type LoginCredentials = { username: string; password: string };
export type FillLoginResult = { kind: "filled" | "username"; host: string; username: string; text: string };

export type InputInfo = { index: number; type: string; autocomplete: string; name: string; id: string; value: string; beforePassword: boolean };
export type PageInfo = { url: string; host: string; inputs: InputInfo[]; usernameIndex?: number; passwordIndex?: number; otpIndex?: number };

const RECENT_MS = 10 * 60 * 1000;
/** 10 分钟内批准过（或两步登录填过用户名）的提供者条目 + 主机 → 到期时间 */
const recentAllowed = new WeakMap<HobRuntime, Map<string, number>>();
/** 同一个助手对同一主机报过「没有账号密码框」的时间：10 分钟内第二次就不再回这句话，改出自己登录卡 */
const noFieldsSeen = new WeakMap<HobRuntime, Map<string, number>>();

function hostOf(value: string): string | undefined {
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    return parsed.hostname.toLowerCase().replace(/\.$/, "") || undefined;
  } catch {
    return undefined;
  }
}

export function hostsMatch(pageHost: string, savedHost: string): boolean {
  const page = pageHost.toLowerCase().replace(/\.$/, "");
  const saved = savedHost.toLowerCase().replace(/\.$/, "");
  return page === saved || page.endsWith(`.${saved}`);
}

function candidateKey(candidate: Pick<FillLoginCandidate, "provider" | "id">): string {
  return `${candidate.provider}:${candidate.id}`;
}

function autoFor(home: string, candidate: FillLoginCandidate, host: string): LoginAutoEntry | undefined {
  return readLoginAuto(home).find((entry) => entry.provider === candidate.provider && entry.itemId === candidate.id && entry.host === host && entry.username === candidate.username);
}

function markRecent(runtime: HobRuntime, candidate: Pick<FillLoginCandidate, "provider" | "id">, host: string): void {
  let entries = recentAllowed.get(runtime);
  if (!entries) recentAllowed.set(runtime, entries = new Map());
  entries.set(`${candidateKey(candidate)}:${host}`, Date.now() + RECENT_MS);
}

function recentFor(runtime: HobRuntime, candidate: Pick<FillLoginCandidate, "provider" | "id">, host: string): boolean {
  const entries = recentAllowed.get(runtime);
  const key = `${candidateKey(candidate)}:${host}`;
  const until = entries?.get(key) ?? 0;
  if (until < Date.now()) entries?.delete(key);
  return until >= Date.now();
}

/** 这是不是这个助手 10 分钟内第二次在同一主机上找不到账号密码框：第一次只记下，第二次才算 */
function noFieldsAgain(runtime: HobRuntime, assistantId: string, host: string): boolean {
  let entries = noFieldsSeen.get(runtime);
  if (!entries) noFieldsSeen.set(runtime, entries = new Map());
  const key = `${assistantId}:${host}`;
  const until = entries.get(key) ?? 0;
  entries.set(key, Date.now() + RECENT_MS);
  return until >= Date.now();
}

export async function pageInfo(page: Page): Promise<PageInfo> {
  const url = page.url();
  const host = hostOf(url);
  if (!host) throw new Error(`当前页面（${url}）没有网站地址。先打开登录页再调 login。`);
  // index 是在页面全部 input 里的位置（含隐藏的），填写时用 locator("input").nth(index) 按它找回同一个框
  const inputs = await page.locator("input").evaluateAll((elements) => elements.flatMap((element, index) => {
    const input = element as HTMLInputElement;
    const style = window.getComputedStyle(input);
    if (input.type === "hidden" || input.disabled || style.display === "none" || style.visibility === "hidden" || input.getClientRects().length === 0) return [];
    return [{ type: input.type.toLowerCase(), autocomplete: input.autocomplete.toLowerCase(), name: input.name.toLowerCase(), id: input.id.toLowerCase(), value: input.type.toLowerCase() === "password" ? "" : input.value, index }];
  }));
  const password = inputs.find((input) => input.type === "password" && input.autocomplete === "current-password") ?? inputs.find((input) => input.type === "password");
  const passwordIndex = password?.index;
  const usernameCandidates = inputs.filter((input) => input.type === "email" || input.autocomplete === "username" || /user|email|login|account/i.test(`${input.name} ${input.id} ${input.type}`));
  const before = inputs.filter((input) => input.type === "text" || input.type === "email").filter((input) => passwordIndex === undefined || input.index < passwordIndex);
  const username = usernameCandidates.find((input) => input.autocomplete === "username" || input.type === "email") ?? usernameCandidates.at(-1) ?? before.at(-1);
  // 验证码框：浏览器标了 one-time-code，或者 name/id 叫 otp、totp、2fa、mfa、verification、code（页面上没有密码框时才算）
  const otp = inputs.find((input) => input.autocomplete === "one-time-code")
    ?? (password === undefined ? inputs.find((input) => /otp|totp|2fa|mfa|verification|code/.test(`${input.name} ${input.id}`)) : undefined);
  return { url, host, inputs: inputs.map((input) => ({ ...input, beforePassword: passwordIndex === undefined || input.index < passwordIndex })), ...(username ? { usernameIndex: username.index } : {}), ...(password ? { passwordIndex } : {}), ...(otp ? { otpIndex: otp.index } : {}) };
}

export async function inspectCurrentPage(runtime: HobRuntime, assistantId: string): Promise<PageInfo> {
  const session = new DesktopToolSession(runtime, assistantId);
  try { return await session.withCurrentPage(pageInfo); }
  finally { await session.dispose(); }
}

const inspect = inspectCurrentPage;

function listUris(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export async function credentialCandidates(runtime: HobRuntime, assistantId: string, site: string, account?: string): Promise<FillLoginCandidate[]> {
  const providers = runtime.plugins.credentialProviders(assistantId, "list");
  const query = site.trim().toLowerCase();
  const queryHost = hostOf(site.trim());
  const result: Array<FillLoginCandidate & { exact: boolean }> = [];
  for (const provider of providers) {
    const value = await runtime.plugins.callCredential(provider, {});
    const logins = Array.isArray(value.logins) ? value.logins : [];
    for (const item of logins) {
      if (!item || typeof item !== "object") continue;
      const login = item as Record<string, unknown>;
      const name = typeof login.name === "string" ? login.name : "";
      const username = typeof login.username === "string" ? login.username : "";
      const uris = listUris(login.uris);
      const nameMatch = name.toLowerCase().includes(query);
      // site 是网址时：保存的主机名和它相同，或者是它的父域名 / 子域名（页面 login.example.net 对保存的 example.net）；
      // 主机名完全一样的排在前面，批准卡上默认选中的就是它
      const savedHosts = uris.map(hostOf).filter((host): host is string => host !== undefined);
      const exact = queryHost !== undefined && savedHosts.includes(queryHost);
      const uriMatch = queryHost !== undefined && savedHosts.some((saved) => saved === queryHost || queryHost.endsWith(`.${saved}`) || saved.endsWith(`.${queryHost}`));
      if (!nameMatch && !uriMatch) continue;
      if (account && !username.toLowerCase().includes(account.trim().toLowerCase())) continue;
      result.push({
        exact,
        provider: provider.pluginId,
        providerName: provider.providerName,
        id: typeof login.id === "string" ? login.id : String(login.id ?? ""),
        name,
        username,
        ...(typeof login.folder === "string" && login.folder ? { folder: login.folder } : {}),
        uris,
      });
    }
  }
  return result.filter((candidate) => candidate.id).sort((a, b) => Number(b.exact) - Number(a.exact)).map(({ exact: _exact, ...candidate }) => candidate);
}

function matchingCandidates(candidates: FillLoginCandidate[], host: string): FillLoginCandidate[] {
  return candidates.filter((candidate) => candidate.uris.some((uri) => {
    const saved = hostOf(uri);
    return saved !== undefined && hostsMatch(host, saved);
  }));
}

function approvalDetail(candidates: FillLoginCandidate[]): string {
  const names = [...new Set(candidates.map((candidate) => candidate.providerName))];
  return `Hob 从 ${names.join("、")} 取出密码，直接填进登录页，助手看不到。`;
}

function selfTitle(site: string): string {
  return t("需要登录：{site}", { site });
}

/** 页面上没有账号密码框时回模型的那句。 */
function noFieldsText(info: PageInfo): string {
  return `当前页面（${info.url}）上没有账号密码框。先打开登录表单再调 login；这个网站只能用扫码、第三方账号这类方式登录的话，再调一次 login，Hob 会请用户自己登录。`;
}

/** 录入卡存到哪：自带密码库（id 是 vault）排第一当默认，其余照插件顺序；同一个插件只列一次。 */
function entryProviders(runtime: HobRuntime, assistantId: string): LoginEntryApproval["providers"] {
  const seen = new Set<string>();
  return runtime.plugins.credentialProviders(assistantId, "save")
    .sort((a, b) => Number(b.pluginId === "vault") - Number(a.pluginId === "vault"))
    .flatMap(({ pluginId, providerName }) => seen.has(pluginId) ? [] : (seen.add(pluginId), [{ provider: pluginId, providerName }]));
}

export async function prepareLogin(runtime: HobRuntime, assistantId: string, site: string, account?: string, self = false): Promise<LoginPreparation> {
  if (self || !runtime.plugins.hasCredentialProvider(assistantId)) return { kind: "self", title: selfTitle(site) };
  const info = await inspect(runtime, assistantId);
  // 验证码这类只能用户本人填的页面：存没存账号都请用户自己登录
  if (info.otpIndex !== undefined) return { kind: "self", title: selfTitle(site) };
  const candidates = await credentialCandidates(runtime, assistantId, site, account);
  const matched = matchingCandidates(candidates, info.host);
  if (candidates.length && !matched.length) {
    const savedHosts = [...new Set(candidates.flatMap((candidate) => candidate.uris.map(hostOf).filter((host): host is string => Boolean(host))))];
    return {
      kind: "mismatch",
      text: `没有填写：当前页面是 ${info.host}，和密码管理器里保存的网址（${savedHosts.join("、")}）对不上，可能是仿冒的页面。把情况告诉用户。`,
      approval: { host: info.host, currentHost: info.host, candidates, state: "mismatch" },
    };
  }
  const hasFields = info.usernameIndex !== undefined || info.passwordIndex !== undefined;
  if (matched.length) {
    // 出卡之前就看清页面上有没有能填的框：只有搜索框之类的页面不该让用户白批一次
    if (!hasFields) return noFieldsAgain(runtime, assistantId, info.host) ? { kind: "self", title: selfTitle(site) } : { kind: "message", text: noFieldsText(info) };
    const auto = matched.filter((candidate) => autoFor(runtime.home, candidate, info.host) || recentFor(runtime, candidate, info.host));
    if (auto.length === 1) {
      try { return { kind: "message", text: (await fillCandidate(runtime, assistantId, auto[0]!, info.host)).text }; }
      catch (error) { return { kind: "failed", text: `没有填写：${error instanceof Error ? error.message : String(error)}` }; }
    }
    return { kind: "approval", approval: { host: info.host, candidates: matched, state: "pending" }, title: `在 ${info.host} 登录`, detail: approvalDetail(matched) };
  }
  // 密码管理器里没有这个网站：有能填的框、又有能存的提供者，就请用户在卡上填一次
  const providers = entryProviders(runtime, assistantId);
  if (hasFields && providers.length) {
    return { kind: "entry", approval: { host: info.host, ...(account ? { account } : {}), providers, state: "pending" }, title: `在 ${info.host} 登录`, detail: entryDetail(providers[0]!.providerName) };
  }
  // 没有框：第一次让助手先打开登录表单；10 分钟内又来（助手看过页面，确认只能用别的方式登录）就请用户自己登录；没有能存的提供者时直接请用户自己登录
  if (!hasFields) return providers.length && !noFieldsAgain(runtime, assistantId, info.host) ? { kind: "message", text: noFieldsText(info) } : { kind: "self", title: selfTitle(site) };
  return { kind: "self", title: selfTitle(site) };
}

export function entryDetail(providerName: string): string {
  return `密码管理器里还没有这个网站的账号。在这里填一次，Hob 存进${providerName}再填进登录页，助手看不到。`;
}

/** 出卡的三种情况和回模型的那句（结束这一轮）。 */
export function loginCard(prepared: Exclude<LoginPreparation, { kind: "message" | "failed" | "mismatch" }>, site: string, reason: string): { title: string; detail?: string; options: ApprovalOption[]; login: NonNullable<Approval["login"]>; endTurn: string } {
  if (prepared.kind === "approval") {
    return {
      title: prepared.title,
      detail: prepared.detail,
      options: [{ key: "A", label: "不允许" }, { key: "B", label: "这次允许" }, { key: "C", label: "这个网站以后都允许", always: true }],
      login: { site, reason, fillLogin: prepared.approval },
      endTurn: `已请用户批准在 ${prepared.approval.host} 填写登录，这一轮先到这里；用户批准后 Hob 会填好并告诉你。`,
    };
  }
  if (prepared.kind === "entry") {
    return {
      title: prepared.title,
      detail: prepared.detail,
      options: [{ key: "A", label: "不登录" }, { key: "B", label: "保存并登录" }],
      login: { site, reason, entry: prepared.approval },
      endTurn: `密码管理器里没有 ${prepared.approval.host} 的账号，已请用户在卡片上填写，这一轮先到这里；用户填好后 Hob 会存进密码管理器、填进页面并告诉你。`,
    };
  }
  return {
    title: prepared.title,
    detail: reason,
    options: [{ key: "A", label: "已登录" }],
    login: { site, reason },
    endTurn: `已请用户在云桌面里自己登录 ${site}，这一轮先到这里；用户登录完会告诉你。`,
  };
}

async function visibleInputIndices(page: Page): Promise<{ inputs: InputInfo[]; usernameIndex?: number; passwordIndex?: number }> {
  const info = await pageInfo(page);
  return { inputs: info.inputs, ...(info.usernameIndex === undefined ? {} : { usernameIndex: info.usernameIndex }), ...(info.passwordIndex === undefined ? {} : { passwordIndex: info.passwordIndex }) };
}

/** 错误原因里不能带出密码：取到的密码和页面上的值都可能出现在浏览器的报错里。 */
export function hideSecrets(error: unknown, secrets: string[]): string {
  return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join("[已隐藏]"), error instanceof Error ? error.message : String(error));
}

/**
 * 把账号和密码填进当前页面：填之前再核对一次网址（用户批准期间页面可能跳走），对不上按仿冒页处理。
 * credentials 在核对通过以后才取，密码只在这次调用的内存里经过。
 */
export async function fillLoginPage(runtime: HobRuntime, assistantId: string, candidate: Pick<FillLoginCandidate, "provider" | "id" | "providerName" | "uris">, host: string, credentials: () => Promise<LoginCredentials>): Promise<FillLoginResult> {
  const session = new DesktopToolSession(runtime, assistantId);
  let password = "";
  try {
    return await session.withCurrentPage(async (page) => {
      const current = await pageInfo(page);
      if (current.host !== host || !candidate.uris.some((uri) => { const saved = hostOf(uri); return saved && hostsMatch(current.host, saved); })) {
        throw new Error(`当前页面是 ${current.host}，和保存的网址对不上，可能是仿冒的页面。`);
      }
      const fields = await visibleInputIndices(page);
      if (fields.usernameIndex === undefined && fields.passwordIndex === undefined) throw new Error(`当前页面（${current.url}）上没有找到登录框。先打开登录表单再调 login。`);
      const secret = await credentials();
      const username = secret.username;
      password = secret.password;
      if (!password && fields.passwordIndex !== undefined) throw new Error("密码管理器没有存密码。");
      if (fields.usernameIndex !== undefined) await page.locator("input").nth(fields.usernameIndex).fill(username);
      if (fields.passwordIndex === undefined) {
        markRecent(runtime, candidate, host);
        return { kind: "username", host, username, text: `已在 ${host} 填好用户名 ${username}，点下一步后再调一次 login 填密码。` };
      }
      await page.locator("input").nth(fields.passwordIndex).fill(password);
      rememberFilledSecret(runtime, assistantId, password);
      return { kind: "filled", host, username, text: `已在 ${host} 填好 ${username} 的账号和密码，接下来点登录按钮。` };
    });
  } catch (error) {
    throw new Error(hideSecrets(error, [password]));
  } finally { await session.dispose(); }
}

export async function fillCandidate(runtime: HobRuntime, assistantId: string, candidate: FillLoginCandidate, host: string): Promise<FillLoginResult> {
  const provider = runtime.plugins.credentialProviders(assistantId, "secret").find((item) => item.pluginId === candidate.provider);
  if (!provider) throw new Error(`${candidate.providerName} 的凭据工具现在不可用。`);
  return fillLoginPage(runtime, assistantId, candidate, host, async () => {
    const secret = await runtime.plugins.callCredential(provider, { id: candidate.id });
    return { username: typeof secret.username === "string" && secret.username ? secret.username : candidate.username, password: typeof secret.password === "string" ? secret.password : "" };
  });
}

export function candidateId(candidate: FillLoginCandidate): string { return candidateKey(candidate); }
export function rememberAutoLogin(runtime: HobRuntime, candidate: FillLoginCandidate, host: string): LoginAutoEntry {
  return saveLoginAuto(runtime.home, { provider: candidate.provider, itemId: candidate.id, host, username: candidate.username });
}
