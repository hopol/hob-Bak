import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import { tmpdir } from "node:os";
import { dirname, basename, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import type { HobRuntime } from "../src/runtime.ts";
import { makeHob } from "./helpers.ts";

/** 登录拿 cookie：/api/* 都要它。 */
async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

async function appWithCookie(runtime: HobRuntime, home: string) {
  const app = createApp(runtime, { home });
  return { app, cookie: await signIn(app) };
}

describe("GET /api/files 的安全规则", () => {
  it("符号链接指出 HOB_HOME 的 → 403，目录里的正常文件照常", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const work = join(hob.home, "assistants", "hob", "jobs", "t-aaaa", "work");
      mkdirSync(work, { recursive: true });
      // 指向数据目录外的链接：解开 realpath 后不在 HOB_HOME 里
      symlinkSync(join(tmpdir(), "..", "etc", "hostname"), join(work, "escape"));
      const outside = await app.request(`/api/files?path=${encodeURIComponent(join(work, "escape"))}`, { headers: { cookie } });
      expect(outside.status).toBe(403);

      writeFileSync(join(work, "ok.txt"), "正常");
      const inside = await app.request(`/api/files?path=${encodeURIComponent(join(work, "ok.txt"))}`, { headers: { cookie } });
      expect(inside.status).toBe(200);
      expect(await inside.text()).toBe("正常");
    } finally {
      hob.close();
    }
  });

  it("凭据和内部状态整个不给读：system/ 下面的都不给，根上的凭据和备份目录也不给", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      mkdirSync(join(hob.home, "system", "engine"), { recursive: true });
      mkdirSync(join(hob.home, "system", "lore"), { recursive: true });
      mkdirSync(join(hob.home, "backup-v1-2026-11-07T00-00-00-000Z"), { recursive: true });
      const secret = '{"provider:openai":"sk-x"}';
      for (const rel of [
        "system/secrets.json",
        "system/config.json",
        "system/settings.json",
        "system/push.json",
        "system/engine/auth.json",
        "system/lore/config.json",
        "system/secrets.json.1234.tmp",
        "notes.bak",
        "backup-v1-2026-11-07T00-00-00-000Z/system/secrets.json",
      ]) {
        mkdirSync(dirname(join(hob.home, rel)), { recursive: true });
        writeFileSync(join(hob.home, rel), secret);
        const response = await app.request(`/api/files?path=${encodeURIComponent(join(hob.home, rel))}`, { headers: { cookie } });
        expect(response.status, rel).toBe(403);
        // 元数据接口同样不给
        const meta = await app.request(`/api/files/meta?path=${encodeURIComponent(join(hob.home, rel))}`, { headers: { cookie } });
        expect(meta.status, rel).toBe(403);
      }
    } finally {
      hob.close();
    }
  });

  it("moves.json 记下的老路径能打开新位置", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const from = join(hob.home, "pages", "11111111-1111-1111-1111-111111111111.html");
      const to = join(hob.home, "assistants", "hob", "files", "pages", "11111111-1111-1111-1111-111111111111.html");
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, "<p>页面</p>");
      mkdirSync(join(hob.home, "system"), { recursive: true });
      writeFileSync(join(hob.home, "system", "moves.json"), JSON.stringify({ version: 2, entries: [{ from: join(hob.home, "pages"), to: join(hob.home, "assistants", "hob", "files", "pages") }] }));
      const response = await app.request(`/api/files?path=${encodeURIComponent(from)}`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("<p>页面</p>");
      const meta = await app.request(`/api/files/meta?path=${encodeURIComponent(from)}`, { headers: { cookie } });
      expect((await meta.json()) as { page?: boolean }).toMatchObject({ page: true });
    } finally {
      hob.close();
    }
  });

  it("能执行脚本的类型：默认附件下载 + sandbox CSP + nosniff，?inline=1 才内联", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const uploads = join(hob.home, "assistants", "hob", "files", "uploads");
      mkdirSync(uploads, { recursive: true });
      const html = join(uploads, "报告.html");
      writeFileSync(html, "<html><script>fetch('/api/settings')</script></html>");
      const svg = join(uploads, "图.svg");
      writeFileSync(svg, "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");

      const htmlResponse = await app.request(`/api/files?path=${encodeURIComponent(html)}`, { headers: { cookie } });
      expect(htmlResponse.status).toBe(200);
      expect(htmlResponse.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(htmlResponse.headers.get("x-content-type-options")).toBe("nosniff");
      expect(htmlResponse.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
      expect(htmlResponse.headers.get("content-disposition")).toMatch(/^attachment;/);

      const inline = await app.request(`/api/files?path=${encodeURIComponent(html)}&inline=1`, { headers: { cookie } });
      expect(inline.headers.get("content-disposition")).toMatch(/^inline;/);
      expect(inline.headers.get("content-security-policy")).toBe("sandbox allow-scripts");

      // svg 也一样：sandbox（不给跑脚本）+ 默认附件
      const svgResponse = await app.request(`/api/files?path=${encodeURIComponent(svg)}`, { headers: { cookie } });
      expect(svgResponse.headers.get("content-security-policy")).toBe("sandbox");
      expect(svgResponse.headers.get("content-disposition")).toMatch(/^attachment;/);
    } finally {
      hob.close();
    }
  });

  it("正常图片照常给，带 nosniff", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const uploads = join(hob.home, "assistants", "hob", "files", "uploads");
      mkdirSync(uploads, { recursive: true });
      const png = join(uploads, "图.png");
      writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const response = await app.request(`/api/files?path=${encodeURIComponent(png)}`, { headers: { cookie } });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("content-disposition")).toBeNull();
    } finally {
      hob.close();
    }
  });
});

