// Run after npx vite build. All screenshots use the browser-only mock backend.
import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error('Set CHROME_PATH to the Chrome or Chromium executable.');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--all' || args[1].startsWith('--'))) {
  throw new Error('Usage: node scripts/readme-screenshots.mjs [--all <output-directory>]');
}
const all = args.length === 2;
const output = resolve(all ? args[1] : 'docs/screenshots');
await mkdir(output, { recursive: true });
const root = resolve('dist/web');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let path = resolve(root, `.${pathname}`);
    if (!path.startsWith(root + sep) && path !== root) throw new Error('bad path');
    if (pathname === '/') path = resolve(root, 'index.html');
    const bytes = await readFile(path);
    res.writeHead(200, { 'content-type': mime[extname(path)] ?? 'application/octet-stream' });
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
let browser;
try {
  await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox', '--disable-gpu'] });
  async function open(scene, options = {}) {
    const context = await browser.newContext({ viewport: options.mobile ? { width: 390, height: 844 } : scene === 'rules' ? { width: 960, height: 900 } : { width: 1440, height: 900 }, deviceScaleFactor: 2, isMobile: !!options.mobile, hasTouch: !!options.mobile });
    const page = await context.newPage();
    await page.goto(`${base}?mock=1&scene=readme-${scene}${scene === 'chat' ? '&panel=skills' : scene === 'profile' ? '&panel=now' : ''}${options.desktop ? '&desktop=ready' : ''}${options.hash ?? ''}`);
    if (scene === 'dark' || scene === 'page') await page.evaluate(() => { document.body.style.zoom = '80%'; });
    await page.waitForTimeout(1300);
    return { page, context };
  }
  async function save(page, name) {
    const path = resolve(output, `${name}.jpg`);
    await page.screenshot({ path, type: 'jpeg', quality: 80, animations: 'disabled' });
    const size = (await stat(path)).size;
    if (size > 600 * 1024) throw new Error(`${path}: ${size} bytes exceeds 600 KiB`);
    console.log(`${path}: ${size} bytes`);
  }
  const { page, context } = await open('chat');
  const background = await page.screenshot({ type: 'png', animations: 'disabled' });
  if (all) await save(page, 'chat-original');
  await context.close();

  const cards = await open('cards');
  await cards.page.addStyleTag({ content: `
    .compwrap { visibility: hidden; }
    .col > .b.wide { width: 340px; max-width: 340px; }
    .hov:has(> .delegation-card) { width: 275px; max-width: 275px; }
    .col > .igen { width: 300px; }
    .col > .sys { width: max-content; padding: 10px 12px; border-radius: 14px; background: #f1f1ef; }
  ` });
  async function cut(selector) {
    const element = cards.page.locator(selector);
    await element.scrollIntoViewIfNeeded();
    await cards.page.evaluate((selector) => {
      let parent = document.querySelector(selector)?.parentElement;
      while (parent) {
        parent.style.background = 'transparent';
        parent = parent.parentElement;
      }
    }, selector);
    return (await element.screenshot({ type: 'png', omitBackground: true, animations: 'disabled' })).toString('base64');
  }
  const image = await cut('.igen');
  const delegation = await cut('.delegation-card');
  const draft = await cut('.col > .b.wide');
  const note = await cut('.col > .sys');
  await cards.context.close();

  const composite = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await composite.setContent(`<style>
    html, body { margin: 0; width: 1440px; height: 900px; overflow: hidden; }
    img { display: block; position: absolute; }
    .background { inset: 0; width: 1440px; height: 900px; }
    .float { filter: drop-shadow(0 8px 16px #0003); }
    .draft { left: 1090px; top: 230px; }
    .image { left: 1120px; top: 620px; }
    .delegation { left: 10px; top: 430px; }
    .note { left: 15px; top: 650px; }
  </style>
  <img class="background" src="data:image/png;base64,${background.toString('base64')}">
  <img class="float draft" src="data:image/png;base64,${draft}">
  <img class="float image" src="data:image/png;base64,${image}">
  <img class="float delegation" src="data:image/png;base64,${delegation}">
  <img class="float note" src="data:image/png;base64,${note}">`);
  await composite.evaluate(async () => {
    await Promise.all([...document.images].map((img) => img.decode()));
    document.querySelectorAll('.float').forEach((img) => { img.style.width = `${img.naturalWidth / 2}px`; });
  });
  await save(composite, 'chat');
  await composite.close();
  {
    const phones = [];
    for (const scene of ['list', 'question', 'profile']) {
      const { page, context } = await open(scene, { mobile: true });
      if (scene === 'profile') { await page.getByTitle('助手信息').click(); await page.waitForTimeout(600); }
      phones.push((await page.screenshot({ type: 'png', animations: 'disabled' })).toString('base64'));
      await context.close();
    }
    const mobile = await browser.newPage({ viewport: { width: 1270, height: 900 }, deviceScaleFactor: 2 });
    await mobile.setContent('<style>body{margin:0;background:#f2f1ed;display:flex;justify-content:center;gap:20px;padding:28px 0}img{width:390px;height:844px;border-radius:22px;box-shadow:0 5px 24px #0002}</style>');
    for (const image of phones) await mobile.evaluate((src) => { const img = document.createElement('img'); img.src = `data:image/png;base64,${src}`; document.body.append(img); }, image);
    await save(mobile, 'mobile');
    await mobile.close();
  }
  if (all) {
    for (const [scene, hash] of [['dark', ''], ['rules', '#/settings/rules'], ['page', '']]) {
      const wide = scene === 'dark' || scene === 'page';
      const { page, context } = await open(scene, { hash, desktop: wide });
      if (wide) {
        await page.getByTitle('在侧栏展开').first().click();
        await page.waitForTimeout(300);
        await page.getByText(scene === 'page' ? '团队资料整理方案' : '比较团队知识整理方案', { exact: true }).first().click();
        await page.waitForTimeout(700);
      }
      await save(page, scene);
      await context.close();
    }
    {
      const { page, context } = await open('desktop', { desktop: true });
      await save(page, 'desktop');
      await context.close();
    }
    {
      const { page, context } = await open('knowledge', { hash: '#/knowledge' });
      await page.getByText('团队资料整理方案.html', { exact: true }).first().click();
      await page.waitForTimeout(800);
      await save(page, 'knowledge');
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await new Promise((ok) => server.close(ok));
}
