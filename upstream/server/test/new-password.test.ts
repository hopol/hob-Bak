import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  candidates: vi.fn(),
  pageInfo: vi.fn(),
  fills: [] as { index: number; value: string }[],
}));

vi.mock("../src/login.ts", () => ({
  credentialCandidates: mocks.candidates,
  hostsMatch: (page: string, saved: string) => page === saved || page.endsWith(`.${saved}`),
  inspectCurrentPage: mocks.inspect,
  pageInfo: mocks.pageInfo,
}));

vi.mock("../src/desktop-tools.ts", () => ({
  rememberFilledSecret: () => {},
  DesktopToolSession: class {
    constructor(..._args: unknown[]) {}
    async withCurrentPage(run: (page: unknown) => Promise<unknown>) {
      const page = { locator: () => ({ nth: (index: number) => ({ fill: async (value: string) => mocks.fills.push({ index, value }) }) }) };
      return run(page);
    }
    async dispose() {}
  },
}));

import type { FillNewPasswordApproval } from "../../shared/types.ts";
import { generateSaveAndFill, NewPasswordError, passwordCharactersText, passwordTargets, prepareFillNewPassword } from "../src/new-password.ts";

describe("fill_new_password", () => {
  it("describes the default and constrained character sets", () => {
    expect(passwordCharactersText(["lowercase", "uppercase", "numbers", "symbols"])).toBe("含符号");
    expect(passwordCharactersText(["lowercase", "uppercase", "numbers"])).toBe("字母和数字");
    expect(passwordCharactersText(["lowercase", "symbols"])).toBe("小写字母、符号");
  });

  it("fills new-password inputs first and leaves the old password field for a change form", () => {
    const info = {
      url: "https://example.test/account/password",
      host: "example.test",
      inputs: [
        { index: 0, type: "password", autocomplete: "current-password", name: "old", value: "", beforePassword: true },
        { index: 1, type: "password", autocomplete: "new-password", name: "new", value: "", beforePassword: false },
        { index: 2, type: "password", autocomplete: "new-password", name: "confirm", value: "", beforePassword: false },
      ],
    };
    expect(passwordTargets(info, "change")).toEqual([1, 2]);
    expect(passwordTargets({ ...info, inputs: info.inputs.map((input) => ({ ...input, autocomplete: "" })) }, "change")).toEqual([1, 2]);
    // 改密码页只有新密码和确认两个框（没有旧密码框）：两个都填新密码
    expect(passwordTargets({ ...info, inputs: info.inputs.slice(1).map((input, index) => ({ ...input, index })) }, "change")).toEqual([0, 1]);
  });

  it("a retry after the site rejected the password stays a registration and updates the item saved minutes ago", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-new-password-"));
    try {
      const saved = { id: "login-new", name: "shop.example.com", username: "lin@example.com", uris: ["http://shop.example.com"] };
      mkdirSync(join(home, "system"), { recursive: true });
      writeFileSync(join(home, "system", "new-password.json"), JSON.stringify([{ provider: "bitwarden", itemId: saved.id, host: "shop.example.com", username: "lin@example.com", name: saved.name, at: new Date().toISOString() }]));
      mocks.inspect.mockResolvedValue({ url: "http://shop.example.com/register", host: "shop.example.com", inputs: [{ index: 0, type: "password", autocomplete: "new-password", name: "password", value: "", beforePassword: true }] });
      // list 里现在有刚存的那一条
      mocks.candidates.mockResolvedValue([{ provider: "bitwarden", providerName: "Bitwarden", ...saved }]);
      const runtime = { home, plugins: { hasPasswordGenerator: () => true, displayName: () => "Bitwarden", credentialProviders: (_assistant: string, role: string) => [{ pluginId: "bitwarden", providerName: "Bitwarden", service: "bw", tool: role, role }] } } as any;
      const result = await prepareFillNewPassword(runtime, "hob", "lin@example.com", 12, ["lowercase", "numbers"]);
      assert.equal(result.kind, "approval");
      if (result.kind !== "approval") return;
      expect(result.title).toBe("在 shop.example.com 注册");
      expect(result.approval.mode).toBe("register");
      expect(result.approval.candidate?.id).toBe(saved.id);

      // 不是这次流程存的（30 分钟以前）：是改密码
      writeFileSync(join(home, "system", "new-password.json"), JSON.stringify([{ provider: "bitwarden", itemId: saved.id, host: "shop.example.com", username: "lin@example.com", name: saved.name, at: new Date(Date.now() - 31 * 60 * 1000).toISOString() }]));
      const change = await prepareFillNewPassword(runtime, "hob", "lin@example.com", 12);
      assert.equal(change.kind, "approval");
      if (change.kind !== "approval") return;
      expect(change.approval.mode).toBe("change");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("NewPasswordError carries the item name separately from the error class name", () => {
    const error = new NewPasswordError("页面跳走了", true, "Bitwarden", "Example 商城");
    expect(error.name).toBe("NewPasswordError");
    expect(error.itemName).toBe("Example 商城");
    expect(error.saved).toBe(true);
  });

  it("classifies an existing same-user item as a change and carries only metadata in the approval", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-new-password-"));
    try {
      mocks.inspect.mockResolvedValue({ url: "https://shop.example.test/register", host: "shop.example.test", inputs: [{ index: 1, type: "password", autocomplete: "new-password", name: "password", value: "", beforePassword: true }] });
      mocks.candidates.mockResolvedValue([{ provider: "bitwarden", providerName: "Bitwarden", id: "item-1", name: "Example 商城", username: "lin@example.com", folder: "购物", uris: ["https://shop.example.test"] }]);
      const runtime = { home, plugins: { hasPasswordGenerator: () => true, credentialProviders: () => [{ pluginId: "bitwarden", providerName: "Bitwarden", service: "bw", tool: "tool", role: "generate" }] } } as any;
      const result = await prepareFillNewPassword(runtime, "hob", "lin@example.com", 16, ["lowercase", "uppercase", "numbers"]);
      assert.equal(result.kind, "approval");
      if (result.kind !== "approval") return;
      expect(result.approval.mode).toBe("change");
      expect(result.approval.candidate?.id).toBe("item-1");
      expect(JSON.stringify(result.approval)).not.toContain("password");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("saves the generated password without writing it into HOB_HOME", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-new-password-"));
    const generated = "generated-secret-never-persisted";
    try {
      mocks.fills.length = 0;
      mocks.pageInfo.mockResolvedValue({ url: "https://shop.example.test/register", host: "shop.example.test", inputs: [
        { index: 0, type: "email", autocomplete: "username", name: "email", value: "", beforePassword: true },
        { index: 1, type: "password", autocomplete: "new-password", name: "password", value: "", beforePassword: false },
        { index: 2, type: "password", autocomplete: "new-password", name: "confirm", value: "", beforePassword: false },
      ], usernameIndex: 0, passwordIndex: 1 });
      const calls: { role: string; args: Record<string, unknown> }[] = [];
      const provider = (role: string) => ({ pluginId: "bitwarden", providerName: "Bitwarden", service: "bw", tool: role, role });
      const runtime = {
        home,
        plugins: {
          credentialProviders: (_assistant: string, role: string) => [provider(role)],
          callCredential: async (selected: { role: string }, args: Record<string, unknown>) => {
            calls.push({ role: selected.role, args });
            return selected.role === "generate" ? { password: generated } : { id: "new-item", folder: "购物" };
          },
        },
      } as any;
      const approval: FillNewPasswordApproval = { host: "shop.example.test", pageUrl: "https://shop.example.test/register", username: "lin@example.com", mode: "register", provider: "bitwarden", providerName: "Bitwarden", length: 16, characters: ["lowercase", "uppercase", "numbers"], name: "Example 商城", origin: "https://shop.example.test", folders: ["购物"], state: "pending" };
      await generateSaveAndFill(runtime, "hob", approval, "购物");
      expect(calls.map((call) => call.role)).toEqual(["generate", "save"]);
      expect(calls[1]!.args.password).toBe(generated);
      expect(mocks.fills).toEqual([{ index: 0, value: "lin@example.com" }, { index: 1, value: generated }, { index: 2, value: generated }]);
      expect(readFileSync(join(home, "system", "new-password.json"), "utf8")).not.toContain(generated);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
