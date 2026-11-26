import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PluginCatalogView, PluginProviderView, PluginSignInSessionView, PluginView } from "../../../shared/types.ts";

vi.mock("../store.ts", () => ({
  MOCK: false,
  useApp: () => ({ assistants: [], pluginSignIn: {}, pluginProviderTick: 0 }),
  approvePlugin: vi.fn(),
  cancelPluginSignIn: vi.fn(),
  checkPluginProviderCli: vi.fn(),
  deletePluginAccount: vi.fn(),
  installPluginProviderCli: vi.fn(),
  loadPluginProviders: vi.fn(),
  loadPluginProviderUsage: vi.fn(),
  pastePluginSignIn: vi.fn(),
  pollPluginSignIn: vi.fn(),
  promptPluginAuth: vi.fn(),
  refreshPluginModels: vi.fn(),
  setPluginActiveAccount: vi.fn(),
  signInPluginApiKey: vi.fn(),
  startPluginSignIn: vi.fn(),
  submitPluginSignInCode: vi.fn(),
}));
vi.mock("./Plugins.tsx", () => ({
  PluginIcon: () => <div className="plugin-icon" />,
  pluginName: (m: Record<string, unknown>, id: string) => String(m.displayName ?? m.name ?? id),
  pluginDescription: (m: Record<string, unknown>) => String(m.description ?? ""),
}));

import {
  PluginUpdateApprovalBanner,
  ProviderModelsSection,
  ProviderQuotaSection,
  ProviderSignInCard,
  ProviderStatusStrip,
} from "./PluginProviders.tsx";
import { PluginInstallView, PluginPreInstallDetail } from "./PluginMarketViews.tsx";

const nowIso = "2026-11-24T06:00:00.000Z";
const futureIso = new Date(Date.now() + 10 * 60_000).toISOString();

function baseProvider(overrides: Partial<PluginProviderView> = {}): PluginProviderView {
  return {
    hobProviderId: "plugin-demo",
    providerId: "demo",
    name: "DemoProvider",
    single: false,
    methods: [{ index: 0, type: "oauth", label: "网页登录" }],
    accounts: [],
    models: [],
    usageSupported: false,
    ...overrides,
  };
}

