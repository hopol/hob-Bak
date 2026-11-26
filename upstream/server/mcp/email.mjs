import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { resolveMx } from 'node:dns/promises';
import { fetch as undiciFetch, EnvHttpProxyAgent } from 'undici';

const providers = {
  'gmail.com': ['imap.gmail.com', 'smtp.gmail.com', 993, 465], 'googlemail.com': ['imap.gmail.com', 'smtp.gmail.com', 993, 465],
  'qq.com': ['imap.qq.com', 'smtp.qq.com', 993, 465], '163.com': ['imap.163.com', 'smtp.163.com', 993, 465],
  '126.com': ['imap.126.com', 'smtp.126.com', 993, 465], 'outlook.com': ['outlook.office365.com', 'smtp-mail.outlook.com', 993, 587],
  'hotmail.com': ['outlook.office365.com', 'smtp-mail.outlook.com', 993, 587],
  'icloud.com': ['imap.mail.me.com', 'smtp.mail.me.com', 993, 587], 'me.com': ['imap.mail.me.com', 'smtp.mail.me.com', 993, 587],
  'mac.com': ['imap.mail.me.com', 'smtp.mail.me.com', 993, 587], 'yahoo.com': ['imap.mail.yahoo.com', 'smtp.mail.yahoo.com', 993, 465],
  '139.com': ['imap.139.com', 'smtp.139.com', 993, 465],
  'sina.com': ['imap.sina.com', 'smtp.sina.com', 993, 465], 'sina.cn': ['imap.sina.cn', 'smtp.sina.cn', 993, 465],
  'aliyun.com': ['imap.aliyun.com', 'smtp.aliyun.com', 993, 465],
  'live.com': ['outlook.office365.com', 'smtp-mail.outlook.com', 993, 587], 'msn.com': ['outlook.office365.com', 'smtp-mail.outlook.com', 993, 587],
};
const mxProviders = [
  [/^mxbiz[12]\.qq\.com$/, ['imap.exmail.qq.com', 'smtp.exmail.qq.com', 993, 465]],
  [/^[^.]+\.mxmail\.netease\.com$/, ['imaphz.qiye.163.com', 'smtphz.qiye.163.com', 993, 465]],
  [/^mx[^.]*\.qiye\.aliyun\.com$/, ['imap.qiye.aliyun.com', 'smtp.qiye.aliyun.com', 993, 465]],
];
const cache = new Map();
const timeoutMs = 2500;
const timed = (operation, ms = timeoutMs) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('超时')), ms);
  Promise.resolve().then(operation).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const hostValid = host => typeof host === 'string' && host.length <= 253 && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host);
