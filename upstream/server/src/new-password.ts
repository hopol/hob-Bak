import type { FillLoginCandidate, FillNewPasswordApproval, PasswordCharacter } from "../../shared/types.ts";
import type { HobRuntime } from "./runtime.ts";
import { credentialCandidates, hostsMatch, inspectCurrentPage, pageInfo, type PageInfo } from "./login.ts";
import { DesktopToolSession, rememberFilledSecret } from "./desktop-tools.ts";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const MAX_RECENT_AGE = 30 * 60 * 1000;
const recentFileName = (home: string) => join(home, "system", "new-password.json");

type RecentPasswordSave = {
  provider: string;
  itemId: string;
  host: string;
  username: string;
  name: string;
  folder?: string;
  at: string;
};

function readRecent(home: string): RecentPasswordSave[] {
  try {
    const value = JSON.parse(readFileSync(recentFileName(home), "utf8"));
    return Array.isArray(value) ? value.filter((item): item is RecentPasswordSave => !!item && typeof item === "object" && typeof item.provider === "string" && typeof item.itemId === "string" && typeof item.host === "string" && typeof item.username === "string" && typeof item.name === "string" && typeof item.at === "string") : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`读取最近保存设置失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeRecent(home: string, entries: RecentPasswordSave[]): void {
  const path = recentFileName(home);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

function rememberRecent(home: string, entry: Omit<RecentPasswordSave, "at">): void {
  const next = { ...entry, at: new Date().toISOString() };
  const entries = readRecent(home).filter((item) => !(item.provider === entry.provider && item.host === entry.host && item.username.toLowerCase() === entry.username.toLowerCase()));
  entries.push(next);
  writeRecent(home, entries);
}

function recentFor(home: string, provider: string, host: string, username: string): RecentPasswordSave | undefined {
  const cutoff = Date.now() - MAX_RECENT_AGE;
  return readRecent(home).filter((item) => item.provider === provider && item.host === host && item.username.toLowerCase() === username.toLowerCase() && Date.parse(item.at) >= cutoff).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

function recentForAny(home: string, host: string, username: string, providers: string[]): RecentPasswordSave | undefined {
  return providers.map((provider) => recentFor(home, provider, host, username)).filter((entry): entry is RecentPasswordSave => Boolean(entry)).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
}

export function passwordCharactersText(characters: PasswordCharacter[]): string {
  const set = new Set(characters);
  if (set.has("lowercase") && set.has("uppercase") && set.has("numbers") && set.has("symbols")) return "含符号";
  if (set.has("lowercase") && set.has("uppercase") && set.has("numbers") && set.size === 3) return "字母和数字";
  return characters.map((character) => ({ lowercase: "小写字母", uppercase: "大写字母", numbers: "数字", symbols: "符号" })[character]).join("、");
}

function modeText(mode: FillNewPasswordApproval["mode"]): string {
  return mode === "register" ? "注册新账号" : "修改密码";
}

export function newPasswordModeText(mode: FillNewPasswordApproval["mode"]): string { return modeText(mode); }

function originOf(url: string): string {
  try {
    const origin = new URL(url).origin;
    if (origin === "null") throw new Error();
    return origin;
  } catch {
    throw new Error(`当前页面（${url}）没有网站地址。先打开注册或修改密码的表单再调 fill_new_password。`);
  }
}

function matching(candidates: FillLoginCandidate[], host: string, username: string): FillLoginCandidate | undefined {
  const wanted = username.trim().toLowerCase();
  return candidates.find((candidate) => candidate.username.trim().toLowerCase() === wanted && candidate.uris.some((uri) => {
    try {
      const saved = new URL(uri).hostname.toLowerCase().replace(/\.$/, "");
      return hostsMatch(host, saved);
    } catch {
      return false;
    }
  }));
}

function providerFor(runtime: HobRuntime, assistantId: string, role: "generate" | "save" | "secret", pluginId?: string) {
  return runtime.plugins.credentialProviders(assistantId, role).find((provider) => !pluginId || provider.pluginId === pluginId);
}

export type FillNewPasswordPreparation =
  | { kind: "message"; text: string }
  | { kind: "approval"; approval: FillNewPasswordApproval; title: string; detail: string };

export async function prepareFillNewPassword(
  runtime: HobRuntime,
  assistantId: string,
  username: string,
  length?: number,
  characters?: PasswordCharacter[],
  name?: string,
): Promise<FillNewPasswordPreparation> {
  const info = await inspectCurrentPage(runtime, assistantId);
  const passwordInputs = info.inputs.filter((input) => input.type === "password");
  if (!passwordInputs.length) return { kind: "message", text: `当前页面（${info.url}）上没有找到密码框。先打开注册或修改密码的表单再调 fill_new_password。` };
  const pageOrigin = originOf(info.url);
  if (!runtime.plugins.hasPasswordGenerator(assistantId)) return { kind: "message", text: "启用的密码管理器没有生成和保存新密码的工具，先启用支持 generate 和 save 的凭据提供者。" };
  const chosenLength = length ?? 20;
  if (!Number.isInteger(chosenLength) || chosenLength < 4 || chosenLength > 128) return { kind: "message", text: "length 要填 4 到 128 之间的整数。" };
  const chosenCharacters = [...new Set(characters === undefined ? ["lowercase", "uppercase", "numbers", "symbols"] : characters)] as PasswordCharacter[];
  if (!chosenCharacters.length) return { kind: "message", text: "characters 至少选一种字符。" };
  const invalid = chosenCharacters.find((character) => !["lowercase", "uppercase", "numbers", "symbols"].includes(character));
  if (invalid) return { kind: "message", text: `characters 里没有这种字符种类：${invalid}。` };
  const allCandidates = await credentialCandidates(runtime, assistantId, "");
  const listed = matching(allCandidates, info.host, username);
  const recent = recentForAny(runtime.home, info.host, username, runtime.plugins.credentialProviders(assistantId, "generate").map((provider) => provider.pluginId));
  // 30 分钟内刚由 fill_new_password 存进去的那一条（网站拒收后的重试）：还是注册，只是更新它，不多存
  const retry = listed && recent && recent.itemId === listed.id;
  const candidate = listed ?? (recent ? { provider: recent.provider, providerName: runtime.plugins.displayName(recent.provider), id: recent.itemId, name: recent.name, username: recent.username, ...(recent.folder ? { folder: recent.folder } : {}), uris: [pageOrigin] } : undefined);
  const mode: FillNewPasswordApproval["mode"] = listed && !retry ? "change" : "register";
  const baseProvider = candidate ? providerFor(runtime, assistantId, "generate", candidate.provider) : providerFor(runtime, assistantId, "generate");
  if (!baseProvider) return { kind: "message", text: "密码管理器没有可用的密码生成工具。" };
  const saveProvider = providerFor(runtime, assistantId, "save", baseProvider.pluginId);
  if (!saveProvider) return { kind: "message", text: `${baseProvider.providerName} 没有可用的凭据保存工具。` };
  const folders = [...new Set(allCandidates.filter((item) => item.provider === baseProvider.pluginId).map((item) => item.folder).filter((folder): folder is string => Boolean(folder)))];
  const defaultFolder = candidate?.folder ?? recent?.folder;
  const selectedFolder = defaultFolder && folders.includes(defaultFolder) ? defaultFolder : undefined;
  const approval: FillNewPasswordApproval = {
    host: info.host,
    pageUrl: info.url,
    username: username.trim(),
    mode,
    provider: baseProvider.pluginId,
    providerName: baseProvider.providerName,
    length: chosenLength,
    characters: chosenCharacters,
    name: name?.trim() || candidate?.name || info.host,
    origin: pageOrigin,
    folders,
    ...(selectedFolder ? { folder: selectedFolder } : {}),
    ...(candidate ? { candidate } : {}),
    state: "pending",
  };
  const pageWord = mode === "register" ? "注册页" : "页面";
  const detail = `密码由 ${baseProvider.providerName} 生成，Hob 填进${pageWord}并存进 ${baseProvider.providerName}，助手看不到。`;
  return { kind: "approval", approval, title: `在 ${info.host} ${mode === "register" ? "注册" : "修改密码"}`, detail };
}

export class NewPasswordError extends Error {
  constructor(message: string, readonly saved: boolean, readonly providerName: string, readonly itemName: string) {
    super(message);
    this.name = "NewPasswordError";
  }
}

function hiddenError(error: unknown, secrets: string[]): string {
  return secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join("[已隐藏]"), error instanceof Error ? error.message : String(error));
}

export function passwordTargets(info: PageInfo, mode: FillNewPasswordApproval["mode"]): number[] {
  const passwords = info.inputs.filter((input) => input.type === "password");
  const marked = passwords.filter((input) => input.autocomplete === "new-password");
  if (marked.length) return marked.map((input) => input.index);
  if (mode === "register") return passwords.map((input) => input.index);
  // 改密码页：三个框时第一个是旧密码；只有两个框（新密码和确认）就都填新密码
  return (passwords.length >= 3 ? passwords.slice(1) : passwords).map((input) => input.index);
}

export async function generateSaveAndFill(runtime: HobRuntime, assistantId: string, approval: FillNewPasswordApproval, folder?: string): Promise<void> {
  const generateProvider = providerFor(runtime, assistantId, "generate", approval.provider);
  const saveProvider = providerFor(runtime, assistantId, "save", approval.provider);
  if (!generateProvider || !saveProvider) throw new NewPasswordError(`${approval.providerName} 的凭据工具现在不可用。`, false, approval.providerName, approval.name);
  let password = "";
  let oldPassword = "";
  let saved = false;
  try {
    const generated = await runtime.plugins.callCredential(generateProvider, {
      length: approval.length,
      lowercase: approval.characters.includes("lowercase"),
      uppercase: approval.characters.includes("uppercase"),
      numbers: approval.characters.includes("numbers"),
      symbols: approval.characters.includes("symbols"),
    });
    password = typeof generated.password === "string" ? generated.password : "";
    if (!password) throw new Error("密码管理器没有返回生成的密码。");
    if (approval.mode === "change") {
      const secretProvider = providerFor(runtime, assistantId, "secret", approval.provider);
      if (!secretProvider || !approval.candidate) throw new Error("找不到原来的登录凭据。");
      const secret = await runtime.plugins.callCredential(secretProvider, { id: approval.candidate.id });
      oldPassword = typeof secret.password === "string" ? secret.password : "";
      if (!oldPassword) throw new Error("密码管理器没有存原来的密码。");
    }
    const savedValue = await runtime.plugins.callCredential(saveProvider, {
      ...(approval.candidate ? { id: approval.candidate.id } : {}),
      name: approval.name,
      uris: [approval.origin],
      username: approval.username,
      password,
      ...(approval.mode === "register" ? { folder: folder ?? "" } : {}),
    });
    const savedId = typeof savedValue.id === "string" ? savedValue.id : approval.candidate?.id;
    if (!savedId) throw new Error("密码管理器没有返回已保存条目的 id。");
    saved = true;
    const savedFolder = approval.mode === "change" ? approval.candidate?.folder : folder || undefined;
    rememberRecent(runtime.home, { provider: approval.provider, itemId: savedId, host: approval.host, username: approval.username, name: approval.name, ...(savedFolder ? { folder: savedFolder } : {}) });
    const session = new DesktopToolSession(runtime, assistantId);
    try {
      await session.withCurrentPage(async (page) => {
        const current = await pageInfo(page);
        if (current.host !== approval.host) throw new Error(`当前页面是 ${current.host}，和刚才核对的页面对不上，已保存新密码但没有填写。`);
        const targets = passwordTargets(current, approval.mode);
        if (!targets.length) throw new Error(`当前页面（${current.url}）上没有找到密码框，已保存新密码但没有填写。`);
        const usernameField = current.usernameIndex === undefined ? undefined : current.inputs.find((input) => input.index === current.usernameIndex);
        if (current.usernameIndex !== undefined && !usernameField?.value.trim()) await page.locator("input").nth(current.usernameIndex).fill(approval.username);
        if (approval.mode === "change" && current.inputs.filter((input) => input.type === "password").length >= 3) {
          const old = current.inputs.filter((input) => input.type === "password")[0]!;
          await page.locator("input").nth(old.index).fill(oldPassword);
        }
        for (const index of targets) await page.locator("input").nth(index).fill(password);
        // 页面上现在有这些密码：助手的浏览器命令（快照、读值）输出里要把它们抹掉
        rememberFilledSecret(runtime, assistantId, password, oldPassword);
      });
    } finally {
      await session.dispose();
    }
  } catch (error) {
    throw new NewPasswordError(hiddenError(error, [password, oldPassword]), saved, approval.providerName, approval.name);
  }
}
