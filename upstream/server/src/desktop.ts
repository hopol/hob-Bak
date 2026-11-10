import { readFileSync } from "node:fs";
import { readSecrets } from "./secrets.ts";
import type { SettingsStore } from "./settings.ts";

export class DesktopService {
  constructor(private home: string, private settings: SettingsStore, private env: NodeJS.ProcessEnv = process.env) {}

  get deployed(): boolean {
    return !!(this.env.HOB_DESKTOP_URL && this.deploymentToken());
  }

  token(): string {
    return this.configuration().token;
  }

  private deploymentToken(): string {
    const token = this.env.HOB_DESKTOP_TOKEN;
    if (token) return token;
    const file = this.env.HOB_DESKTOP_TOKEN_FILE;
    if (!file) return "";
    try { return readFileSync(file, "utf8").trim(); } catch { return ""; }
  }

  private configuration() {
    const saved = this.settings.settings.desktop ?? { url: "", enabled: false, publicAssistants: [] };
    const deploymentToken = this.env.HOB_DESKTOP_URL ? this.deploymentToken() : "";
    const deployed = !!deploymentToken;
    const token = deployed ? deploymentToken : readSecrets(this.home)["desktop:token"] ?? "";
    return {
      revision: this.settings.get().revision,
      url: deployed ? this.env.HOB_DESKTOP_URL! : saved.url,
      enabled: deployed ? true : saved.enabled,
      deployed,
      tokenConfigured: !!token,
      publicAssistants: saved.publicAssistants ?? [],
      token,
    };
  }

  view() {
    const { token: _token, ...view } = this.configuration();
    return view;
  }

  connection() {
    const { enabled, url, token } = this.configuration();
    if (!enabled || !url || !token) throw new Error("云桌面未配置或尚未启用。");
    return { url: checkDesktopUrl(url), token };
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const { url, token } = this.connection();
    const response = await fetch(new URL(path, url), {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
      signal: init.signal ?? AbortSignal.timeout(10_000),
      redirect: "error",
    });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: unknown } } | null;
      const detail = typeof body?.error?.message === "string" ? body.error.message.replaceAll(token, "[已隐藏]") : "";
      throw new Error(`云桌面请求失败（HTTP ${response.status}）${detail ? `：${detail}` : "。"}`);
    }
    return response;
  }
}

export function checkDesktopUrl(value: string): string {
  if (!value.trim()) return "";
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("云桌面地址无效。"); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error("云桌面地址须为不含凭据或路径的 HTTP(S) 地址。");
  }
  return url.origin;
}
