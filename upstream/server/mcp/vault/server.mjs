import { createCipheriv, createDecipheriv, randomBytes, randomInt } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const dataDir = process.env.VAULT_DATA;
if (!dataDir) throw new Error("密码库数据目录未配置");
const keyPath = join(dataDir, "vault.key");
const vaultPath = join(dataDir, "vault.json");
const NO_FOLDER = "__no_folder__";
const emptyObject = z.object({});
const secretInput = z.object({ id: z.string() });
const generateInput = z.object({ length: z.number(), lowercase: z.boolean(), uppercase: z.boolean(), numbers: z.boolean(), symbols: z.boolean() });
const saveInput = z.object({ id: z.string().optional(), name: z.string(), uris: z.array(z.string()), username: z.string(), password: z.string(), folder: z.string().optional() });
const saveFormInput = z.object({ card_id: z.string(), action: z.any() });

const initialVault = () => ({ folders: [], items: [] });

function ensureDataDir() {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
}

function key() {
  ensureDataDir();
  if (!existsSync(keyPath)) {
    const value = randomBytes(32);
    const temp = `${keyPath}.${process.pid}.${randomInt(1_000_000)}.tmp`;
    writeFileSync(temp, value, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    try { renameSync(temp, keyPath); } catch (error) { rmSync(temp, { force: true }); if (!existsSync(keyPath)) throw error; }
  }
  const value = readFileSync(keyPath);
  if (value.length !== 32) throw new Error("密码库密钥文件损坏");
  chmodSync(keyPath, 0o600);
  return value;
}

function readVault() {
  if (!existsSync(vaultPath)) return initialVault();
  try {
    const envelope = JSON.parse(readFileSync(vaultPath, "utf8"));
    if (envelope?.version !== 1 || typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.data !== "string") throw new Error("格式无效");
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const value = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]).toString("utf8"));
    if (!value || !Array.isArray(value.folders) || !Array.isArray(value.items)) throw new Error("内容无效");
    return value;
  } catch (error) {
    throw new Error(`密码库无法打开：${error instanceof Error ? error.message : String(error)}`);
  }
}

function writeVault(value) {
  ensureDataDir();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const envelope = JSON.stringify({ version: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: encrypted.toString("base64") });
  const temp = `${vaultPath}.${process.pid}.${randomInt(1_000_000)}.tmp`;
  try {
    writeFileSync(temp, `${envelope}\n`, { mode: 0o600, flag: "wx" });
    chmodSync(temp, 0o600);
    renameSync(temp, vaultPath);
  } finally { rmSync(temp, { force: true }); }
}

