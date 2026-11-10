import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  Assistant,
  ImageKeyView,
  ImageSettings,
  ImageSettingsSaved,
  ImageTestResult,
  Item,
  Job,
} from "../../shared/types.ts";
import { isImagePath } from "../../shared/media.ts";
import { createApp } from "../src/http.ts";
import { checkImageSettings, generateImage, IMAGE_KEY_SECRET } from "../src/image.ts";
import { buildWorkerPrompt } from "../src/prompt.ts";
import { writeSecret } from "../src/secrets.ts";
import { registerImageTool } from "../src/worker-tools.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

/** 1×1 的 PNG：测试只看字节有没有原样落盘，不看图。 */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
  "base64",
);

interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

/** 假的 OpenAI 兼容服务器：记录请求，按 handler 回话。 */
function startServer(
  handler: (request: Recorded, response: ServerResponse) => void,
): Promise<{ base: string; requests: Recorded[]; close: () => Promise<void> }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: Recorded = {
        method: req.method ?? "GET",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(recorded);
      handler(recorded, res);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

function saveJob(hob: { runtime: { store: ReturnType<typeof makeHob>["runtime"]["store"] } }, cwd: string): Job {
  const job: Job = {
    id: "t-img1",
    assistantId: "hob",
    title: "画一只猫",
    instruction: "画一只橘猫",
    status: "running",
    createdAt: new Date().toISOString(),
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
    cwd,
  };
  hob.runtime.store.saveJob(job);
  return job;
}

describe("生图配置校验", () => {
  it("只有关闭和 OpenAI 兼容接口，坏地址 / 空模型给出具体原因", () => {
    expect(checkImageSettings({ source: "off" })).toEqual({ source: "off" });
    expect(
      checkImageSettings({ source: "openai", baseUrl: " https://img.test/v1/ ", model: " gpt-image-1 ", size: "1024x1024" }),
    ).toEqual({ source: "openai", baseUrl: "https://img.test/v1", model: "gpt-image-1", size: "1024x1024" });

    expect(() => checkImageSettings({ source: "openai", baseUrl: "", model: "m" })).toThrow("请填写服务地址");
    expect(() => checkImageSettings({ source: "openai", baseUrl: "不是地址", model: "m" })).toThrow("服务地址无效");
    expect(() => checkImageSettings({ source: "openai", baseUrl: "ftp://img.test", model: "m" })).toThrow(
      "仅支持 http:// 或 https://",
    );
    expect(() => checkImageSettings({ source: "openai", baseUrl: "http://img.test", model: "  " })).toThrow(
      "图像模型名称",
    );
    expect(() => checkImageSettings({ source: "pi", ref: "fake/painter" })).toThrow("图片来源无效");
  });

  it("PUT /api/image 存配置：Key 只写不读，别的设置改动不会冲掉生图，revision 不对 409", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const { revision } = hob.runtime.settings.get();
      const put = async (body: unknown) =>
        app.request("/api/image", {
          method: "PUT",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(body),
        });

      const savedResponse = await put({
        revision,
        image: { source: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "fake-image" },
        apiKey: "sk-secret-value",
      });
      expect(savedResponse.status).toBe(200);
      const raw = await savedResponse.text();
      expect(raw).not.toContain("sk-secret-value");
      const saved = JSON.parse(raw) as ImageSettingsSaved;
      expect(saved.keyConfigured).toBe(true);
      expect(saved.settings.settings.image).toEqual({
        source: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "fake-image",
      });
      expect(saved.settings.revision).toBe(revision + 1);

      // Key 落在 secrets.json（0600），接口只报配没配
      const secrets = join(hob.home, "system", "secrets.json");
      expect(readFileSync(secrets, "utf8")).toContain("sk-secret-value");
      expect(statSync(secrets).mode & 0o777).toBe(0o600);
      const view = (await (await app.request("/api/image", { headers: { cookie } })).json()) as ImageKeyView;
      expect(view.keyConfigured).toBe(true);
      expect(JSON.stringify(view)).not.toContain("sk-secret-value");

      // 改工作设置：生图这一节原样保留
      const patch = await app.request("/api/settings", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ revision: saved.settings.revision, patch: { work: { maxJobs: 3 } } }),
      });
      expect(patch.status).toBe(200);
      expect(hob.runtime.settings.settings.image).toEqual({
        source: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "fake-image",
      });

      expect((await put({ revision, image: { source: "off" } })).status).toBe(409);
      const bad = await put({
        revision: hob.runtime.settings.get().revision,
        image: { source: "openai", baseUrl: "nope", model: "" },
      });
      expect(bad.status).toBe(400);
      expect((await bad.json()).error).toContain("服务地址无效");
    } finally {
      hob.close();
    }
  });
});