const preset = (row, source) => ({ imap: { host: row[0], port: row[2], socket: 'SSL' }, smtp: { host: row[1], port: row[3], socket: row[3] === 465 ? 'SSL' : 'STARTTLS' }, source });
function parseConfig(xml, source) {
  const server = (kind, type) => {
    const block = [...xml.matchAll(new RegExp(`<${kind}\\b([^>]*)>([\\s\\S]*?)<\\/${kind}\\s*>`, 'gi'))].find(m => new RegExp(`\\btype\\s*=\\s*["']${type}["']`, 'i').test(m[1]));
    if (!block) return null;
    const get = tag => new RegExp(`<${tag}\\s*>\\s*([^<]+?)\\s*<\\/${tag}\\s*>`, 'i').exec(block[2])?.[1];
    const host = get('hostname'), port = Number(get('port')), socket = get('socketType')?.toUpperCase();
    if (!hostValid(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !['SSL', 'STARTTLS'].includes(socket)) return null;
    return { host, port, socket };
  };
  const imap = server('incomingServer', 'imap'), smtp = server('outgoingServer', 'smtp');
  return imap && smtp ? { imap, smtp, source } : null;
}
export async function discover(domain, deps = {}) {
  domain = domain.toLowerCase();
  if (!hostValid(domain)) throw new Error('邮箱地址的域名无效');
  const fetcher = deps.fetch ?? fetch, dns = deps.resolveMx ?? resolveMx;
  const cacheKey = deps.cache ?? cache;
  if (cacheKey.has(domain)) return cacheKey.get(domain);
  const run = async () => {
    if (providers[domain]) return preset(providers[domain], '内置列表');
    const reasons = ['内置列表里没有'];
    const lookup = async (url, label) => {
      try {
        const response = await timed(() => fetcher(url, { signal: AbortSignal.timeout(deps.timeoutMs ?? timeoutMs), redirect: 'error' }), deps.timeoutMs);
        if (!response.ok) { reasons.push(`${label}：HTTP ${response.status}`); return null; }
        const text = await timed(() => response.text(), deps.timeoutMs);
        if (text.length > 256000) { reasons.push(`${label}：配置过大`); return null; }
        const result = parseConfig(text, label);
        if (!result) reasons.push(`${label}：没有可用的 IMAP 和 SMTP 配置`);
        return result;
      } catch (error) { reasons.push(`${label}：${error.message}`); return null; }
    };
    let result = await lookup(`https://autoconfig.${domain}/mail/config-v1.1.xml`, '服务商自动配置');
    if (result) return result;
    result = await lookup(`https://autoconfig.thunderbird.net/v1.1/${domain}`, 'Thunderbird 配置库');
    if (result) return result;
    try {
      const records = (await timed(() => dns(domain), deps.timeoutMs)).sort((a, b) => a.priority - b.priority);
      const hosts = [...new Set(records.map(record => record.exchange.toLowerCase().replace(/\.$/, '')).filter(hostValid))];
      if (!hosts.length) reasons.push('MX 没有可用记录');
      for (const host of hosts) {
        const provider = mxProviders.find(([pattern]) => pattern.test(host));
        if (provider) return preset(provider[1], `MX 内置表（${host}）`);
      }
      const checked = new Set();
      for (const host of hosts) {
        reasons.push(`MX 是 ${host}`);
        const parts = host.split('.');
        for (let i = 1; i <= parts.length - 2; i++) {
          const root = parts.slice(i).join('.');
          if (checked.has(root)) continue;
          checked.add(root);
          result = await lookup(`https://autoconfig.thunderbird.net/v1.1/${root}`, `MX 主域名 ${root} 的 Thunderbird 配置库`);
          if (result) return result;
        }
      }
    } catch (error) { reasons.push(`MX 查询：${error.message}`); }
    throw new Error(`认不出 ${domain} 的邮件服务器：${reasons.join('；')}。请在「更多设置」里填 IMAP 服务器和 SMTP 服务器`);
  };
  const promise = run();
  cacheKey.set(domain, promise);
  promise.catch(() => cacheKey.delete(domain));
  return promise;
}
function proxyFromEnv(env) {
  return [env.HTTPS_PROXY, env.ALL_PROXY, env.HTTP_PROXY, env.https_proxy, env.all_proxy, env.http_proxy].find(value => typeof value === 'string' && value.trim())?.trim();
}
function fetchForEnv(env, deps) {
  if (deps?.fetch) return deps.fetch;
  const proxy = proxyFromEnv(env);
  if (!proxy) return fetch;
  const agent = new EnvHttpProxyAgent({ httpProxy: proxy, httpsProxy: proxy, noProxy: env.NO_PROXY ?? env.no_proxy ?? '' });
  return (input, init = {}) => undiciFetch(input, { ...init, dispatcher: agent });
}
function bypassProxy(host, port, raw) {
  const hostname = String(host).toLowerCase().replace(/\.$/, '');
  return String(raw ?? '').split(/[,\s]+/).some(entry => {
    let rule = entry.trim().toLowerCase();
    if (!rule) return false;
    if (rule === '*') return true;
    let rulePort;
    if (rule.startsWith('[')) {
      const end = rule.indexOf(']');
      if (end >= 0) {
        const suffix = rule.slice(end + 1);
        rulePort = /^:\d+$/.test(suffix) ? Number(suffix.slice(1)) : undefined;
        rule = rule.slice(1, end);
      }
    } else {
      const colon = rule.lastIndexOf(':');
      if (colon > 0 && rule.indexOf(':') === colon && /^\d+$/.test(rule.slice(colon + 1))) {
        rulePort = Number(rule.slice(colon + 1));
        rule = rule.slice(0, colon);
      }
    }
    if (rulePort !== undefined && rulePort !== Number(port)) return false;
    rule = rule.replace(/^\*\./, '').replace(/^\./, '').replace(/^\[|\]$/g, '');
    return rule === hostname || (!!rule && hostname.endsWith(`.${rule}`));
  });
}
function proxyFor(host, port, env) {
  const proxy = proxyFromEnv(env);
  return proxy && !bypassProxy(host, port, env.NO_PROXY ?? env.no_proxy) ? proxy : undefined;
}
function proxyNote(host, port, env) {
  if (!proxyFromEnv(env)) return '没走网络代理：Hob 没有设置网络代理（设置 → 通用 → 网络代理）';
  return bypassProxy(host, port, env.NO_PROXY ?? env.no_proxy) ? '没走网络代理：这个服务器在「不走代理的地址」里' : '';
}
function proxyDisplay(value) {
  if (!value) return '未使用';
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return '已配置';
  }
}
export async function settings(env, deps) {
  let defaults;
  if (!env.IMAP_HOST || !env.SMTP_HOST) defaults = await discover((env.EMAIL_ADDRESS ?? '').split('@').pop(), { ...deps, fetch: fetchForEnv(env, deps) });
  const port = (value, fallback) => { const n = value ? Number(value) : fallback; if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('端口必须是 1 到 65535 的整数'); return n; };
  const imapPort = port(env.IMAP_PORT, defaults?.imap.port ?? 993), smtpPort = port(env.SMTP_PORT, defaults?.smtp.port ?? 465);
  const imapHost = env.IMAP_HOST || defaults.imap.host, smtpHost = env.SMTP_HOST || defaults.smtp.host;
  return { address: env.EMAIL_ADDRESS, password: env.EMAIL_PASSWORD, imapHost, smtpHost, imapPort, smtpPort,
    imapSocket: env.IMAP_HOST ? (imapPort === 993 ? 'SSL' : 'STARTTLS') : defaults.imap.socket,
    smtpSocket: env.SMTP_HOST ? (smtpPort === 465 ? 'SSL' : 'STARTTLS') : defaults.smtp.socket, imapSource: env.IMAP_HOST ? '用户填写' : defaults.source, smtpSource: env.SMTP_HOST ? '用户填写' : defaults.source,
    imapProxy: proxyFor(imapHost, imapPort, env), smtpProxy: proxyFor(smtpHost, smtpPort, env), imapProxyNote: proxyNote(imapHost, imapPort, env), smtpProxyNote: proxyNote(smtpHost, smtpPort, env), data: env.EMAIL_DATA };
}
const local = host => ['localhost', '127.0.0.1', '::1'].includes(host);
const addr = value => value?.text ?? '';
const errorText = error => {
  const parts = [error?.serverResponseCode, typeof error?.response === 'string' ? error.response : error?.responseText].filter(Boolean);
  return parts.length ? [...new Set(parts)].join(' ') : error?.message ?? String(error);
};
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const str = { type: 'string' }, uid = { type: 'integer', minimum: 1 }, folder = { type: 'string' };
const reply = schema({ folder, uid }, ['folder', 'uid']);
const compose = { to: str, cc: str, subject: str, body: str, reply_to: reply };
const baseTools = () => [
  { name: 'list_folders', description: '列出邮箱里的文件夹，返回名称和未读数。Gmail 的标签也在这里。', properties: {}, required: [], annotations: { readOnlyHint: true } },
  { name: 'search_messages', description: '按条件搜索邮件，最新的在前，返回每封的 folder、uid、发件人、主题、时间、是否已读。', properties: { folder: { ...folder, description: '不填是收件箱。' }, from: { ...str, description: '包含这些文字。' }, to: { ...str, description: '包含这些文字。' }, subject: { ...str, description: '包含这些文字。' }, text: { ...str, description: '正文或任意字段包含。' }, since: { ...str, description: '日期，YYYY-MM-DD。' }, before: { ...str, description: '日期，YYYY-MM-DD。' }, unread: { type: 'boolean', description: '只看未读。' }, limit: { type: 'integer', minimum: 1, maximum: 100, description: '默认 20，最多 100。' } }, required: [], annotations: { readOnlyHint: true } },
  { name: 'get_message', description: '读一封邮件：发件人、收件人、抄送、主题、时间、纯文本正文和附件列表。folder、uid 用 search_messages 返回的。', properties: { folder, uid }, required: ['folder', 'uid'], annotations: { readOnlyHint: true } },
  { name: 'save_attachment', description: '把一封邮件的一个附件存成文件，返回文件路径。filename 用 get_message 附件列表里的名字。', properties: { folder, uid, filename: str }, required: ['folder', 'uid', 'filename'], annotations: { readOnlyHint: true } },
  { name: 'create_draft', description: '写一封草稿存进草稿箱，不发送，用户可以在自己的邮箱里改了再发。', properties: { ...compose, to: { ...str, description: '多个地址用逗号隔开。' }, cc: { ...str, description: '多个地址用逗号隔开。' }, subject: { ...str, description: '纯文本。' }, body: { ...str, description: '纯文本。' }, reply_to: { ...reply, description: '会带上回复关系，主题不填就用「Re: 原主题」。' } }, required: ['to', 'body'], annotations: { readOnlyHint: false } },
  { name: 'send_message', description: '发送一封邮件，参数和 create_draft 一样，发出后在已发送里留一份。', properties: { ...compose, to: { ...str, description: '多个地址用逗号隔开。' }, cc: { ...str, description: '多个地址用逗号隔开。' }, subject: { ...str, description: '纯文本。' }, body: { ...str, description: '纯文本。' }, reply_to: { ...reply, description: '会带上回复关系，主题不填就用「Re: 原主题」。' } }, required: ['to', 'body'], annotations: { readOnlyHint: false } },
  { name: 'move_message', description: '把邮件移到另一个文件夹。Gmail 里归档、改标签就是移文件夹。参数 folder、uid、to_folder。', properties: { folder, uid, to_folder: str }, required: ['folder', 'uid', 'to_folder'], annotations: { readOnlyHint: false } },
  { name: 'set_flags', description: '标记已读或未读、加星或去星。参数 folder、uid、seen、flagged，不填的不改。', properties: { folder, uid, seen: { type: 'boolean' }, flagged: { type: 'boolean' } }, required: ['folder', 'uid'], annotations: { readOnlyHint: false } },
];
export function toolsForAccounts(accounts) {
  const multiple = accounts.length > 1;
  const names = accounts.map(account => account.name);
  const addresses = accounts.map(account => `${account.name}（${account.address ?? '未知地址'}）`).join('、');
  return baseTools().map(tool => {
    const properties = multiple ? { account: { type: 'string', enum: names, description: `用哪个邮箱，填名称。可选：${addresses}。` }, ...tool.properties } : tool.properties;
    const required = multiple ? ['account', ...tool.required] : tool.required;
    return { name: tool.name, description: tool.description, inputSchema: schema(properties, required), annotations: tool.annotations };
  });
}
export const tools = toolsForAccounts([{ name: '', address: '' }]);

