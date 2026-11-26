import { describe, expect, it, vi } from 'vitest';
import { discover, settings, Email } from '../mcp/email.mjs';
import { EventEmitter } from 'node:events';

const xml = `<clientConfig><emailProvider><incomingServer type="imap"><hostname>imap.example.test</hostname><port>1143</port><socketType>STARTTLS</socketType></incomingServer><outgoingServer type="smtp"><hostname>smtp.example.test</hostname><port>1465</port><socketType>SSL</socketType></outgoingServer></emailProvider></clientConfig>`;
const response = (ok: boolean) => ({ ok, status: ok ? 200 : 404, text: async () => xml });
const deps = (fetcher: any, mx: any = async () => []) => ({ fetch: fetcher, resolveMx: mx, cache: new Map(), timeoutMs: 20 });

describe('email autoconfig', () => {
  it('uses built-in settings without network and respects explicit values', async () => {
    const fetcher = vi.fn();
    const result = await settings({ EMAIL_ADDRESS: 'test@gmail.com', IMAP_HOST: 'custom.example.test', IMAP_PORT: '999' }, deps(fetcher));
    expect(result).toMatchObject({ imapHost: 'custom.example.test', imapPort: 999, smtpHost: 'smtp.gmail.com', smtpSocket: 'SSL' });
    expect(fetcher).not.toHaveBeenCalled();
    await settings({ EMAIL_ADDRESS: 'test@unknown.test', IMAP_HOST: 'one', SMTP_HOST: 'two' }, deps(fetcher));
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ['139.com', 'imap.139.com', 'smtp.139.com', 465],
    ['sina.com', 'imap.sina.com', 'smtp.sina.com', 465],
    ['sina.cn', 'imap.sina.cn', 'smtp.sina.cn', 465],
    ['aliyun.com', 'imap.aliyun.com', 'smtp.aliyun.com', 465],
    ['live.com', 'outlook.office365.com', 'smtp-mail.outlook.com', 587],
    ['msn.com', 'outlook.office365.com', 'smtp-mail.outlook.com', 587],
  ])('uses verified built-in settings for %s', async (domain, imap, smtp, port) => {
    const fetcher = vi.fn();
    const result = await discover(domain, deps(fetcher));
    expect(result).toMatchObject({ source: '内置列表', imap: { host: imap, port: 993, socket: 'SSL' }, smtp: { host: smtp, port, socket: port === 465 ? 'SSL' : 'STARTTLS' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ['mxbiz1.qq.com', 'imap.exmail.qq.com', 'smtp.exmail.qq.com'],
    ['mxbiz2.qq.com', 'imap.exmail.qq.com', 'smtp.exmail.qq.com'],
    ['hzmx01.mxmail.netease.com', 'imaphz.qiye.163.com', 'smtphz.qiye.163.com'],
    ['mx3.qiye.aliyun.com', 'imap.qiye.aliyun.com', 'smtp.qiye.aliyun.com'],
  ])('matches enterprise MX %s before looking up its parent domain', async (mx, imap, smtp) => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(false)).mockResolvedValue(response(true));
    const result = await discover('example.test', deps(fetcher, async () => [{ priority: 10, exchange: mx }]));
    expect(result).toMatchObject({ source: `MX 内置表（${mx}）`, imap: { host: imap, port: 993, socket: 'SSL' }, smtp: { host: smtp, port: 465, socket: 'SSL' } });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('tries each MX parent domain in order through a multi-level suffix', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(true));
    const result = await discover('example.test', deps(fetcher, async () => [{ priority: 1, exchange: 'a.b.vendor.com.cn' }]));
    expect(fetcher.mock.calls.slice(2).map(call => call[0])).toEqual(['https://autoconfig.thunderbird.net/v1.1/b.vendor.com.cn', 'https://autoconfig.thunderbird.net/v1.1/vendor.com.cn']);
    expect(result.source).toBe('MX 主域名 vendor.com.cn 的 Thunderbird 配置库');
  });
  it('uses provider configuration and caches concurrent lookups', async () => {
    const fetcher = vi.fn(async () => response(true));
    const options = deps(fetcher);
    const [a, b] = await Promise.all([discover('example.test', options), discover('example.test', options)]);
    expect(a).toEqual(b); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(a).toMatchObject({ source: '服务商自动配置', imap: { socket: 'STARTTLS', port: 1143 }, smtp: { socket: 'SSL', port: 1465 } });
  });
  it('uses Thunderbird after provider failure', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(true));
    expect((await discover('example.test', deps(fetcher))).source).toBe('Thunderbird 配置库');
  });
  it('continues after timeout and uses MX host domain in the database', async () => {
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValueOnce(response(false)).mockResolvedValueOnce(response(true));
    const result = await discover('example.test', deps(fetcher, async () => [{ priority: 10, exchange: 'mx.vendor.test' }]));
    expect(result.source).toBe('MX 主域名 vendor.test 的 Thunderbird 配置库');
    expect(fetcher.mock.calls[2][0]).toBe('https://autoconfig.thunderbird.net/v1.1/vendor.test');
  });
  it('reports every failed step', async () => {
    await expect(discover('example.test', deps(async () => response(false), async () => [{ priority: 10, exchange: 'mx.vendor.test' }]))).rejects.toThrow('认不出 example.test 的邮件服务器：内置列表里没有；服务商自动配置：HTTP 404；Thunderbird 配置库：HTTP 404；MX 是 mx.vendor.test；MX 主域名 vendor.test 的 Thunderbird 配置库：HTTP 404。请在「更多设置」里填 IMAP 服务器和 SMTP 服务器');
  });
  it('applies discovered IMAP security independently of its port and retains server errors', async () => {
    const config = await settings({ EMAIL_ADDRESS: 'a@example.test' }, deps(async () => response(true)));
    let options: any;
    const client = new EventEmitter() as any;
    client.connect = async () => { throw new Error('server refusal'); };
    await expect(new Email(config, (value: any) => { options = value; return client; }).connect()).rejects.toThrow('server refusal（IMAP imap.example.test:1143，来源：服务商自动配置，没走网络代理：Hob 没有设置网络代理（设置 → 通用 → 网络代理））');
    expect(options).toMatchObject({ secure: false, doSTARTTLS: true });
    config.imapSocket = 'SSL';
    await expect(new Email(config, (value: any) => { options = value; return client; }).connect()).rejects.toThrow('server refusal');
    expect(options.secure).toBe(true);
  });
  it('passes the process proxy to IMAP and redacts proxy credentials in errors', async () => {
    let options: any;
    const client = new EventEmitter() as any;
    client.connect = async () => { throw new Error('proxy refusal'); };
    const config = await settings({ EMAIL_ADDRESS: 'a@example.test', IMAP_HOST: 'imap.example.test', IMAP_PORT: '993', SMTP_HOST: 'smtp.example.test', SMTP_PORT: '465', HTTPS_PROXY: 'http://user:password@127.0.0.1:1080' });
    await expect(new Email(config, value => { options = value; return client; }).connect()).rejects.toThrow('网络代理：http://127.0.0.1:1080');
    expect(options.proxy).toBe(config.imapProxy);
  });
});
