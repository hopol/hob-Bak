import { describe, expect, it, afterEach } from 'vitest';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import { Email, profileEnvs, settings, toolsForAccounts } from '../mcp/email.mjs';
import { PluginHost } from '../src/plugin-host.ts';
import { pluginConfig, resolvePluginMcp } from '../src/plugin-config.ts';
import { seedPluginSource } from './helpers.ts';

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
const home = () => { const p = mkdtempSync(join(tmpdir(), 'hob-email-test-')); homes.push(p); seedPluginSource(p); return p; };
const config = (ports = { imapPort: 0, smtpPort: 0 }) => ({ address: 'tester@example.test', password: 'password', imapHost: '127.0.0.1', smtpHost: '127.0.0.1', ...ports, data: home() });
const raw = Buffer.from('From: sender@example.test\r\nTo: tester@example.test\r\nSubject: Example\r\nMessage-ID: <original@example.test>\r\nReferences: <earlier@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="abc"\r\n\r\n--abc\r\nContent-Type: text/plain\r\n\r\nHello\r\n--abc\r\nContent-Type: text/plain; name="note.txt"\r\nContent-Disposition: attachment; filename="note.txt"\r\n\r\nAttachment\r\n--abc--\r\n');
class FakeImap extends EventEmitter {
  usable = true; calls: any[] = []; appended: any[] = [];
  async connect() {} async getMailboxLock(folder: string) { this.calls.push(['lock', folder]); return { release() {} }; }
  async list() { return [{ path: 'INBOX', status: { unseen: 2 } }, { path: 'Drafts', specialUse: '\\Drafts' }, { path: 'Sent', specialUse: '\\Sent' }]; }
  async search(query: any) { this.calls.push(['search', query]); return [2, 3]; }
  async *fetch() { yield { uid: 2, envelope: { subject: 'First' }, flags: new Set() }; yield { uid: 3, envelope: { subject: 'Second' }, flags: new Set(['\\Seen']) }; }
  async fetchOne(id: number, query: any) { if (id === 99) return false; return query.source ? { source: raw } : { uid: id }; }
  async append(...args: any[]) { this.appended.push(args); }
  async messageMove(...args: any[]) { this.calls.push(['move', ...args]); }
  async messageFlagsAdd(...args: any[]) { this.calls.push(['add', ...args]); }
  async messageFlagsRemove(...args: any[]) { this.calls.push(['remove', ...args]); }
}