export function profileEnvs(env) {
  if (!env.EMAIL_PROFILES) return [{ name: '', env }];
  let profiles;
  try { profiles = JSON.parse(env.EMAIL_PROFILES); } catch { throw new Error('邮箱 profile 配置无效'); }
  if (!Array.isArray(profiles) || profiles.some(profile => !profile || typeof profile.name !== 'string' || typeof profile.config !== 'object' || Array.isArray(profile.config))) throw new Error('邮箱 profile 配置无效');
  // 网络代理是 Hob 给整个进程设的，每个邮箱都要带上
  const network = Object.fromEntries(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'].filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  return profiles.map(profile => ({ name: profile.name, id: profile.id, env: { ...profile.config, ...network, ...(env.EMAIL_DATA && profile.id ? { EMAIL_DATA: join(env.EMAIL_DATA, profile.id) } : {}) } }));
}

export class Email {
  constructor(config, factory = options => new ImapFlow(options)) {
    const raw = Array.isArray(config) ? config : Array.isArray(config?.accounts) ? config.accounts : null;
    this.accounts = raw ? raw.map(account => ({ name: account.name ?? '', address: account.env?.EMAIL_ADDRESS ?? account.config?.address ?? account.address, env: account.env, config: account.config })) : [{ name: config.name ?? '', address: config.address, config }];
    this.factory = factory;
    this.clients = new Map();
    this.configs = new Map();
  }
  accountMetadata() { return this.accounts.map(account => ({ name: account.name, address: account.address })); }
  account(name, args = {}) {
    if (this.accounts.length === 1) return this.accounts[0];
    const requested = args.account;
    const account = this.accounts.find(item => item.name === requested);
    if (!account) throw new Error(`没有叫「${requested}」的邮箱。可选：${this.accounts.map(item => item.name).join('、')}`);
    return account;
  }
  async configFor(account) {
    if (account.config) return account.config;
    if (!this.configs.has(account.name)) this.configs.set(account.name, settings(account.env));
    return this.configs.get(account.name);
  }
  context(c, kind) { const proxy = kind === 'IMAP' ? c.imapProxy : c.smtpProxy; const note = proxy ? `网络代理：${proxyDisplay(proxy)}` : (kind === 'IMAP' ? c.imapProxyNote : c.smtpProxyNote) || '没走网络代理'; return `（${kind} ${c[`${kind.toLowerCase()}Host`]}:${c[`${kind.toLowerCase()}Port`]}，来源：${c[`${kind.toLowerCase()}Source`] ?? '用户填写'}，${note}）`; }
  async connect(name) {
    const account = this.accounts.length === 1 ? this.accounts[0] : this.account(name, { account: name });
    const c = await this.configFor(account);
    const existing = this.clients.get(account.name);
    if (existing?.usable) return existing;
    const secure = (c.imapSocket ?? (c.imapPort === 993 ? 'SSL' : 'STARTTLS')) === 'SSL';
    const options = { host: c.imapHost, port: c.imapPort, secure, doSTARTTLS: local(c.imapHost) ? false : secure ? undefined : true, auth: { user: c.address, pass: c.password }, logger: false, ...(c.imapProxy ? { proxy: c.imapProxy } : {}) };
    const client = this.factory(options);
    client.on('error', () => {});
    try { await client.connect(); } catch (error) { throw new Error(`${errorText(error)}${this.context(c, 'IMAP')}`); }
    this.clients.set(account.name, client);
    if (this.accounts.length === 1) this.client = client;
    return client;
  }
  async locked(accountName, folderName, operation) {
    const client = await this.connect(accountName);
    const lock = await client.getMailboxLock(folderName);
    try { return await operation(client); } finally { lock.release(); }
  }
  async source(accountName, folderName, messageUid) {
    return this.locked(accountName, folderName, async client => {
      const message = await client.fetchOne(messageUid, { source: true }, { uid: true });
      if (!message?.source) throw new Error(`folder「${folderName}」里没有 uid ${messageUid}，用 search_messages 重新查`);
      return simpleParser(message.source);
    });
  }
  async mailbox(accountName, specialUse) {
    const list = await (await this.connect(accountName)).list();
    const item = list.find(x => x.specialUse === specialUse);
    if (!item) throw new Error(`邮箱没有 ${specialUse} 文件夹，请先在邮箱中创建并设置`);
    return item.path;
  }
  async call(name, args = {}) {
    const account = this.account(undefined, args);
    const accountName = account.name;
    const c = await this.configFor(account);
    if (name === 'list_folders') {
      const client = await this.connect(accountName);
      const list = await client.list({ statusQuery: { unseen: true } });
      return list.map(x => { if (x.status?.error) throw x.status.error; return { name: x.path, unread: x.status?.unseen ?? null }; });
    }
    if (name === 'search_messages') return this.locked(accountName, args.folder || 'INBOX', async client => {
      const query = {};
      for (const key of ['from', 'to', 'subject', 'text']) if (args[key]) query[key] = args[key];
      for (const key of ['since', 'before']) if (args[key]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(args[key]) || Number.isNaN(Date.parse(args[key]))) throw new Error(`${key} 请填写 YYYY-MM-DD 日期`);
        query[key] = new Date(`${args[key]}T00:00:00Z`);
      }
      if (args.unread) query.seen = false;
      const limit = args.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit 须在 1 到 100 之间');
      const ids = await client.search(query, { uid: true });
      if (!Array.isArray(ids)) throw new Error('IMAP 搜索没有返回结果，请重试');
      if (!ids.length) return [];
      const messages = [];
      for await (const msg of client.fetch(ids.slice(-limit), { uid: true, envelope: true, flags: true }, { uid: true })) messages.push({ folder: args.folder || 'INBOX', uid: msg.uid, from: msg.envelope?.from, subject: msg.envelope?.subject, date: msg.envelope?.date, seen: msg.flags?.has('\\Seen') });
      return messages.reverse();
    });
    if (name === 'get_message' || name === 'save_attachment') {
      const mail = await this.source(accountName, args.folder, args.uid);
      if (name === 'get_message') return { from: addr(mail.from), to: addr(mail.to), cc: addr(mail.cc), subject: mail.subject, date: mail.date, text: mail.text, attachments: mail.attachments.map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size })) };
      const matches = mail.attachments.filter(a => a.filename === args.filename);
      if (matches.length !== 1) throw new Error(matches.length ? '有多个同名附件，无法确定要保存哪一个' : `没有附件「${args.filename}」，请用 get_message 查看附件列表`);
      if (!c.data) throw new Error('插件数据目录未配置');
      await mkdir(c.data, { recursive: true, mode: 0o700 });
      const path = resolve(c.data, `${randomUUID()}-${basename(args.filename).replace(/[\\/\x00-\x1f]/g, '_')}`);
      await writeFile(path, matches[0].content, { mode: 0o600, flag: 'wx' });
      return { path };
    }
    if (name === 'create_draft' || name === 'send_message') {
      const mail = { from: c.address, to: args.to, cc: args.cc, subject: args.subject, text: args.body };
      if (args.reply_to) {
        const original = await this.source(accountName, args.reply_to.folder, args.reply_to.uid);
        if (original.messageId) { mail.inReplyTo = original.messageId; mail.references = [...(Array.isArray(original.references) ? original.references : original.references ? [original.references] : []), original.messageId]; }
        if (!mail.subject) mail.subject = /^re:/i.test(original.subject ?? '') ? original.subject : `Re: ${original.subject ?? ''}`;
      }
      const target = await this.mailbox(accountName, name === 'create_draft' ? '\\Drafts' : '\\Sent');
      const built = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' }).sendMail(mail);
      if (name === 'send_message') {
        const secure = (c.smtpSocket ?? (c.smtpPort === 465 ? 'SSL' : 'STARTTLS')) === 'SSL';
        const transportOptions = { host: c.smtpHost, port: c.smtpPort, secure, requireTLS: !local(c.smtpHost) && !secure, ignoreTLS: local(c.smtpHost), auth: { user: c.address, pass: c.password }, ...(c.smtpProxy ? { proxy: c.smtpProxy } : {}) };
        const transport = nodemailer.createTransport(transportOptions);
        let sent;
        try { sent = await transport.sendMail({ envelope: built.envelope, raw: built.message }); }
        catch (error) { throw new Error(`${errorText(error)}${this.context(c, 'SMTP')}`); }
        if (sent.rejected?.length) throw new Error(`SMTP 拒绝收件人：${sent.rejected.join(', ')}`);
        try { if (await (await this.connect(accountName)).append(target, built.message, ['\\Seen']) === false) throw new Error('IMAP 没有确认保存'); }
        catch (error) { throw new Error(`邮件已发送，但保存到已发送失败：${errorText(error)}`); }
        return { sent: true, folder: target, messageId: built.messageId };
      }
      if (await (await this.connect(accountName)).append(target, built.message, ['\\Draft']) === false) throw new Error('IMAP 没有确认保存草稿');
      return { saved: true, folder: target, messageId: built.messageId };
    }
    if (name === 'move_message' || name === 'set_flags') return this.locked(accountName, args.folder, async client => {
      const found = await client.fetchOne(args.uid, { uid: true }, { uid: true });
      if (!found) throw new Error(`folder「${args.folder}」里没有 uid ${args.uid}，用 search_messages 重新查`);
      if (name === 'move_message') {
        if (await client.messageMove(args.uid, args.to_folder, { uid: true }) === false) throw new Error('IMAP 没有确认移动邮件');
      } else for (const [key, flag] of [['seen', '\\Seen'], ['flagged', '\\Flagged']]) if (typeof args[key] === 'boolean') {
        const result = await (args[key] ? client.messageFlagsAdd(args.uid, [flag], { uid: true }) : client.messageFlagsRemove(args.uid, [flag], { uid: true }));
        if (result === false) throw new Error(`IMAP 没有确认更新 ${key} 标记`);
      }
      return { updated: true };
    });
    throw new Error(`不认识工具 ${name}`);
  }
  async checkAccounts() {
    const failures = [];
    let connected = 0;
    for (const account of this.accounts) {
      try { await this.connect(account.name); connected++; } catch (error) { failures.push({ name: account.name, reason: errorText(error) }); }
    }
    if (!connected) {
      if (failures.length === 1) throw new Error(failures[0].reason);
      throw new Error(`所有邮箱都连不上：${failures.map(failure => `${failure.name}：${failure.reason}`).join('；')}`);
    }
  }
}

export function run() {
  let email, pending = Promise.resolve();
  const respond = result => process.stdout.write(`${JSON.stringify(result)}\n`);
  const handle = async request => {
    if (request.id === undefined) return;
    try {
      let result;
      if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'email', version: '1.0.0' } };
      else if (request.method === 'ping') result = {};
      else if (request.method === 'tools/list') { email ??= new Email(profileEnvs(process.env)); await email.checkAccounts(); result = { tools: toolsForAccounts(email.accountMetadata()) }; }
      else if (request.method === 'tools/call') {
        try { email ??= new Email(profileEnvs(process.env)); const value = await email.call(request.params.name, request.params.arguments ?? {}); result = { content: [{ type: 'text', text: JSON.stringify(value) }] }; }
        catch (error) { result = { isError: true, content: [{ type: 'text', text: errorText(error) }] }; }
      } else throw new Error(`不支持的方法 ${request.method}`);
      respond({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) { respond({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: errorText(error) } }); }
  };
  createInterface({ input: process.stdin }).on('line', line => { pending = pending.then(() => handle(JSON.parse(line))).catch(error => console.error(error.message)); });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