describe("POST /api/assistants/:id/messages 带附件", () => {
  it("只发图片不写字也行；字和附件都没有才报空", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const png = join(hob.home, "assistants", "hob", "files", "uploads", "u-abc-图.png");
      mkdirSync(join(hob.home, "assistants", "hob", "files", "uploads"), { recursive: true });
      writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      hob.faux.setResponses([fauxAssistantMessage("收到图片。")]);
      const post = (body: unknown) => app.request("/api/assistants/hob/messages", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });

      const sent = await post({ text: "", files: [png] });
      expect(sent.status).toBe(202);
      expect(((await sent.json()) as { item: unknown }).item).toMatchObject({ kind: "user", text: "", files: [png] });
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.router.items("hob").items.at(-1)).toMatchObject({ kind: "assistant", text: "收到图片。" });

      expect((await post({ text: "  " })).status).toBe(400);
      expect((await post({ text: "", files: [] })).status).toBe(400);
    } finally {
      hob.close();
    }
  });
});

describe("对话里发图片", () => {
  for (const [label, input, expected] of [["能看图的对话模型直接收到图片", ["text", "image"], 1], ["看不了图的只收到路径", ["text"], 0]] as const) {
    it(label, async () => {
      const hob = makeHob({}, { models: [{ id: "faux-1", input: [...input] }] });
      try {
        const png = join(hob.home, "assistants", "hob", "files", "uploads", "u-abc123-饭.png");
        mkdirSync(join(hob.home, "assistants", "hob", "files", "uploads"), { recursive: true });
        // 真的 1×1 PNG：引擎会检查 / 缩放图片，坏图会被丢掉
        writeFileSync(png, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
        let seen: unknown[] = [];
        hob.faux.setResponses([
          (context) => {
            const last = context.messages.at(-1) as { content: unknown };
            seen = Array.isArray(last.content) ? last.content : [];
            return fauxAssistantMessage("是红烧肉。");
          },
        ]);
        await hob.runtime.router.send("hob", { text: "我吃的啥", files: [png] });
        await hob.runtime.router.waitIdle("hob");
        const images = seen.filter((part) => (part as { type: string }).type === "image") as { mimeType: string; data: string }[];
        expect(images).toHaveLength(expected);
        if (expected) expect(images[0].mimeType).toMatch(/^image\//);
        // 路径总在文字里，派任务时还能交出去
        expect(JSON.stringify(seen)).toContain(png);
      } finally {
        hob.close();
      }
    });
  }
});

/** 纯色 PNG（不靠图片库）：IHDR + 一整块 deflate 的扫描行。 */
function solidPng(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc(body), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8 位
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

describe("对话里的缩略图", () => {
  it("大图 ?thumb=1 给长边不超过 720 的小图，并缓存；小图直接给原图", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      mkdirSync(join(hob.home, "assistants", "hob", "files", "uploads"), { recursive: true });
      const big = join(hob.home, "assistants", "hob", "files", "uploads", "u-abc123-大.png");
      const small = join(hob.home, "assistants", "hob", "files", "uploads", "u-abc123-小.png");
      writeFileSync(big, solidPng(2000, 1500));
      writeFileSync(small, solidPng(200, 150));

      const thumb = await app.request(`/api/files?path=${encodeURIComponent(big)}&thumb=1`, { headers: { cookie } });
      expect(thumb.status).toBe(200);
      expect(thumb.headers.get("content-type")).toMatch(/^image\/(jpeg|png)$/);
      const bytes = Buffer.from(await thumb.arrayBuffer());
      const resized = await resizeImage(bytes, thumb.headers.get("content-type")!, { maxWidth: 10_000, maxHeight: 10_000 });
      expect(Math.max(resized!.originalWidth, resized!.originalHeight)).toBe(720);
      expect(readdirSync(join(hob.home, "cache", "thumbs")).filter((name) => !name.endsWith(".orig"))).toHaveLength(1);

      const original = await app.request(`/api/files?path=${encodeURIComponent(small)}&thumb=1`, { headers: { cookie } });
      expect(Buffer.from(await original.arrayBuffer()).equals(readFileSync(small))).toBe(true);
      // 不带 thumb 的还是原图
      const full = await app.request(`/api/files?path=${encodeURIComponent(big)}`, { headers: { cookie } });
      expect(Buffer.from(await full.arrayBuffer()).equals(readFileSync(big))).toBe(true);
    } finally {
      hob.close();
    }
  });
});

describe("GET /api/files/meta", () => {
  it("给预览面板要的元数据：类型、是否文本；不认识的扩展名按内容嗅探", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const work = join(hob.home, "assistants", "hob", "jobs", "t-bbbb", "work");
      mkdirSync(work, { recursive: true });
      writeFileSync(join(work, "说明.md"), "# hi");
      writeFileSync(join(work, "README"), "plain text no ext");
      writeFileSync(join(work, "blob"), Buffer.from([0, 1, 2, 3]));

      const md = await app.request(`/api/files/meta?path=${encodeURIComponent(join(work, "说明.md"))}`, { headers: { cookie } });
      expect(md.status).toBe(200);
      expect(((await md.json()) as { kind: string; text: boolean; mime: string }).kind).toBe("markdown");

      const noExt = await app.request(`/api/files/meta?path=${encodeURIComponent(join(work, "README"))}`, { headers: { cookie } });
      expect(((await noExt.json()) as { kind: string; text: boolean }).kind).toBe("text");

      const bin = await app.request(`/api/files/meta?path=${encodeURIComponent(join(work, "blob"))}`, { headers: { cookie } });
      const binMeta = (await bin.json()) as { kind: string; text: boolean };
      expect(binMeta.kind).toBe("other");
      expect(binMeta.text).toBe(false);
    } finally {
      hob.close();
    }
  });
});

