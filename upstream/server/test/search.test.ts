import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WebSearch, searchTools, type SearchClient } from "../src/search.ts";
import { writeSecret } from "../src/secrets.ts";
import { createApp } from "../src/http.ts";
import { makeHob } from "./helpers.ts";
import type { SearchSettings } from "../../shared/search.ts";

const providers: SearchSettings = [{ name: "exa", enabled: true }, { name: "tavily", enabled: true }];

describe("联网搜索", () => {
  it("fast 失败切换；deep 去重并保留来源和最长摘要；隐藏密钥", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-search-"));
    try {
      writeSecret(home, "search:exa", "secret-key");
      const factory = (name: string, credentials: { apiKey?: string }) => ({ name, label: name, envVar: "", search: async () => {
        if (name === "exa") { expect(credentials.apiKey).toBe("secret-key"); throw new Error("bad secret-key"); }
        return { query: "q", results: [{ title: "one", url: "https://x", snippet: "short" }] };
      } }) as SearchClient;
      const service = new WebSearch(home, () => providers, factory);
      const fast = await service.search("q");
      expect(fast.providers).toEqual(["tavily"]);
      expect(fast.errors[0].error).toBe("bad [已隐藏]");
      const deep = await service.search("q", "deep");
      expect(deep.results).toHaveLength(1);
      expect(deep.errors).toHaveLength(1);
      const merge = new WebSearch(home, () => providers, (name) => ({ name, label: name, envVar: "", search: async () => ({ query: "q", results: [{ title: name, url: "https://x", snippet: name === "exa" ? "a" : "longer" }] }) }) as SearchClient);
      expect((await merge.search("q", "deep")).results[0]).toMatchObject({ snippet: "longer", sources: ["exa", "tavily"] });
      expect(process.env.EXA_API_KEY).not.toBe("secret-key");
      const broken = new WebSearch(home, () => providers, () => ({ name: "bad", label: "bad", envVar: "", search: async () => { throw new Error("secret-key rejected"); } }) as SearchClient);
      await expect(broken.search("q")).rejects.toThrow("[已隐藏]");
      expect(searchTools(home, () => [])).toEqual([]);
      expect(searchTools(home, () => providers).map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
  it("抓取只允许 HTTP 并截断长内容", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-search-"));
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("x".repeat(40001), { headers: { "content-type": "text/plain" } }));
    try {
      const service = new WebSearch(home, () => []);
      await expect(service.fetch("file:///etc/passwd")).rejects.toThrow("仅支持");
      const result = await service.fetch("https://example.test");
      expect(result.text).toHaveLength(40000);
      expect(result.truncated).toBe(true);
    } finally { fetch.mockRestore(); rmSync(home, { recursive: true, force: true }); }
  });
  it("设置保存、顺序、删除密钥和 revision", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const put = (body: unknown) => app.request("/api/search", { method: "PUT", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
      let revision = hob.runtime.settings.get().revision;
      const saved = await put({ revision, providers: [...providers].reverse(), keys: { exa: "secret-key" } });
      expect(saved.status).toBe(200);
      expect(await saved.text()).not.toContain("secret-key");
      expect(hob.runtime.settings.settings.search[0].name).toBe("tavily");
      expect((await put({ revision, providers })).status).toBe(409);
      revision = hob.runtime.settings.get().revision;
      await put({ revision, providers, keys: { exa: "" } });
      const view = await (await app.request("/api/search", { headers: { cookie } })).json();
      expect(view.providers.find((p: { name: string }) => p.name === "exa").keyConfigured).toBe(false);
    } finally { hob.close(); }
  });
});
