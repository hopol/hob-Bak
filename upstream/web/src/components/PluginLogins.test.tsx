import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
vi.mock("../store.ts", () => ({ deletePluginLogin: vi.fn(), loadPluginLoginSecret: vi.fn(), savePluginLogin: vi.fn() }));
import { PluginLogins, parseLoginCsv } from "./PluginLogins.tsx";

describe("password vault CSV import", () => {
  it("renders the enabled status, gray folder text, and import action", () => {
    const html = renderToStaticMarkup(<PluginLogins id="vault" data={{ service: "vault", folders: ["工作"], logins: [{ id: "one", name: "Example", username: "user", uris: ["https://example.test"], folder: "工作", hasPassword: true, hasTotp: false }] }} canSave canDelete browse reload={async () => undefined} />);
    expect(html).toContain("已开启");
    expect(html).toContain("1 个登录");
    expect(html).toContain("plugin-login-import");
    expect(html).toContain("plugin-login-folder");
    expect(html).not.toContain("name=\"folder\"");
  });

  it("lists Hob's own logins 20 at a time and shows an external manager's logins only when searched", () => {
    const logins = Array.from({ length: 45 }, (_, i) => ({ id: `l${i}`, name: `站点${i}`, username: `user${i}`, uris: [`https://s${i}.example.test`], hasPassword: true, hasTotp: false }));
    const own = renderToStaticMarkup(<PluginLogins id="vault" data={{ service: "vault", folders: [], logins }} canSave canDelete browse reload={async () => undefined} />);
    expect(own.match(/plugin-login-row/g)).toHaveLength(20);
    expect(own).toContain("再显示 20 个");
    const external = renderToStaticMarkup(<PluginLogins id="bitwarden" data={{ service: "bitwarden", folders: [], logins }} canSave canDelete browse={false} reload={async () => undefined} />);
    expect(external).not.toContain("plugin-login-row");
    expect(external).toContain("45 个登录");
  });

  it("recognizes Bitwarden, Chrome, and 1Password headers in memory", () => {
    expect(parseLoginCsv("name,login_uri,login_username,login_password,folder\n论坛,https://forum.example,lin@example.com,secret,工作")).toEqual([{ name: "论坛", uri: "https://forum.example", username: "lin@example.com", password: "secret", folder: "工作" }]);
    expect(parseLoginCsv("\ufeffname,url,username,password\n商城,https://shop.example,buyer@example.com,shop-secret")).toEqual([{ name: "商城", uri: "https://shop.example", username: "buyer@example.com", password: "shop-secret" }]);
    expect(parseLoginCsv("Title,Url,Username,Password\n文档,https://docs.example,writer@example.com,doc-secret")).toEqual([{ name: "文档", uri: "https://docs.example", username: "writer@example.com", password: "doc-secret" }]);
  });

  it("handles quoted commas and skips rows without a password", () => {
    expect(parseLoginCsv("name,url,username,password\n\"带,逗号\",https://example.test,user,secret\n空密码,https://empty.test,user,")).toEqual([{ name: "带,逗号", uri: "https://example.test", username: "user", password: "secret" }]);
  });
});