describe("GET /api/files 读任务工作目录", () => {
  it("任务工作目录在数据目录外的也能读；包含数据目录的太宽不算；密钥和 .env 不给", async () => {
    const hob = makeHob();
    const project = mkdtempSync(join(tmpdir(), "hob-proj-"));
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const job = (id: string, cwd: string) => hob.runtime.store.saveJob({
        id, assistantId: "hob", title: "干活", instruction: "干活", kind: "local", status: "done", cwd,
        createdAt: "2026-11-01T01:00:00.000Z", stats: { reads: 0, commands: 0, edits: 0 }, activity: [],
      });
      const get = (path: string) => app.request(`/api/files/meta?path=${encodeURIComponent(path)}`, { headers: { cookie } });
      mkdirSync(join(project, "report"), { recursive: true });
      mkdirSync(join(project, ".ssh"), { recursive: true });
      writeFileSync(join(project, "report", "比对.md"), "# 报告");
      writeFileSync(join(project, ".env"), "TOKEN=x");
      writeFileSync(join(project, ".ssh", "config"), "x");
      expect((await get(join(project, "report", "比对.md"))).status).toBe(403);

      job("t-dd01", project);
      expect((await get(join(project, "report", "比对.md"))).status).toBe(200);
      expect((await get(join(project, ".env"))).status).toBe(403);
      expect((await get(join(project, ".ssh", "config"))).status).toBe(403);

      // 工作目录是数据目录的上级（比如家目录）：不因此放开上级目录里的其它文件
      const sibling = join(hob.home, "..", `${basename(hob.home)}-sibling.txt`);
      writeFileSync(sibling, "x");
      job("t-dd02", join(hob.home, ".."));
      expect((await get(sibling)).status).toBe(403);
    } finally {
      rmSync(project, { recursive: true, force: true });
      hob.close();
    }
  });
});

