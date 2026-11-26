import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer as createNetServer, type Socket } from 'node:net';
import { createServer as createTlsServer, createSecureContext, TLSSocket } from 'node:tls';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { SMTPServer } from 'smtp-server';

// Public test fixture only. NODE_EXTRA_CA_CERTS lets the child trust this certificate;
// all normal certificate and hostname verification remains enabled.
const certPath = fileURLToPath(new URL('./fixtures/email-test-cert.pem', import.meta.url));
const cert = readFileSync(certPath), key = readFileSync(new URL('./fixtures/email-test-key.pem', import.meta.url));
const run = promisify(execFile);
const host = '127.0.0.2';
const child = async (script: string, trust = true) => run(process.execPath, ['--input-type=module', '-e', script], {
  cwd: process.cwd(), env: { ...process.env, NODE_EXTRA_CA_CERTS: trust ? certPath : '' }, timeout: 10000,
});

function imapServer(implicit: boolean) {
  let authenticatedOverTls = false;
  const context = createSecureContext({ cert, key });
  const serve = (socket: Socket | TLSSocket, encrypted: boolean) => {
    socket.on('error', () => {});
    if (implicit || !encrypted) socket.write('* OK test IMAP ready\r\n');
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString();
      let end: number;
      while ((end = input.indexOf('\r\n')) >= 0) {
        const line = input.slice(0, end); input = input.slice(end + 2);
        const [tag, command] = line.split(' ');
        if (command?.toUpperCase() === 'CAPABILITY') socket.write(`* CAPABILITY IMAP4rev1${encrypted ? '' : ' STARTTLS'}\r\n${tag} OK CAPABILITY\r\n`);
        else if (command?.toUpperCase() === 'STARTTLS') {
          socket.write(`${tag} OK Begin TLS\r\n`);
          socket.removeAllListeners('data');
          const upgraded = new TLSSocket(socket, { isServer: true, secureContext: context });
          serve(upgraded, true);
          return;
        } else if (command?.toUpperCase() === 'LOGIN') {
          authenticatedOverTls = encrypted;
          socket.write(`${tag} NO [AUTHENTICATIONFAILED] test refusal\r\n`);
        } else socket.write(`${tag} OK done\r\n`);
      }
    });
  };
  const server = implicit ? createTlsServer({ cert, key }, socket => serve(socket, true)) : createNetServer(socket => serve(socket, false));
  server.on('tlsClientError', () => {});
  return { server, authenticatedOverTls: () => authenticatedOverTls };
}

const imapChild = (port: number, socket: string) => `
  import { Email } from './server/mcp/email.mjs';
  const email = new Email({ address: 'sample@example.test', password: 'test', imapHost: '${host}', imapPort: ${port}, imapSocket: '${socket}' });
  try { await email.connect(); process.exitCode = 1; }
  catch (error) { if (!error.message.includes('test refusal')) { console.error(error.message); process.exitCode = 1; } }
`;
const smtpChild = (port: number, socket: string) => `
  import { EventEmitter } from 'node:events';
  import { Email } from './server/mcp/email.mjs';
  class FakeImap extends EventEmitter {
    usable = true;
    async connect() {}
    async list() { return [{ path: 'Sent', specialUse: '\\\\Sent' }]; }
    async append() { return true; }
  }
  const email = new Email({ address: 'sender@example.test', password: 'test', smtpHost: '${host}', smtpPort: ${port}, smtpSocket: '${socket}' }, () => new FakeImap());
  const result = await email.call('send_message', { to: 'recipient@example.test', subject: 'Test', body: 'Local test' });
  if (!result.sent) process.exitCode = 1;
`;

describe('email TLS connections', () => {
  it.each([['SSL'], ['STARTTLS']] as const)('IMAP %s performs a verified TLS handshake', async (mode) => {
    const fixture = imapServer(mode === 'SSL');
    const port = await new Promise<number>((resolve, reject) => fixture.server.once('error', reject).listen(0, host, () => resolve((fixture.server.address() as import('node:net').AddressInfo).port)));
    try {
      if (mode === 'SSL') await expect(child(imapChild(port, mode), false)).rejects.toThrow();
      await child(imapChild(port, mode));
      expect(fixture.authenticatedOverTls()).toBe(true);
    } finally { await new Promise<void>(resolve => fixture.server.close(() => resolve())); }
  });
  it.each([['SSL'], ['STARTTLS']] as const)('SMTP %s performs a verified TLS handshake', async (mode) => {
    let secureAuth = false, received = false;
    const smtp = new SMTPServer({ cert, key, secure: mode === 'SSL', onAuth(_auth, session, done) { secureAuth = session.secure; done(null, { user: 'sample' }); }, onData(stream, _session, done) { stream.on('data', () => { received = true; }); stream.on('end', () => done()); } });
    const port = await new Promise<number>((resolve, reject) => smtp.once('error', reject).listen(0, host, () => resolve((smtp.server.address() as import('node:net').AddressInfo).port)));
    try {
      await child(smtpChild(port, mode));
      expect(secureAuth).toBe(true);
      expect(received).toBe(true);
    } finally { await new Promise<void>(resolve => smtp.close(() => resolve())); }
  });
});
