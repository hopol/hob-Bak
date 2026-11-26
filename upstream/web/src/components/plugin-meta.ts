import { currentLocale, t } from "../../../shared/i18n.ts";
import type { PluginProviderSpec, PluginServiceStatus, PluginView } from "../../../shared/types.ts";
import type { IconName } from "../icons.tsx";

export function hobExtension(manifest: Record<string, unknown>): Record<string, unknown> {
  const extensions = manifest.extensions as Record<string, unknown> | undefined;
  const hob = extensions?.["com.hob.plugins"];
  return hob && typeof hob === "object" && !Array.isArray(hob) ? (hob as Record<string, unknown>) : {};
}

export function localizedText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const map = value as Record<string, unknown>;
  const locale = currentLocale();
  const preferred = locale === "en" ? [map.en, map["en-US"], map.zh, map["zh-CN"]] : [map.zh, map["zh-CN"], map.en, map["en-US"]];
  for (const candidate of preferred) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

export function pluginProviderSpecs(manifest: Record<string, unknown>): PluginProviderSpec[] {
  const raw = hobExtension(manifest).providers;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is PluginProviderSpec => Boolean(item && typeof item === "object" && typeof (item as PluginProviderSpec).package === "string"));
}

export function hasProviderContribution(manifest: Record<string, unknown>, hasProviders?: boolean): boolean {
  return Boolean(hasProviders) || pluginProviderSpecs(manifest).length > 0;
}

export function isUnofficialPlugin(manifest: Record<string, unknown>, hasProviders?: boolean): boolean {
  const hob = hobExtension(manifest);
  return hob.unofficial === true || hasProviderContribution(manifest, hasProviders);
}

export function pluginPublisher(manifest: Record<string, unknown>): string {
  const hob = hobExtension(manifest);
  if (typeof hob.publisher === "string" && hob.publisher.trim()) return hob.publisher.trim();
  if (typeof hob.maintainer === "string" && hob.maintainer.trim()) return hob.maintainer.trim();
  return "";
}

export function pluginSourceUrl(manifest: Record<string, unknown>): string {
  const hob = hobExtension(manifest);
  if (typeof hob.sourceUrl === "string" && hob.sourceUrl.trim()) return hob.sourceUrl.trim();
  if (typeof manifest.homepage === "string" && manifest.homepage.trim()) return manifest.homepage.trim();
  return "";
}

export function formatSourceDisplay(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

export function pluginReviewedVersion(manifest: Record<string, unknown>, fallbackVersion?: string): string {
  const hob = hobExtension(manifest);
  if (typeof hob.reviewedVersion === "string" && hob.reviewedVersion.trim()) return hob.reviewedVersion.trim();
  const firstSpec = pluginProviderSpecs(manifest)[0];
  if (firstSpec?.version) return firstSpec.version;
  return fallbackVersion ?? (typeof manifest.version === "string" ? manifest.version : "");
}

export function pluginRiskNotice(manifest: Record<string, unknown>): string {
  const hob = hobExtension(manifest);
  return (
    localizedText(hob.risk) ||
    localizedText(hob.riskNotice) ||
    t("此插件由社区维护，并非厂商官方接口，可能导致你的账号被厂商限制或封禁。插件以当前系统用户身份运行，进程隔离不是沙箱，请确认信任来源后再安装。")
  );
}

export function pluginPermissions(manifest: Record<string, unknown>, hasProviders?: boolean): string[] {
  const hob = hobExtension(manifest);
  const raw = Array.isArray(hob.permissions)
    ? hob.permissions.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim())
    : [];
  if (raw.length) return [...new Set(raw)];
  return hasProviderContribution(manifest, hasProviders) ? ["network", "bun_runtime"] : [];
}

export interface PermissionMeta {
  icon: IconName;
  title: string;
  desc: string;
}

export function permissionMeta(slug: string): PermissionMeta {
  switch (slug) {
    case "network":
      return {
        icon: "globe",
        title: t("联网"),
        desc: t("向模型接口与插件服务端发送对话请求，并拉取模型列表。"),
      };
    case "subprocess":
      return {
        icon: "term",
        title: t("启动本机程序"),
        desc: t("在运行 Hob 的机器上启动或代装插件所需的命令行程序。"),
      };
    case "local_credentials":
    case "local-auth":
      return {
        icon: "key",
        title: t("读取本机登录文件"),
        desc: t("读取运行 Hob 机器上已有的本机登录状态，不读取其他设备。"),
      };
    case "bun_runtime":
    case "bun-runtime":
      return {
        icon: "dl",
        title: t("下载运行环境"),
        desc: t("首次安装带模型的插件时，下载固定版本的 Bun 运行环境（约 42 MB）。"),
      };
    default:
      return {
        icon: "info",
        title: slug,
        desc: "",
      };
  }
}