describe("GET /api/jobs/:id/files", () => {
  it("只列一层、目录在前、文件按修改时间倒序，并拒绝越界路径", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      hob.runtime.store.saveJob({
        id: "t-cc01",
        assistantId: "hob",
        title: "干活",
        instruction: "干活",
        kind: "local",
        status: "done",
        createdAt: "2026-11-01T01:00:00.000Z",
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      });
      const work = hob.runtime.store.workDir("t-cc01");
      mkdirSync(join(work, "src", "deep"), { recursive: true });
      mkdirSync(join(work, "node_modules", "pkg"), { recursive: true });
      mkdirSync(join(work, ".git"), { recursive: true });
      writeFileSync(join(work, "新.txt"), "a");
      writeFileSync(join(work, "旧.txt"), "a");
      utimesSync(join(work, "旧.txt"), new Date(1000), new Date(1000));
      writeFileSync(join(work, "src", "main.ts"), "b");
      symlinkSync(tmpdir(), join(work, "escape"));
      symlinkSync(join(work, "新.txt"), join(work, "link.txt"));
      const get = (path = "") => app.request(`/api/jobs/t-cc01/files${path ? `?path=${encodeURIComponent(path)}` : ""}`, { headers: { cookie } });
      const response = await get();
      expect(response.status).toBe(200);
      const body = await response.json() as { files: { rel: string; type: string; count?: number }[]; total: number; fileCount: number; directoryCount: number };
      expect(body.files.map((file) => file.rel)).toEqual(["src", "新.txt", "旧.txt"]);
      expect(body.files[0]).toMatchObject({ type: "directory", count: 2 });
      expect(body).toMatchObject({ total: 3, fileCount: 2, directoryCount: 1 });
      const child = await get("src");
      expect((await child.json() as typeof body).files.map((item) => item.rel)).toEqual(["src/deep", "src/main.ts"]);
      for (const path of ["..", "src/../src", "/etc", "escape", "missing", "新.txt", "node_modules"]) expect((await get(path)).status, path).toBe(400);
      for (let i = 0; i < 205; i++) writeFileSync(join(work, `extra-${i}`), "x");
      const many = await (await get()).json() as typeof body;
      expect(many.total).toBe(208);
      expect(many.files).toHaveLength(200);
      const custom = join(hob.home, "custom-work");
      mkdirSync(custom);
      writeFileSync(join(custom, "custom.txt"), "x");
      hob.runtime.store.saveJob({ id: "t-custom", assistantId: "hob", title: "自定义目录", instruction: "干活", kind: "local", status: "done", cwd: custom, createdAt: "2026-11-01T01:00:00.000Z", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      const customView = await (await app.request("/api/jobs/t-custom/files", { headers: { cookie } })).json() as typeof body;
      expect(customView.files.map((item) => item.rel)).toEqual(["custom.txt"]);
      // 还没建出工作目录的任务：当作空的，不报错
      hob.runtime.store.saveJob({ id: "t-nowork", assistantId: "hob", title: "排队中", instruction: "干活", kind: "local", status: "queued", createdAt: "2026-11-01T01:00:00.000Z", stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
      const empty = await app.request("/api/jobs/t-nowork/files", { headers: { cookie } });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ files: [], total: 0, fileCount: 0, directoryCount: 0 });
      expect(await (await app.request("/api/jobs/t-nowork/files?path=src", { headers: { cookie } })).json()).toEqual({ error: "这个文件夹已经不在了" });
      expect((await app.request("/api/jobs/t-zzzz/files", { headers: { cookie } })).status).toBe(404);
    } finally {
      hob.close();
    }
  });
});