describe("供应商插件五种登录界面", () => {
  const noop = () => {};

  it("1. 设备码登录：显示设备码、验证网址、统一的图标复制按钮、打开网页与取消", () => {
    const session: PluginSignInSessionView = {
      sessionId: "s-dev",
      pluginId: "copilot",
      providerId: "github-copilot",
      methodIndex: 0,
      kind: "device_code",
      status: "waiting",
      userCode: "ABCD-1234",
      url: "https://github.com/login/device",
      createdAt: nowIso,
      expiresAt: futureIso,
    };
    const html = renderToStaticMarkup(
      <ProviderSignInCard
        pluginId="copilot"
        provider={baseProvider({ name: "Copilot", providerId: "github-copilot" })}
        session={session}
        onSessionChange={noop}
        onCliChange={noop}
        onDone={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("ABCD-1234");
    expect(html).toContain("https://github.com/login/device");
    expect(html).toContain("打开网页");
    expect(html).toContain("取消");
    expect(html).toContain("等你在网页上确认");
    // 两个复制按钮均统一为图标按钮（hob-icon-btn），不含带字复制按钮
    expect(html.match(/class="hob-icon-btn"/g)?.length).toBe(2);
    expect(html).not.toContain(">复制<");
  });

  it("2. 网页登录服务端轮询：显示打开网页登录、等待自动完成、过期和失败原因", () => {
    const waiting: PluginSignInSessionView = {
      sessionId: "s-poll",
      pluginId: "zcode",
      providerId: "zcode",
      methodIndex: 0,
      kind: "server_poll",
      status: "waiting",
      url: "https://zcode.example.com/oauth",
      createdAt: nowIso,
      expiresAt: futureIso,
    };
    const html = renderToStaticMarkup(
      <ProviderSignInCard
        pluginId="zcode"
        provider={baseProvider({
          name: "ZCode",
          methods: [
            { index: 0, type: "oauth", label: "网页登录" },
            { index: 1, type: "api", label: "API 密钥" },
          ],
        })}
        session={waiting}
        onSessionChange={noop}
        onCliChange={noop}
        onDone={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("打开网页登录");
    expect(html).toContain("自动完成登录");
    expect(html).toContain("取消");

    const expiredHtml = renderToStaticMarkup(
      <ProviderSignInCard
        pluginId="zcode"
        provider={baseProvider({ name: "ZCode" })}
        session={{ ...waiting, status: "expired" }}
        onSessionChange={noop}
        onCliChange={noop}
        onDone={noop}
        onCancel={noop}
      />,
    );
    expect(expiredHtml).toContain("登录已过期");
    expect(expiredHtml).toContain("重新发起");

    const failedHtml = renderToStaticMarkup(
      <ProviderSignInCard
        pluginId="zcode"
        provider={baseProvider({ name: "ZCode" })}
        session={{ ...waiting, status: "failed", error: "上游拒绝了授权请求" }}
        onSessionChange={noop}
        onCliChange={noop}
        onDone={noop}
        onCancel={noop}
      />,
    );
    expect(failedHtml).toContain("登录失败：上游拒绝了授权请求");
  });

  it("3. loopback 回调粘贴：写清为什么粘贴、只接受本次本机地址、完成登录与取消", () => {
    const session: PluginSignInSessionView = {
      sessionId: "s-paste",
      pluginId: "chatgpt",
      providerId: "openai-codex",
      methodIndex: 0,
      kind: "loopback_paste",
      status: "waiting",
      url: "https://auth.example.com/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback",
      loopbackPasteAllowed: true,
      createdAt: nowIso,
      expiresAt: futureIso,
    };
    const html = renderToStaticMarkup(
      <ProviderSignInCard
        pluginId="chatgpt"
        provider={baseProvider({ name: "ChatGPT 订阅" })}
        session={session}
        onSessionChange={noop}
        onCliChange={noop}
        onDone={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("如果 Hob 运行在另一台机器上");
    expect(html).toContain("把浏览器最后停住的地址粘贴到这里");
    expect(html).toContain("127.0.0.1:1455");
    expect(html).toContain("完成登录");
    expect(html).toContain("取消");
  });

  it("4. API 密钥登录：显示密钥输入、账号名称选填、保存并登录与取消", () => {
    const html = renderToStaticMarkup(
      <ProviderSignInCard
        pluginId="zcode"
        provider={baseProvider({
          name: "ZCode",
          methods: [{ index: 0, type: "api", label: "API 密钥", placeholder: "sk-..." }],
        })}
        onSessionChange={noop}
        onCliChange={noop}
        onDone={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("使用 API 密钥登录");
    expect(html).toContain("API 密钥 *");
    expect(html).toContain("账号名称（选填）");
    expect(html).toContain("保存并登录");
    expect(html).toContain("取消");
  });

  it("5. 本机客户端检测：写明这是运行 Hob 机器上的登录、安装/重新检测/取消按钮", () => {
    const html = renderToStaticMarkup(
      <ProviderSignInCard
        pluginId="agy-cli"
        provider={baseProvider({
          name: "Antigravity",
          methods: [],
          cli: { declared: true, name: "agy CLI", installed: false, installing: false },
        })}
        onSessionChange={noop}
        onCliChange={noop}
        onDone={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain("这是运行 Hob 的那台机器上的登录，不是你当前使用的设备。");
    expect(html).toContain("未找到");
    expect(html).toContain("安装 agy CLI");
    expect(html).toContain("重新检测");
    expect(html).toContain("取消");
  });
  it("声明了登录方式又靠本机命令行的插件：照常显示登录方式，提示第一次会先装好命令行，不出检测卡", () => {
    const html = renderToStaticMarkup(
      <ProviderSignInCard
        pluginId="agy-cli"
        provider={baseProvider({
          name: "Antigravity",
          methods: [{ index: 0, type: "oauth", label: "Sign in with Google", labels: { zh: "使用 Google 登录" } }],
          cli: { declared: true, name: "Antigravity CLI", installed: false, installing: false },
        })}
        onSessionChange={() => {}}
        onCliChange={() => {}}
        onDone={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("开始登录");
    expect(html).toContain("第一次登录会先在运行 Hob 的机器上装好 Antigravity CLI");
    expect(html).not.toContain("重新检测");
  });
});

describe("额度异常、模型缓存回退、更新权限确认与安装视图", () => {
  it("拿不到额度时照实显示原因，不画成 0% 进度条", () => {
    const provider = baseProvider({
      usageSupported: true,
      accounts: [{ id: "a1", providerId: "demo", displayName: "lin@example.com", authType: "oauth", active: true, status: "logged_in", createdAt: nowIso, updatedAt: nowIso }],
      usage: { windows: [], error: "服务端返回 429，请求过于频繁。", fetchedAt: nowIso },
    });
    const html = renderToStaticMarkup(<ProviderQuotaSection provider={provider} onRefresh={() => {}} />);
    expect(html).toContain("拿不到额度");
    expect(html).toContain("服务端返回 429");
    expect(html).toContain("重试");
    expect(html).not.toContain("plugin-bar");
  });

  it("额度插件给不出（还没取到或取到是空的）时整组不显示；宿主起没起不显示", () => {
    const account = { id: "a1", providerId: "demo", authType: "oauth" as const, displayName: "lin@example.com", status: "logged_in" as const, active: true, createdAt: nowIso, updatedAt: nowIso };
    const empty = renderToStaticMarkup(<ProviderQuotaSection provider={baseProvider({ usageSupported: true, accounts: [account] })} onRefresh={() => {}} />);
    expect(empty).toBe("");
    const blank = renderToStaticMarkup(<ProviderQuotaSection provider={baseProvider({ usageSupported: true, accounts: [account], usage: { windows: [], fetchedAt: nowIso } })} onRefresh={() => {}} />);
    expect(blank).toBe("");
    const strip = renderToStaticMarkup(<ProviderStatusStrip providers={[baseProvider({ accounts: [account] })]} host={{ status: "stopped" } as never} toolCount={0} />);
    expect(strip).toContain("已登录");
    expect(strip).not.toMatch(/未启动|运行中/);
  });

  it("只能免登录启用的供应商：状态写「已启用」，不说已登录", () => {
    const keyless = baseProvider({ methods: [{ index: 0, type: "api", label: "免费使用", keyless: true }], accounts: [{ id: "public", providerId: "demo", authType: "api", displayName: "Public", status: "logged_in", active: true, createdAt: nowIso, updatedAt: nowIso }] });
    const strip = renderToStaticMarkup(<ProviderStatusStrip providers={[keyless]} toolCount={0} />);
    expect(strip).toContain("已启用");
    expect(strip).not.toContain("已登录");
  });

  it("模型拉取失败时保留上次缓存模型并显示失败原因", () => {
    const provider = baseProvider({
      modelsError: "连接 api.example.com 超时（10 秒）。",
      modelsCachedAt: nowIso,
      modelsFellBack: true,
      models: [
        { id: "claude-sonnet-4.5", apiId: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", api: "anthropic-messages", reasoning: true, variants: ["low", "high"], thinkingLevels: ["off", "low", "high"], input: ["text", "image"], contextWindow: 200_000, maxTokens: 16_384 },
      ],
    });
    const html = renderToStaticMarkup(<ProviderModelsSection pluginId="p" provider={provider} onRefresh={() => {}} onProviders={() => {}} onChanged={() => {}} />);
    expect(html).toContain("拉取模型列表失败");
    expect(html).toContain("连接 api.example.com 超时");
    expect(html).toContain("已保留上次成功获取的模型列表");
    expect(html).toContain("Claude Sonnet 4.5");
    expect(html).toContain("200K");
    expect(html).toContain("重新拉取");
  });

  it("更新后权限变化横幅显示新增/已有权限及确认并启用、保持停用按钮", () => {
    const item: PluginView = {
      plugin: {
        id: "copilot",
        version: "0.5.0",
        source: "official",
        enabled: false,
        tools: {},
        config: {},
        needsApproval: true,
        capabilityChanges: ["新增权限：subprocess", "新增权限：local_credentials"],
      },
      manifest: {
        displayName: "Copilot",
        extensions: {
          "com.hob.plugins": {
            reviewedVersion: "0.5.0",
            permissions: ["network", "subprocess", "local_credentials"],
            providers: [{ package: "@magpie-community/opencode-copilot-auth", version: "0.5.0", integrity: "sha512-x" }],
          },
        },
      },
      config: {},
      missing: [],
      services: [],
    };
    const html = renderToStaticMarkup(
      <PluginUpdateApprovalBanner item={item} onApprove={() => {}} onKeepDisabled={() => {}} />,
    );
    expect(html).toContain("更新后权限有变化，需要重新确认");
    expect(html).toContain("新增");
    expect(html).toContain("启动本机程序");
    expect(html).toContain("读取本机登录文件");
    expect(html).toContain("已有");
    expect(html).toContain("联网");
    expect(html).toContain("确认并启用");
    expect(html).toContain("保持停用");
  });

  it("安装前详情和首次安装进度正确展示审核版本、风险提示、Bun 进度与完成态", () => {
    const catalogItem: PluginCatalogView["plugins"][number] = {
      id: "agy-cli",
      version: "0.3.1",
      hasProviders: true,
      installed: false,
      manifest: {
        displayName: "Antigravity",
        description: "通过 agy CLI 接入模型。",
        extensions: {
          "com.hob.plugins": {
            publisher: "magpie-community",
            sourceUrl: "https://github.com/magpie-community/plugins/tree/main/packages/agy-cli",
            unofficial: true,
            reviewedVersion: "0.3.1",
            permissions: ["network", "subprocess", "local_credentials", "bun_runtime"],
            providers: [{ package: "@magpie-community/opencode-agy-cli-auth", version: "0.3.1", integrity: "sha512-x" }],
          },
        },
      },
    };
    const detailHtml = renderToStaticMarkup(
      <PluginPreInstallDetail item={catalogItem} sourceLabel="Hob 官方" onBack={() => {}} onInstall={() => {}} />,
    );
    expect(detailHtml).toContain("magpie-community");
    expect(detailHtml).toContain("我们审过的版本 0.3.1");
    expect(detailHtml).toContain("非官方接入风险提示");
    expect(detailHtml).toContain("安装并启用");

    const progressHtml = renderToStaticMarkup(
      <PluginInstallView
        item={catalogItem}
        done={false}
        progress={{ pluginId: "agy-cli", stage: "downloading_bun", downloadedBytes: 28 * 1024 * 1024, totalBytes: 42 * 1024 * 1024, percent: 67 }}
        host={{ status: "stopped", bunVersion: "1.4.2", bunInstalled: false, idleMs: 600_000 }}
        onBack={() => {}}
        onOpenPlugin={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(progressHtml).toContain("下载运行环境（Bun 1.4.2）");
    expect(progressHtml).toContain("67%");
    expect(progressHtml).toContain("取消安装");

    const doneHtml = renderToStaticMarkup(
      <PluginInstallView
        item={catalogItem}
        done={true}
        host={{ status: "running", bunVersion: "1.4.2", bunInstalled: true, idleMs: 600_000 }}
        onBack={() => {}}
        onOpenPlugin={() => {}}
        onRetry={() => {}}
      />,
    );
    expect(doneHtml).toContain("安装完成");
    expect(doneHtml).toContain("前往登录");
  });
});