export function pluginSummaryText(manifest: Record<string, unknown>, fallback: string): string {
  return localizedText(hobExtension(manifest).summary) || fallback;
}

export function pluginDetailText(manifest: Record<string, unknown>, fallback: string): string {
  return localizedText(hobExtension(manifest).description) || fallback;
}

export interface PluginBadgeStatus {
  tone: "connected" | "needs_login" | "needs_relogin" | "pending_config" | "connecting" | "error" | "disabled";
  label: string;
  rank: number;
}

export function pluginServiceStatusOf(item: PluginView): PluginServiceStatus | undefined {
  const priority: Record<PluginServiceStatus, number> = { error: 0, needs_relogin: 1, needs_login: 2, pending_config: 3, connecting: 4, idle: 5, connected: 6 };
  return item.services.map((service) => service.status).sort((a, b) => priority[a] - priority[b])[0];
}

/** 只能免登录启用的供应商（如公共免费模型）：没有账号可言，界面不出账号组，状态写「已启用」。 */
export function keylessOnly(providers: { methods: { keyless?: boolean }[] }[]): boolean {
  return providers.length > 0 && providers.every((p) => p.methods.length > 0 && p.methods.every((m) => m.keyless));
}

export function pluginOverallStatus(item: PluginView): PluginBadgeStatus | null {
  if (item.plugin.needsApproval) {
    return { tone: "needs_login", label: t("待确认"), rank: 0 };
  }
  if (!item.plugin.enabled) {
    return { tone: "disabled", label: t("已停用"), rank: 6 };
  }
  if (item.providers && item.providers.length > 0) {
    const accounts = item.providers.flatMap((p) => p.accounts);
    const active = accounts.find((a) => a.active);
    if (active?.status === "logged_in") {
      return { tone: "connected", label: keylessOnly(item.providers) ? t("已启用") : t("已登录"), rank: 9 };
    }
    if (active?.status === "expired" || accounts.some((a) => a.status === "expired")) {
      return { tone: "error", label: t("已过期"), rank: 2 };
    }
    if (active?.status === "needs_relogin" || accounts.some((a) => a.status === "needs_relogin")) {
      return { tone: "needs_relogin", label: t("需要重新登录"), rank: 2 };
    }
    if (active?.status === "error" || item.providers.some((p) => p.error && !p.accounts.length)) {
      return { tone: "error", label: t("出错"), rank: 3 };
    }
    return { tone: "needs_login", label: t("需要登录"), rank: 1 };
  }
  if (item.credentialRoles?.includes("list")) {
    return { tone: "connected", label: t("已开启"), rank: 9 };
  }
  const status = pluginServiceStatusOf(item);
  if (item.login && item.login.status?.signedIn === false && !item.login.status.optional && status !== "pending_config" && status !== "error") {
    return { tone: "needs_login", label: t("未登录"), rank: 1 };
  }
  if (!status) return null;
  const labels: Record<PluginServiceStatus, string> = {
    pending_config: t("待配置"),
    connecting: t("连接中"),
    idle: t("已连接"),
    connected: t("已连接"),
    needs_login: t("需要登录"),
    needs_relogin: t("需要重新登录"),
    error: t("出错"),
  };
  const ranks: Record<PluginServiceStatus, number> = {
    pending_config: 0,
    needs_login: 1,
    needs_relogin: 2,
    error: 3,
    connecting: 4,
    idle: 9,
    connected: 9,
  };
  // 闲置停掉是内部省内存的事，和连着一样显示
  return { tone: status === "idle" ? "connected" : status, label: labels[status], rank: ranks[status] };
}

export function formatContextWindow(tokens: number): string {
  if (!tokens || tokens <= 0) return "";
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1000)}K`;
}

export function formatBytesMb(bytes?: number): string {
  if (bytes === undefined || bytes < 0) return "";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