describe('email service', () => {
  it('resolves provider defaults and reports invalid domains', async () => {
    for (const domain of ['gmail.com', 'googlemail.com', 'qq.com', '163.com', '126.com', 'outlook.com', 'hotmail.com']) expect((await settings({ EMAIL_ADDRESS: `a@${domain}` })).imapHost).toBeTruthy();
    await expect(settings({ EMAIL_ADDRESS: 'invalid' })).rejects.toThrow('邮箱地址的域名无效');
  });
  it('uses the process proxy in precedence order and applies NO_PROXY per mail server', async () => {
    const value = await settings({ EMAIL_ADDRESS: 'a@example.test', IMAP_HOST: 'imap.example.test', SMTP_HOST: 'smtp.example.test', IMAP_PORT: '993', SMTP_PORT: '465', HTTPS_PROXY: 'http://user:pass@proxy.example.test:8080', ALL_PROXY: 'http://fallback.example.test:8080', HTTP_PROXY: 'http://last.example.test:8080', NO_PROXY: 'smtp.example.test', PROXY: 'http://old.example.test:8080' });
    expect(value.imapProxy).toBe('http://user:pass@proxy.example.test:8080');
    expect(value.smtpProxy).toBeUndefined();
  });
  it('uses generic path variables without treating them as secrets', () => {
    const mcp = { mcpServers: { x: { command: 'node', args: ['${hob.root}/server.mjs'], env: { DATA: '${hob.plugin_data}' } } } };
    const fields = pluginConfig({}, mcp);
    expect(Object.keys(fields)).toEqual([]);
    expect(resolvePluginMcp(mcp, fields, {}, { root: '/opt/hob', plugin_root: '/data/plugin', plugin_data: '/data/files' })).toEqual({ mcpServers: { x: { command: 'node', args: ['/opt/hob/server.mjs'], env: { DATA: '/data/files' } } } });
  });
  it('adds account selection only for multiple profiles and isolates account state', async () => {
    const one = toolsForAccounts([{ name: '工作邮箱', address: 'work@corp.example' }]);
    expect(one.find(tool => tool.name === 'search_messages')!.inputSchema.properties).not.toHaveProperty('account');
    const many = toolsForAccounts([{ name: '工作邮箱', address: 'work@corp.example' }, { name: 'QQ 邮箱', address: '12345@qq.com' }]);
    const search = many.find(tool => tool.name === 'search_messages')!;
    expect(search.inputSchema.required).toContain('account');
    expect(search.inputSchema.properties.account).toMatchObject({ enum: ['工作邮箱', 'QQ 邮箱'], description: '用哪个邮箱，填名称。可选：工作邮箱（work@corp.example）、QQ 邮箱（12345@qq.com）。' });
    const firstData = home(), secondData = home();
    const email = new Email([
      { name: '工作邮箱', config: { ...config(), address: 'work@corp.example', imapHost: 'one.example.test', data: firstData } },
      { name: 'QQ 邮箱', config: { ...config(), address: '12345@qq.com', imapHost: 'two.example.test', data: secondData } },
    ], () => new FakeImap());
    await expect(email.call('list_folders', { account: '不存在' })).rejects.toThrow('没有叫「不存在」的邮箱。可选：工作邮箱、QQ 邮箱');
    const first = await email.call('save_attachment', { account: '工作邮箱', folder: 'INBOX', uid: 2, filename: 'note.txt' });
    const second = await email.call('save_attachment', { account: 'QQ 邮箱', folder: 'INBOX', uid: 2, filename: 'note.txt' });
    expect(first.path.startsWith(firstData)).toBe(true);
    expect(second.path.startsWith(secondData)).toBe(true);
    expect(first.path).not.toBe(second.path);
  });

  it('searches, reads, saves attachments, drafts, moves and flags', async () => {
    const fake = new FakeImap(), c = config(), email = new Email(c, () => fake);
    expect(await email.call('list_folders', {})).toContainEqual({ name: 'INBOX', unread: 2 });
    const result = await email.call('search_messages', { from: 'sender', to: 'tester', subject: 'Example', text: 'Hello', unread: true, since: '2026-01-01', before: '2026-02-01' });
    expect(result.map((x: any) => x.uid)).toEqual([3, 2]);
    expect(fake.calls.find(x => x[0] === 'search')[1]).toMatchObject({ from: 'sender', to: 'tester', subject: 'Example', text: 'Hello', seen: false, since: new Date('2026-01-01'), before: new Date('2026-02-01') });
    const message = await email.call('get_message', { folder: 'INBOX', uid: 2 });
    expect(message.text).toContain('Hello'); expect(message.attachments[0].filename).toBe('note.txt');
    const saved = await email.call('save_attachment', { folder: 'INBOX', uid: 2, filename: 'note.txt' });
    expect(readFileSync(saved.path, 'utf8')).toBe('Attachment');
    await email.call('create_draft', { to: 'sender@example.test', body: 'Reply', reply_to: { folder: 'INBOX', uid: 2 } });
    expect(fake.appended[0][0]).toBe('Drafts');
    const draft = await simpleParser(fake.appended[0][1]);
    expect(draft.subject).toBe('Re: Example'); expect(draft.inReplyTo).toBe('<original@example.test>'); expect(draft.references).toContain('<earlier@example.test>');
    await email.call('move_message', { folder: 'INBOX', uid: 2, to_folder: 'Archive' });
    await email.call('set_flags', { folder: 'INBOX', uid: 2, seen: true, flagged: false });
    expect(fake.calls.map(x => x[0])).toEqual(expect.arrayContaining(['move', 'add', 'remove']));
    await expect(email.call('get_message', { folder: 'INBOX', uid: 99 })).rejects.toThrow('folder「INBOX」里没有 uid 99，用 search_messages 重新查');
  });
  it('sends through SMTP and copies the message to Sent', async () => {
    const received: Buffer[] = [];
    const smtp = new SMTPServer({ authOptional: true, disabledCommands: ['STARTTLS', 'AUTH'], onData(stream, _session, done) { stream.on('data', chunk => received.push(chunk)); stream.on('end', () => done()); } });
    const smtpPort = await new Promise<number>((resolve, reject) => smtp.once('error', reject).listen(0, '127.0.0.1', () => resolve((smtp.server.address()).port)));
    try {
      const fake = new FakeImap(), email = new Email(config({ imapPort: 0, smtpPort }), () => fake);
      await email.call('send_message', { to: 'recipient@example.test', subject: 'Hello', body: 'Test body' });
      expect((await simpleParser(Buffer.concat(received))).text).toContain('Test body'); expect(fake.appended[0][0]).toBe('Sent');
    } finally { await new Promise<void>(resolve => smtp.close(() => resolve())); }
  });
  it('does not report success when IMAP refuses an operation', async () => {
    const fake = new FakeImap(), email = new Email(config(), () => fake);
    fake.search = async () => false as any;
    await expect(email.call('search_messages', {})).rejects.toThrow('IMAP 搜索没有返回结果');
    fake.append = async () => false as any;
    await expect(email.call('create_draft', { to: 'a@example.test', body: 'Test' })).rejects.toThrow('IMAP 没有确认保存草稿');
    fake.messageMove = async () => false as any;
    await expect(email.call('move_message', { folder: 'INBOX', uid: 2, to_folder: 'Archive' })).rejects.toThrow('IMAP 没有确认移动邮件');
  });
  it('reports connection errors with their original message and a redacted proxy', async () => {
    const broken = new FakeImap(); broken.connect = async () => { throw new Error('AUTHENTICATIONFAILED invalid credentials'); };
    await expect(new Email({ ...config(), imapProxy: 'http://proxy-user:proxy-pass@proxy.example.test:8080' }, () => broken).call('list_folders', {})).rejects.toThrow('AUTHENTICATIONFAILED invalid credentials');
    await expect(new Email({ ...config(), imapProxy: 'http://proxy-user:proxy-pass@proxy.example.test:8080' }, () => broken).call('list_folders', {})).rejects.toThrow('网络代理：http://proxy.example.test:8080');
    await expect(new Email({ ...config(), imapProxy: 'http://proxy-user:proxy-pass@proxy.example.test:8080' }, () => broken).call('list_folders', {})).rejects.not.toThrow('proxy-pass');
  });
  it('reports an IMAP authentication refusal in the installed plugin status', async () => {
    const server = createServer(socket => {
      socket.write('* OK test IMAP ready\r\n');
      let input = '';
      socket.on('data', chunk => {
        input += chunk.toString();
        let end: number;
        while ((end = input.indexOf('\r\n')) >= 0) {
          const line = input.slice(0, end); input = input.slice(end + 2);
          const [tag, command] = line.split(' ');
          if (command?.toUpperCase() === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK CAPABILITY complete\r\n`);
          else if (command?.toUpperCase() === 'LOGIN') socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid test credentials\r\n`);
          else socket.write(`${tag} OK complete\r\n`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const imapPort = (server.address()).port;
    const host = new PluginHost(home());
    host.store.install('email'); host.store.saveConfig('email', { EMAIL_ADDRESS: 'a@example.test', EMAIL_PASSWORD: 'sample', IMAP_HOST: '127.0.0.1', IMAP_PORT: imapPort, SMTP_HOST: '127.0.0.1' });
    try {
      await host.start();
      expect(host.states('email')[0]).toMatchObject({ status: 'error', error: expect.stringContaining('AUTHENTICATIONFAILED') });
      expect(host.states('email')[0].error).toContain('Invalid test credentials');
    } finally { await host.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('starts the bundled server from a simulated npm package location', async () => {
    const packageDir = join(home(), 'node_modules', 'hob-bot');
    mkdirSync(join(packageDir, 'server', 'mcp'), { recursive: true });
    cpSync(new URL('../mcp/email.mjs', import.meta.url), join(packageDir, 'server', 'mcp', 'email.mjs'));
    symlinkSync(join(process.cwd(), 'node_modules'), join(packageDir, 'node_modules'), 'dir');
    const child = spawn(process.execPath, [join(packageDir, 'server/mcp/email.mjs')], { cwd: home(), env: { ...process.env, EMAIL_ADDRESS: 'invalid' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = new Promise<string>((resolve, reject) => {
      let text = '';
      child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(text); });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`server exited ${code}`)));
    });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
      expect(JSON.parse((await output).trim()).error.message).toContain('邮箱地址的域名无效');
    } finally { child.stdin.end(); await new Promise<void>(resolve => child.once('exit', () => resolve())); }
  });
  it('installs the service and reports missing server settings', async () => {
    const h = home(), host = new PluginHost(h);
    host.store.install('email'); host.store.saveConfig('email', { EMAIL_ADDRESS: 'invalid', EMAIL_PASSWORD: 'sample' });
    try { await host.start(); expect(host.states('email')[0]).toMatchObject({ status: 'error', error: expect.stringContaining('邮箱地址的域名无效') }); }
    finally { await host.close(); }
  });
});

it('每个邮箱 profile 都带上 Hob 给进程设的网络代理', async () => {
  const [work, home] = profileEnvs({ EMAIL_PROFILES: JSON.stringify([{ name: '工作', config: { EMAIL_ADDRESS: 'a@gmail.com', EMAIL_PASSWORD: 'x' } }, { name: '家里', config: { EMAIL_ADDRESS: 'b@qq.com', EMAIL_PASSWORD: 'y' } }]), HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost' });
  for (const account of [work, home]) expect(account.env).toMatchObject({ HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost' });
  const config = await settings(work.env);
  expect(config.imapProxy).toBe('http://127.0.0.1:7890');
  expect(config.smtpProxy).toBe('http://127.0.0.1:7890');
});
