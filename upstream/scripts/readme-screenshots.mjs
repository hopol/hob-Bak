// Run after npm run build. All screenshots use the browser-only mock backend.
import { chromium } from "playwright-core";
import { createServer } from "node:http";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const chrome = process.env.CHROME_PATH;
if (!chrome) throw new Error("Set CHROME_PATH to the Chrome or Chromium executable.");
const output = resolve("docs/screenshots");
await mkdir(output, { recursive: true });
const root = resolve("dist/web");
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".png": "image/png", ".woff2": "font/woff2", ".woff": "font/woff" };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    let path = resolve(root, `.${pathname}`);
    if (!path.startsWith(root + sep) && path !== root) throw new Error("bad path");
    if (pathname === "/") path = resolve(root, "index.html");
    const bytes = await readFile(path);
    res.writeHead(200, { "content-type": mime[extname(path)] ?? "application/octet-stream" });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});

let browser;
try {
  await new Promise((ok, fail) => server.once("error", fail).listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch({ executablePath: chrome, args: ["--no-sandbox", "--disable-gpu"] });

  async function open(scene, mobile = false) {
    const context = await browser.newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      deviceScaleFactor: 2,
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await context.newPage();
    await page.goto(`${base}?mock=1&scene=${scene}`);
    await page.waitForTimeout(1300);
    return { page, context };
  }

  async function save(page, name) {
    const path = resolve(output, `${name}.png`);
    await page.screenshot({ path, type: "png", animations: "disabled" });
    const size = (await stat(path)).size;
    if (size > 600 * 1024) throw new Error(`${path}: ${size} bytes exceeds 600 KiB`);
    console.log(`${path}: ${size} bytes`);
  }

  const assistant = await open("s1");
  await assistant.page.getByText("交给「写作」", { exact: true }).first().waitFor();
  await save(assistant.page, "assistant");
  await assistant.context.close();

  const pc = await open("readme-group-now");
  await pc.page.getByText("网站加深色模式", { exact: true }).first().waitFor();
  await save(pc.page, "chat");
  await pc.context.close();

  const phones = [];
  for (const scene of ["readme-mobile-list", "readme-mobile-chat", "readme-mobile-project"]) {
    const mobile = await open(scene, true);
    if (scene === "readme-mobile-project") await mobile.page.evaluate(() => { document.body.style.zoom = "90%"; });
    phones.push(await mobile.page.screenshot({ type: "png", animations: "disabled" }));
    await mobile.context.close();
  }
  const composite = await browser.newPage({ viewport: { width: 1270, height: 900 }, deviceScaleFactor: 2 });
  await composite.setContent("<style>body{margin:0;background:#f2f1ed;display:flex;justify-content:center;gap:20px;padding:28px 0}img{width:390px;height:844px;border-radius:22px;box-shadow:0 5px 24px #0002}</style>");
  for (const image of phones) {
    await composite.evaluate((bytes) => {
      const img = document.createElement("img");
      img.src = `data:image/png;base64,${bytes}`;
      document.body.append(img);
    }, image.toString("base64"));
  }
  await composite.evaluate(() => Promise.all([...document.images].map((img) => img.decode())));
  await save(composite, "mobile");
  await composite.close();
} finally {
  await browser?.close();
  await new Promise((ok) => server.close(ok));
}
