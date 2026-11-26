// 假的密码管理插件（stdio MCP）：带 list / secret / generate / save 四个凭据角色工具，密码库是一个 JSON 文件。
// 做法和 bitwarden 插件的 server.mjs 一样：列表只给概况，密码只在 secret / save 这一次调用的结果里经过。
// 环境变量：HOB_FAKE_VAULT 密码库 JSON（{ folders, items }，格式同 bitwarden/test/fixtures/fake-bw.mjs）；
// HOB_FAKE_FAIL=secret|generate|save 让那一步报错（测失败路径），HOB_FAKE_FAIL_FILE 指向一个文件时每次调用都读它、以文件内容为准（跑着的时候切换）；
// HOB_FAKE_LOG 把每次调用的工具名记一行（测「没有取过密码」）。
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const vaultPath = process.env.HOB_FAKE_VAULT;
if (!vaultPath) throw new Error("HOB_FAKE_VAULT 未配置");
const failFile = process.env.HOB_FAKE_FAIL_FILE ?? "";
const failAt = () => (failFile && existsSync(failFile) ? readFileSync(failFile, "utf8").trim() : process.env.HOB_FAKE_FAIL ?? "");
const logPath = process.env.HOB_FAKE_LOG ?? "";
const load = () => JSON.parse(readFileSync(vaultPath, "utf8"));
const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const empty = (structuredContent) => ({ content: [], structuredContent });

const TOOLS = [
  { name: "credentials_list", description: "列出登录", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] }, "hob/credentials": "list" } },
  { name: "credentials_secret", description: "取密码", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, _meta: { ui: { visibility: ["app"] }, "hob/credentials": "secret" } },
  { name: "credentials_generate", description: "生成密码", inputSchema: { type: "object", properties: { length: { type: "number" }, lowercase: { type: "boolean" }, uppercase: { type: "boolean" }, numbers: { type: "boolean" }, symbols: { type: "boolean" } }, required: ["length", "lowercase", "uppercase", "numbers", "symbols"] }, _meta: { ui: { visibility: ["app"] }, "hob/credentials": "generate" } },
  { name: "credentials_save", description: "保存登录", inputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, uris: { type: "array", items: { type: "string" } }, username: { type: "string" }, password: { type: "string" }, folder: { type: "string" } }, required: ["name", "uris", "username", "password"] }, _meta: { ui: { visibility: ["app"] }, "hob/credentials": "save" } },
];

const SETS = { lowercase: "abcdefghijkmnpqrstuvwxyz", uppercase: "ABCDEFGHJKLMNPQRSTUVWXYZ", numbers: "23456789", symbols: "!@#$%^&*-" };
function generate({ length, lowercase, uppercase, numbers, symbols }) {
  const pools = Object.entries(SETS).filter(([name]) => ({ lowercase, uppercase, numbers, symbols })[name]).map(([, pool]) => pool);
  // 每种字符至少一个，其余随机；用密码库文件做种子之外的随机源，每次不同
  const chars = pools.map((pool) => pool[Math.floor(Math.random() * pool.length)]);
  const all = pools.join("");
  while (chars.length < length) chars.push(all[Math.floor(Math.random() * all.length)]);
  return chars.sort(() => Math.random() - 0.5).join("");
}

function call(name, args) {
  const vault = load();
  if (name === "credentials_list") {
    return empty({ logins: vault.items.filter((item) => item.type === 1).map((item) => ({ id: String(item.id), name: item.name, username: item.login.username, uris: (item.login.uris ?? []).map((entry) => (typeof entry === "string" ? entry : entry.uri)), ...(item.folderId ? { folder: vault.folders.find((folder) => folder.id === item.folderId)?.name } : {}) })) });
  }
  if (name === "credentials_secret") {
    if (failAt() === "secret") return { content: [{ type: "text", text: "密码库锁着" }], isError: true };
    const item = vault.items.find((entry) => String(entry.id) === args.id);
    if (!item) return { content: [{ type: "text", text: "没有这个登录" }], isError: true };
    return empty({ username: item.login.username, password: item.login.password });
  }
  if (name === "credentials_generate") {
    if (failAt() === "generate") return { content: [{ type: "text", text: "生成器不可用" }], isError: true };
    return empty({ password: generate(args) });
  }
  if (name === "credentials_save") {
    if (failAt() === "save") return { content: [{ type: "text", text: "密码库拒绝保存" }], isError: true };
    const existing = args.id ? vault.items.find((entry) => String(entry.id) === args.id) : undefined;
    let folderId = existing?.folderId;
    if (args.folder !== undefined) {
      if (args.folder) {
        let folder = vault.folders.find((entry) => entry.name === args.folder);
        if (!folder) { folder = { id: `folder-${vault.folders.length + 1}-${Date.now() % 1000}`, name: args.folder }; vault.folders.push(folder); }
        folderId = folder.id;
      } else folderId = undefined;
    }
    const item = {
      type: 1,
      id: existing?.id ?? `login-${Date.now().toString(36)}`,
      name: args.name,
      ...(folderId ? { folderId } : {}),
      login: { ...(existing?.login ?? {}), username: args.username, password: args.password, uris: args.uris.map((uri) => ({ uri })) },
    };
    if (existing) vault.items[vault.items.indexOf(existing)] = item; else vault.items.push(item);
    writeFileSync(vaultPath, `${JSON.stringify(vault, null, 2)}\n`);
    return empty({ id: String(item.id), ...(folderId ? { folder: vault.folders.find((folder) => folder.id === folderId)?.name } : {}) });
  }
  return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params?.protocolVersion ?? "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "hob-credentials-fixture", version: "1.0" } } });
    } else if (message.method === "tools/list") write({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    else if (message.method === "tools/call") {
      if (logPath) appendFileSync(logPath, `${message.params?.name}\n`);
      write({ jsonrpc: "2.0", id: message.id, result: call(message.params?.name, message.params?.arguments ?? {}) });
    }
    else if (message.id !== undefined) write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
});