function itemUris(item) {
  return Array.isArray(item?.login?.uris) ? item.login.uris.map(uri => typeof uri === "string" ? uri : uri?.uri).filter(uri => typeof uri === "string" && uri) : [];
}
function isLogin(item) { return item && item.login && typeof item.login === "object"; }
function folderName(item, vault) { return vault.folders.find(folder => folder.id === item.folderId)?.name; }
function publicLogin(item, vault) {
  const uris = itemUris(item);
  const folder = folderName(item, vault);
  return {
    id: String(item.id), name: String(item.name || ""), username: String(item.login?.username || ""), uris,
    ...(folder ? { folder } : {}),
    hasPassword: typeof item.login?.password === "string" && item.login.password.length > 0,
    hasTotp: typeof item.login?.totp === "string" && item.login.totp.length > 0,
  };
}
function listLogins({ search, folder } = {}) {
  const vault = readVault();
  const needle = String(search || "").toLowerCase();
  return vault.items.filter(isLogin).filter(item => {
    if (folder && folderName(item, vault) !== folder) return false;
    if (!needle) return true;
    return [item.name, item.login?.username, ...itemUris(item), folderName(item, vault)].some(value => String(value || "").toLowerCase().includes(needle));
  }).map(item => publicLogin(item, vault));
}
function folders() { return readVault().folders.filter(folder => typeof folder?.name === "string"); }
function ensureFolder(vault, name) {
  if (!name) return undefined;
  let found = vault.folders.find(folder => folder.name === name);
  if (!found) { found = { id: randomBytes(12).toString("hex"), name }; vault.folders.push(found); }
  return found;
}
function findItem(vault, id) {
  const item = vault.items.find(candidate => String(candidate.id) === String(id) && isLogin(candidate));
  if (!item) throw new Error("密码库里没有这个登录");
  return item;
}
function saveCredential({ id, name, uris, username, password, folder } = {}) {
  const vault = readVault();
  const existing = id ? findItem(vault, id) : undefined;
  const selected = folder === undefined ? undefined : ensureFolder(vault, folder);
  const folderId = folder === undefined ? existing?.folderId : selected?.id;
  const login = { ...(existing?.login || {}), username: username || "", password, uris: (Array.isArray(uris) ? uris : []).map(uri => ({ uri })) };
  const item = existing || { id: randomBytes(12).toString("hex"), type: 1, login: {} };
  item.name = name;
  item.login = login;
  if (folderId) item.folderId = folderId; else delete item.folderId;
  if (!existing) vault.items.push(item);
  writeVault(vault);
  const savedFolder = vault.folders.find(candidate => candidate.id === folderId)?.name;
  return { id: String(item.id), ...(savedFolder ? { folder: savedFolder } : {}) };
}
function deleteCredential(id) {
  const vault = readVault();
  const index = vault.items.findIndex(item => String(item.id) === String(id) && isLogin(item));
  if (index < 0) throw new Error("密码库里没有这个登录");
  vault.items.splice(index, 1);
  writeVault(vault);
  return {};
}
function getSecret(id) {
  const item = findItem(readVault(), id);
  return { username: String(item.login?.username || ""), password: String(item.login?.password || ""), ...(item.login?.totp ? { totp: String(item.login.totp) } : {}) };
}
function generatePassword({ length, lowercase, uppercase, numbers, symbols }) {
  if (!Number.isInteger(length) || length < 4 || length > 128) throw new Error("密码长度须在 4 到 128 之间");
  const sets = [lowercase ? "abcdefghijklmnopqrstuvwxyz" : "", uppercase ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ" : "", numbers ? "0123456789" : "", symbols ? "!@#$%^&*()-_=+[]{}:,.?" : ""].filter(Boolean);
  if (!sets.length) throw new Error("至少选择一种密码字符");
  const chars = sets.join("");
  return { password: Array.from({ length }, () => chars[randomInt(chars.length)]).join("") };
}
function appOnly(role) { return { ui: { visibility: ["app"] }, "hob/credentials": role }; }
function emptyResult(structuredContent) { return { content: [], structuredContent }; }
function textResult(text, meta) { return { content: [{ type: "text", text }], ...(meta ? { _meta: meta } : {}) }; }
function valueOf(values, name) { const value = values?.[name]; return value === undefined || value === null ? "" : String(value); }
function formValue(action) { return action?.form_value && typeof action.form_value === "object" ? action.form_value : {}; }
function folderOf(values) { const folder = valueOf(values, "folder"); return folder === NO_FOLDER ? "" : folder; }
function hostOf(uri) { try { return new URL(uri).host || uri; } catch { return uri; } }
function loginLabel(login, separator = "、") { const values = []; if (login.hasPassword) values.push("密码"); if (login.hasTotp) values.push("两步验证"); return values.length ? values.join(separator) : "无"; }
function loginRow(login) {
  return { tag: "interactive_container", elements: [{ tag: "div", text: `${login.name}\n${login.username || "（无用户名）"} · ${login.uris[0] ? hostOf(login.uris[0]) : "（无网址）"}` }, { tag: "div", text: loginLabel(login, " · ") }] };
}
function listCard(title, logins) {
  const rows = logins.slice(0, 50).map(loginRow);
  const elements = rows.slice(0, 20);
  if (rows.length > 20) elements.push({ tag: "collapsible_panel", header: { title: `其余 ${rows.length - 20} 个` }, expanded: false, elements: rows.slice(20) });
  return { header: { title, subtitle: `${logins.length} 个登录` }, body: { elements } };
}
function savedCard(values, folder, status) {
  const row = (label, value) => ({ tag: "column_set", background_style: "light", columns: [{ weight: 1, elements: [{ tag: "div", text: label }] }, { weight: 5, elements: [{ tag: "div", text: value }] }] });
  const elements = [row("名称", valueOf(values, "name")), row("网址", valueOf(values, "url") || "（没填）"), row("用户名", valueOf(values, "username") || "（没填）"), row("密码", valueOf(values, "password") ? "已填写" : "未填写")];
  elements.push({ tag: "div", icon: "check", text: status || (folder ? `已保存到「${folder}」` : "已保存") });
  return { header: { title: "保存登录信息" }, body: { elements } };
}
function saveLoginCard({ name, url, username, folder } = {}) {
  const options = [...folders().map(entry => ({ text: entry.name, value: entry.name })), { text: "不放进文件夹", value: NO_FOLDER }];
  const initial = folder && options.some(option => option.value === folder) ? { initial_option: folder } : {};
  return { config: { callback_tool: "save_login_submit" }, header: { title: "保存登录信息" }, body: { elements: [{ tag: "form", name: "login", elements: [
    { tag: "column_set", columns: [{ weight: 1, elements: [{ tag: "input", name: "name", label: "名称", default_value: name || "", required: true }] }, { weight: 1, elements: [{ tag: "select_static", name: "folder", label: "文件夹", options, placeholder: "不放进文件夹", display: "dropdown", ...initial }] }] },
    { tag: "input", name: "url", label: "网址", default_value: url || "", input_type: "text" },
    { tag: "input", name: "username", label: "用户名", default_value: username || "", input_type: "text" },
    { tag: "input", name: "password", label: "密码", input_type: "password", generate: true, required: true },
    { tag: "button", name: "cancel", text: "取消", type: "default" },
    { tag: "button", name: "save", text: "保存", type: "primary_filled", form_action_type: "submit" },
  ] }] } };
}
function duplicate(values) {
  const name = valueOf(values, "name"), username = valueOf(values, "username"), url = valueOf(values, "url");
  return listLogins().some(login => login.name === name && login.username === username && login.uris.includes(url));
}

const server = new McpServer({ name: "vault", version: "1.0.0" }, { capabilities: { tools: {} } });
server.registerTool("list_logins", {
  description: "列出密码库里存的登录：名称、用户名、网址、所在文件夹、存了哪些内容（密码、两步验证）。不返回密码。参数 search 按名称、用户名或网址筛选，folder 只看某个文件夹，都可以不填。结果同时显示成一张列表卡给用户看。",
  inputSchema: z.object({ search: z.string().optional(), folder: z.string().optional() }),
}, async ({ search, folder }) => {
  const logins = listLogins({ search, folder });
  if (!logins.length) return textResult(search ? `密码库里没有匹配「${search}」的登录。` : "密码库里没有登录。");
  const shown = logins.slice(0, 50);
  const lines = [`共 ${logins.length} 条`, ...shown.map(login => `${login.name} · ${login.username} · ${login.uris[0] || ""} · ${login.folder || "无文件夹"} · 存了：${loginLabel(login)}`)];
  if (logins.length > 50) lines.push(`还有 ${logins.length - 50} 条，用 search 缩小范围`);
  return textResult(lines.join("\n"), { "hob/card": listCard(folder || "密码库里的登录", logins) });
});
server.registerTool("save_login", {
  description: "出一张卡片，让用户把一个登录存进密码库：名称、文件夹、网址、用户名、密码。密码由用户在卡片里填或点「生成」，直接交给密码库，不经过你。参数都是预填到卡片上的值，可以不填。用户保存或取消后会告诉你结果。",
  inputSchema: z.object({ name: z.string().optional(), url: z.string().optional(), username: z.string().optional(), folder: z.string().optional() }),
}, async values => textResult("保存登录的卡片已显示给用户，用户填好保存后会告诉你结果。", { "hob/card": saveLoginCard(values) }));
server.registerTool("save_login_submit", { description: "保存登录卡片的回调。", inputSchema: saveFormInput, _meta: { ui: { visibility: ["app"] } } }, async ({ action }) => {
  const values = formValue(action); const button = action?.name || action?.value?.name || action?.value?.action;
  if (button === "cancel") return textResult("用户取消了保存登录。", { "hob/card": savedCard(values, undefined, "已取消") });
  const password = valueOf(values, "password");
  try {
    if (duplicate(values)) return { content: [], _meta: { "hob/errors": { name: "密码库里已经有这一条了" } } };
    const result = saveCredential({ name: valueOf(values, "name"), uris: valueOf(values, "url") ? [valueOf(values, "url")] : [], username: valueOf(values, "username"), password, folder: folderOf(values) });
    return textResult(`用户在密码库存好了登录：${valueOf(values, "name")}（${valueOf(values, "username")}），文件夹「${result.folder || ""}」。`, { "hob/card": savedCard(values, result.folder) });
  } catch (error) { return { content: [], _meta: { "hob/toast": { type: "error", content: String(error?.message || error).replaceAll(password, "[已隐藏]") } } }; }
});
server.registerTool("credentials_list", { inputSchema: emptyObject, _meta: appOnly("list") }, async () => emptyResult({ logins: listLogins() }));
server.registerTool("credentials_secret", { inputSchema: secretInput, _meta: appOnly("secret") }, async ({ id }) => emptyResult(getSecret(id)));
server.registerTool("credentials_generate", { inputSchema: generateInput, _meta: appOnly("generate") }, async values => emptyResult(generatePassword(values)));
server.registerTool("credentials_save", { inputSchema: saveInput, _meta: appOnly("save") }, async values => emptyResult(saveCredential(values)));
server.registerTool("credentials_delete", { inputSchema: secretInput, _meta: appOnly("delete") }, async ({ id }) => emptyResult(deleteCredential(id)));

await server.connect(new StdioServerTransport());
