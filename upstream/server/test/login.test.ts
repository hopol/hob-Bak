import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRouterTools } from "../src/router-tools.ts";
import { credentialCandidates, hostsMatch } from "../src/login.ts";
import { readLoginAuto, saveLoginAuto } from "../src/login-auto.ts";
import { makeHob } from "./helpers.ts";

describe("login safety boundaries", () => {
  it("only accepts the saved host or one of its subdomains", () => {
    expect(hostsMatch("login.example.net", "example.net")).toBe(true);
    expect(hostsMatch("example.net", "login.example.net")).toBe(false);
    expect(hostsMatch("forum-example.net.verify-login.io", "forum.example.net")).toBe(false);
    expect(hostsMatch("example.net.", "example.net")).toBe(true);
  });

  it("persists only the auto-fill identity and never a password", () => {
    const hob = makeHob();
    const password = "unique-password-that-must-not-be-written";
    try {
      saveLoginAuto(hob.home, { provider: "bitwarden", itemId: "item-1", host: "forum.example.net", username: "user@example.net" });
      assert.deepEqual(readLoginAuto(hob.home), [{ provider: "bitwarden", itemId: "item-1", host: "forum.example.net", username: "user@example.net", at: readLoginAuto(hob.home)[0]!.at }]);
      expect(readFileSync(join(hob.home, "system", "login-auto.json"), "utf8")).not.toContain(password);
    } finally { hob.close(); }
  });

  it("login 没有凭据提供者时只请用户自己登录：没有 account 参数，说明是那一段短话", () => {
    const hob = makeHob();
    try {
      const tool = buildRouterTools(hob.runtime, "hob").find((tool) => tool.name === "login")!;
      expect(tool).toBeDefined();
      expect(tool.parameters.properties).toEqual({ site: expect.anything(), reason: expect.anything() });
      expect(tool.description).toBe("请用户在云桌面里登录一个网站：会出一张卡，用户登录完会告诉你；登录信息所有助手共用，登一次就行。site 写哪个网站，reason 一句话写为什么要登录。");
      expect(buildRouterTools(hob.runtime, "hob").some((tool) => tool.name === "login")).toBe(true);
    } finally { hob.close(); }
  });

  it("finds candidates by name and by host, including a saved parent or child domain, exact host first", async () => {
    const logins = [
      { id: "community", name: "Example 社区", username: "reader@example.net", uris: ["https://example.net/"], folder: "论坛账号" },
      { id: "forum-alt", name: "Example 论坛（小号）", username: "lin.alt@example.com", uris: ["https://forum.example.net/"] },
      { id: "photo", name: "摄影社区", username: "linphoto", uris: ["https://photo.example.org/"] },
    ];
    const runtime = { plugins: { credentialProviders: () => [{ pluginId: "vault", providerName: "测试密码库" }], callCredential: async () => ({ logins }) } } as any;
    const ids = async (site: string, account?: string) => (await credentialCandidates(runtime, "hob", site, account)).map((candidate) => candidate.id);
    // 页面 login.example.net、保存 example.net：按页面网址找也找得到
    expect(await ids("login.example.net")).toEqual(["community"]);
    // 完全一样的排前面，父域名的跟在后面；别的站点不进来
    expect(await ids("forum.example.net")).toEqual(["forum-alt", "community"]);
    expect(await ids("Example 论坛")).toEqual(["forum-alt"]);
    expect(await ids("example.net", "lin.alt")).toEqual(["forum-alt"]);
    expect(await ids("photo.example.org")).toEqual(["photo"]);
    expect(await ids("wiki.example.org")).toEqual([]);
  });
});
