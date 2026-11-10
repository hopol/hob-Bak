import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";
import { checkEmbeddingSettings, embed } from "../src/embedding.ts";

describe("向量接口", () => {
  it("校验设置，分批请求并按返回序号排序", async () => {
    const config = checkEmbeddingSettings({ source: "openai", baseUrl: "http://localhost/v1/", model: " test " });
    const batches: number[] = [];
    const fake: typeof fetch = async (_url, init) => {
      const { input } = JSON.parse(String(init?.body)) as { input: string[] };
      batches.push(input.length);
      return Response.json({ data: input.map((_, index) => ({ index, embedding: [index + 1, 2] })).reverse() });
    };
    const vectors = await embed(config, "key", Array(33).fill("文字"), fake);
    expect(batches).toEqual([32, 1]);
    expect(vectors[0]).toEqual([1, 2]);
    expect(vectors).toHaveLength(33);
    expect(() => checkEmbeddingSettings({ source: "openai", baseUrl: "file:///tmp", model: "x" })).toThrow();
  });
  it("设置与测试接口不回显密钥", async () => {
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (part: Buffer) => { data += part; });
      req.on("end", () => {
        const body = JSON.parse(data) as { input: string[] };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: body.input.map((_, index) => ({ index, embedding: [1, 2, 3] })) }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const json = (method: string, body: unknown) => ({ method, headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      const embedding = { source: "openai", baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, model: "fake" };
      const revision = hob.runtime.settings.get().revision;
      const saved = await app.request("/api/knowledge/embedding", json("PUT", { revision, embedding, apiKey: "secret-value" }));
      const body = await saved.text();
      expect(saved.status).toBe(200); expect(body).not.toContain("secret-value");
      expect(await (await app.request("/api/knowledge/embedding", { headers: { cookie } })).json()).toEqual({ keyConfigured: true });
      expect(await (await app.request("/api/knowledge/embedding/test", json("POST", {}))).json()).toEqual({ ok: true, dims: 3 });
      expect((await app.request("/api/knowledge/embedding", json("PUT", { revision, embedding }))).status).toBe(409);
      expect(await (await app.request("/api/knowledge/embedding/test", json("POST", { embedding: { source: "off" } }))).json()).toMatchObject({ ok: false });
    } finally { await hob.runtime.knowledge.whenIndexed(); hob.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
  it("服务商失败时保留原因", async () => {
    const fake: typeof fetch = async () => new Response("模型不可用", { status: 503 });
    await expect(embed({ source: "openai", baseUrl: "http://localhost", model: "x" }, "key", ["a"], fake)).rejects.toThrow("模型不可用");
  });
});