describe("生成图片", () => {
  it("OpenAI 兼容接口：组装 /images/generations 请求，base64 存成 PNG", async () => {
    const server = await startServer((_request, response) =>
      json(response, { data: [{ b64_json: PNG.toString("base64") }] }),
    );
    const dir = tempDir("hob-img-");
    const home = tempDir("hob-home-");
    try {
      const config: ImageSettings = {
        source: "openai",
        baseUrl: `${server.base}/v1`,
        model: "fake-image",
        size: "1024x1024",
      };
      const path = await generateImage(
        { home, dir, config, apiKey: "sk-test", fetchImpl: fetch },
        { prompt: "一只橘猫" },
      );

      expect(path.startsWith(dir)).toBe(true);
      expect(path.endsWith(".png")).toBe(true);
      expect(readFileSync(path).equals(PNG)).toBe(true);

      const request = server.requests[0];
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/images/generations");
      expect(request.headers.authorization).toBe("Bearer sk-test");
      const body = JSON.parse(request.body.toString("utf8")) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "fake-image", prompt: "一只橘猫", size: "1024x1024" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      await server.close();
    }
  });

  it("有参考图时走 /images/edits 的 multipart，带 model、prompt 和参考图", async () => {
    const server = await startServer((_request, response) =>
      json(response, { data: [{ b64_json: PNG.toString("base64") }] }),
    );
    const dir = tempDir("hob-img-");
    const home = tempDir("hob-home-");
    const ref = join(dir, "ref.png");
    writeFileSync(ref, PNG);
    try {
      const path = await generateImage(
        {
          home,
          dir,
          config: { source: "openai", baseUrl: `${server.base}/v1`, model: "fake-image" },
          apiKey: "sk-test",
          fetchImpl: fetch,
        },
        { prompt: "改成水彩", refs: [ref], size: "512x512" },
      );
      expect(readFileSync(path).equals(PNG)).toBe(true);

      const request = server.requests[0];
      expect(request.url).toBe("/v1/images/edits");
      expect(String(request.headers["content-type"])).toContain("multipart/form-data");
      const body = request.body.toString("utf8");
      expect(body).toContain('name="model"');
      expect(body).toContain("fake-image");
      expect(body).toContain('name="prompt"');
      expect(body).toContain("改成水彩");
      expect(body).toContain('name="size"');
      expect(body).toContain("512x512");
      expect(body).toContain('name="image"');
      expect(body).toContain('filename="ref.png"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      await server.close();
    }
  });

  it("接口返回 URL 时把它取回来存成 PNG", async () => {
    const server = await startServer((request, response) => {
      if (request.url.endsWith("/images/generations")) {
        json(response, { data: [{ url: `${server.base}/files/cat.png` }] });
        return;
      }
      if (request.url === "/files/cat.png") {
        response.writeHead(200, { "content-type": "image/png" });
        response.end(PNG);
        return;
      }
      json(response, { error: { message: "没有这个路由" } }, 404);
    });
    const dir = tempDir("hob-img-");
    const home = tempDir("hob-home-");
    try {
      const path = await generateImage(
        {
          home,
          dir,
          config: { source: "openai", baseUrl: `${server.base}/v1`, model: "fake-image" },
          apiKey: "sk-test",
          fetchImpl: fetch,
        },
        { prompt: "一只橘猫" },
      );
      expect(path.endsWith(".png")).toBe(true);
      expect(readFileSync(path).equals(PNG)).toBe(true);
      expect(server.requests.map((request) => request.url)).toEqual(["/v1/images/generations", "/files/cat.png"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      await server.close();
    }
  });

  it("API Key 被拒、无法连接、未配置：均给出具体原因", async () => {
    const rejected = await startServer((_request, response) =>
      json(response, { error: { message: "invalid api key" } }, 401),
    );
    const dir = tempDir("hob-img-");
    const home = tempDir("hob-home-");
    try {
      const openai = { source: "openai", baseUrl: `${rejected.base}/v1`, model: "fake-image" } as const;
      await expect(
        generateImage({ home, dir, config: openai, apiKey: "sk-bad", fetchImpl: fetch }, {
          prompt: "猫",
        }),
      ).rejects.toThrow("拒绝该 API Key（401）：invalid api key");

      await expect(
        generateImage(
          { home, dir, config: { source: "openai", baseUrl: "http://127.0.0.1:1/v1", model: "m" }, apiKey: "sk", fetchImpl: fetch },
          { prompt: "猫" },
        ),
      ).rejects.toThrow("无法连接 http://127.0.0.1:1/v1");

      await expect(
        generateImage({ home, dir, config: { source: "off" }, fetchImpl: fetch }, { prompt: "猫" }),
      ).rejects.toThrow("尚未配置图像生成");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      await rejected.close();
    }
  });

  it("POST /api/image/test 用当前配置真生成一张小图；没配好就说原因", async () => {
    const server = await startServer((_request, response) =>
      json(response, { data: [{ b64_json: PNG.toString("base64") }] }),
    );
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const test = async (body: unknown) =>
        (await (
          await app.request("/api/image/test", {
            method: "POST",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify(body),
          })
        ).json()) as ImageTestResult;

      expect(await test({})).toEqual({
        ok: false,
        error: "尚未配置图像生成：请在「设置 → 图像生成」中选择 OpenAI 兼容接口。",
      });

      const image: ImageSettings = { source: "openai", baseUrl: `${server.base}/v1`, model: "fake-image" };
      const done = await test({ image, apiKey: "sk-test" });
      expect(done.ok).toBe(true);
      if (done.ok) {
        expect(done.path.startsWith(join(hob.home, "cache", "previews"))).toBe(true);
        expect(readFileSync(done.path).equals(PNG)).toBe(true);
      }
      expect(server.requests[0].url).toBe("/v1/images/generations");

      const failed = await test({ image: { ...image, baseUrl: "http://127.0.0.1:1/v1" }, apiKey: "sk-test" });
      expect(failed.ok).toBe(false);
      if (!failed.ok) expect(failed.error).toContain("无法连接");

      const invalid = await test({ image: { source: "openai", baseUrl: "nope", model: "" } });
      expect(invalid.ok).toBe(false);
    } finally {
      hob.close();
      await server.close();
    }
  });
});

describe("Worker 生图", () => {
  it("generate_image 只在配了生图、且助手开着生图时注册，提示词跟着走", async () => {
    const hob = makeHob();
    const dir = tempDir("hob-img-");
    try {
      const opened: { tools: string[]; prompt: string }[] = [];
      const original = hob.runtime.pi.open.bind(hob.runtime.pi);
      hob.runtime.pi.open = async (options) => {
        const result = await original(options);
        opened.push({ tools: options.tools, prompt: options.systemPrompt() });
        return result;
      };
      /** 每次开任务都会先开 Router（它带 report 以外的另一套工具），这里只挑 Worker。 */
      const workers = () => opened.filter((entry) => entry.tools.includes("report"));
      const scripted = () => {
        hob.faux.setResponses([call("report", { outcome: "done", result: "好了" }), text("好")]);
      };

      // 1. 设置里没配生图：不注册
      scripted();
      await hob.runtime.jobs.start("hob", { title: "没配", instruction: "随便", cwd: dir });
      await hob.runtime.jobs.waitIdle();
      expect(workers()[0].tools).not.toContain("generate_image");
      expect(workers()[0].prompt).toContain("不能做：生图");

      // 2. 配了生图：注册，提示词里写进能做
      const { revision } = hob.runtime.settings.get();
      hob.runtime.settings.setImage(revision, {
        source: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        model: "fake-image",
      });
      scripted();
      await hob.runtime.jobs.start("hob", { title: "配了", instruction: "画一只猫", cwd: dir });
      await hob.runtime.jobs.waitIdle();
      expect(workers()[1].tools).toContain("generate_image");
      expect(workers()[1].prompt).not.toContain("生图（generate_image）");
      expect(workers()[1].prompt).not.toContain("不能做：生图");

      // 3. 助手关掉生图：即使配了也不注册
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({
        ...assistant,
        abilities: { exec: true, write: true, image: false },
      });
      scripted();
      await hob.runtime.jobs.start("hob", { title: "助手关了", instruction: "画画", cwd: dir });
      await hob.runtime.jobs.waitIdle();
      expect(workers()[2].tools).not.toContain("generate_image");
      expect(workers()[2].prompt).toContain("不能做：生图");
    } finally {
      hob.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generate_image 真生成图片，存进任务工作目录并回路径", async () => {
    const server = await startServer((_request, response) =>
      json(response, { data: [{ b64_json: PNG.toString("base64") }] }),
    );
    const hob = makeHob();
    const dir = tempDir("hob-img-");
    try {
      saveJob(hob, dir);
      const { revision } = hob.runtime.settings.get();
      hob.runtime.settings.setImage(revision, {
        source: "openai",
        baseUrl: `${server.base}/v1`,
        model: "fake-image",
      });
      writeSecret(hob.home, IMAGE_KEY_SECRET, "sk-test");

      const tool = registerImageTool(hob.runtime, "t-img1");
      const result = (await tool.execute("c1", { prompt: "一只橘猫" })) as {
        content: { type: string; text?: string }[];
        isError?: boolean;
      };
      expect(result.isError).toBeFalsy();
      const line = result.content[0].text ?? "";
      const path = line.replace("图片已生成：", "").trim();
      expect(path.startsWith(dir)).toBe(true);
      expect(readFileSync(path).equals(PNG)).toBe(true);
      expect(server.requests[0].headers.authorization).toBe("Bearer sk-test");

      // 工作目录是任务自己的目录时不往 HOB_HOME 外写
      const job = hob.runtime.store.job("t-img1")!;
      hob.runtime.store.saveJob({ ...job, cwd: undefined });
      const inWork = (await registerImageTool(hob.runtime, "t-img1").execute("c2", { prompt: "再来一张" })) as {
        content: { text?: string }[];
      };
      const workPath = (inWork.content[0].text ?? "").replace("图片已生成：", "").trim();
      expect(workPath.startsWith(hob.runtime.store.workDir("t-img1"))).toBe(true);
    } finally {
      hob.close();
      rmSync(dir, { recursive: true, force: true });
      await server.close();
    }
  });
});

describe("图片进对话", () => {
  it("isImagePath 按扩展名认图片", () => {
    expect(isImagePath("/tmp/a/cat.png")).toBe(true);
    expect(isImagePath("/tmp/a/cat.JPG")).toBe(true);
    expect(isImagePath("/tmp/a/cat.jpeg")).toBe(true);
    expect(isImagePath("/tmp/a/cat.webp")).toBe(true);
    expect(isImagePath("/tmp/a/cat.gif")).toBe(true);
    expect(isImagePath("/tmp/a/cat.md")).toBe(false);
    expect(isImagePath("/tmp/a/cat")).toBe(false);
    expect(isImagePath("/tmp/a/cat.png.bak")).toBe(false);
    // 历史条目里路径可能没存下来：不能因为判空再抛一次
    expect(isImagePath(undefined)).toBe(false);
    expect(isImagePath(null)).toBe(false);
    expect(isImagePath("")).toBe(false);
  });

  it("任务文件只交给助手，不直接发到对话", async () => {
    const hob = makeHob();
    const dir = tempDir("hob-img-");
    const image = join(dir, "cat.png");
    const doc = join(dir, "notes.md");
    writeFileSync(image, PNG);
    writeFileSync(doc, "# 笔记\n");
    try {
      hob.faux.setResponses([
        call("report", { outcome: "done", result: "画好了", files: [image, doc] }),
        text("好"),
      ]);
      await hob.runtime.jobs.start("hob", { title: "画猫", instruction: "画一只橘猫", cwd: dir });
      await hob.runtime.jobs.waitIdle();

      const files = () =>
        hob.runtime.router
          .items("hob", { limit: 50 })
          .items.filter((item): item is Extract<Item, { kind: "file" }> => item.kind === "file");
      expect(files()).toHaveLength(0);
      const routerLog = () => readFileSync(hob.runtime.store.routerFile("hob"), "utf8");
      await waitFor(() => routerLog().includes(`任务交来的文件：${image}、${doc}。`));
    } finally {
      hob.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("Worker 提示词：能做/不能做里写着生图", () => {
    const hob = makeHob();
    try {
      const assistant: Assistant = hob.runtime.store.assistant("hob")!;
      const job: Job = {
        id: "t-p1",
        assistantId: assistant.id,
        title: "画图",
        instruction: "画一只猫",
        status: "queued",
        createdAt: new Date().toISOString(),
        stats: { reads: 0, commands: 0, edits: 0 },
        activity: [],
      };
      hob.runtime.store.saveJob(job);
      const base = {
        timezone: "Asia/Shanghai",
        aboutYou: { name: "", language: "", notes: "" },
        memory: "off" as const,
      };
      expect(
        buildWorkerPrompt(hob.runtime.store, job.id, { ...base, abilities: { exec: true, write: true, image: true } }),
      ).not.toContain("生图（generate_image）");
      expect(
        buildWorkerPrompt(hob.runtime.store, job.id, { ...base, abilities: { exec: true, write: true, image: false } }),
      ).toContain("不能做：生图");
    } finally {
      hob.close();
    }
  });
});
