import { useEffect, useRef, useState } from "react";
import { currentLocale, t } from "../../../shared/i18n.ts";
import type {
  PluginAuthMethodView,
  PluginAuthPromptView,
  PluginCliStatusView,
  PluginModelOverride,
  PluginProviderAccountView,
  PluginProviderModelView,
  PluginProviderUsageView,
  PluginProviderView,
  PluginSignInSessionView,
  PluginView,
  ProviderHostStatusView,
  ThinkingLevel,
} from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import { fmtWhen } from "../util.ts";
import {
  approvePlugin,
  cancelPluginSignIn,
  checkPluginProviderCli,
  deletePluginAccount,
  installPluginProviderCli,
  loadPluginProviders,
  loadPluginProviderUsage,
  MOCK,
  pastePluginSignIn,
  pollPluginSignIn,
  promptPluginAuth,
  refreshPluginModels,
  setPluginModelOverride,
  setPluginActiveAccount,
  signInPluginApiKey,
  startPluginSignIn,
  submitPluginSignInCode,
  useApp,
} from "../store.ts";
import { Disclosure } from "./Disclosure.tsx";
import { formatContextWindow, keylessOnly, permissionMeta, pluginPermissions, pluginReviewedVersion } from "./plugin-meta.ts";
import { Seg } from "./SettingsParts.tsx";
import { ModelParamsEditor, ThinkingLevels } from "./ModelParams.tsx";

function localizedMethodLabel(method: PluginAuthMethodView): string {
  const locale = currentLocale();
  if (method.labels) {
    const preferred = locale === "en"
      ? [method.labels.en, method.labels["en-US"], method.labels.zh, method.labels["zh-CN"]]
      : [method.labels.zh, method.labels["zh-CN"], method.labels.en, method.labels["en-US"]];
    for (const candidate of preferred) {
      if (candidate?.trim()) return candidate.trim();
    }
  }
  if (method.type === "api" && !method.keyless) return method.label || t("API 密钥");
  return method.label || t("网页登录");
}

function localizedPromptMessage(prompt: PluginAuthPromptView): string {
  const locale = currentLocale();
  if (prompt.messages) {
    const preferred = locale === "en"
      ? [prompt.messages.en, prompt.messages.zh]
      : [prompt.messages.zh, prompt.messages.en];
    for (const candidate of preferred) {
      if (candidate?.trim()) return candidate.trim();
    }
  }
  return prompt.message;
}

function thinkingLevelName(level: ThinkingLevel): string {
  return ({
    off: t("关闭"),
    minimal: t("最低"),
    low: t("低"),
    medium: t("中"),
    high: t("高"),
    xhigh: t("很高"),
    max: t("最高"),
  } as Record<ThinkingLevel, string>)[level] ?? level;
}

function modelThinkingSummary(model: PluginProviderModelView): string {
  if (!model.reasoning || !model.thinkingLevels.length) return t("无思考档");
  return t("思考档：{levels}", { levels: model.thinkingLevels.map(thinkingLevelName).join(" / ") });
}

function remainingMinutes(expiresAt?: string): number | null {
  if (!expiresAt) return null;
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (!Number.isFinite(diff)) return null;
  return Math.max(0, Math.ceil(diff / 60_000));
}

function extractLoopbackHost(url?: string): string {
  if (!url) return "127.0.0.1";
  try {
    const outer = new URL(url);
    const redirect = outer.searchParams.get("redirect_uri");
    if (redirect) {
      const inner = new URL(redirect);
      if (inner.hostname === "127.0.0.1" || inner.hostname === "localhost") {
        return inner.port ? `${inner.hostname}:${inner.port}` : inner.hostname;
      }
    }
    if (outer.hostname === "127.0.0.1" || outer.hostname === "localhost") {
      return outer.port ? `${outer.hostname}:${outer.port}` : outer.hostname;
    }
  } catch { /* fallback */ }
  return "127.0.0.1";
}

function formatResetTime(resetsAt?: string, resetSecs?: number): string {
  if (resetsAt) {
    const dt = new Date(resetsAt);
    if (!Number.isNaN(dt.getTime())) {
      const now = new Date();
      const time = dt.toLocaleTimeString(currentLocale() === "en" ? "en-US" : "zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
      const sameDay = dt.getFullYear() === now.getFullYear() && dt.getMonth() === now.getMonth() && dt.getDate() === now.getDate();
      if (sameDay) return t("{time} 重置", { time });
      const weekday = dt.toLocaleDateString(currentLocale() === "en" ? "en-US" : "zh-CN", { weekday: "short" });
      return t("{day} {time} 重置", { day: weekday, time });
    }
  }
  if (typeof resetSecs === "number" && resetSecs > 0) {
    const hours = Math.floor(resetSecs / 3600);
    const mins = Math.ceil((resetSecs % 3600) / 60);
    if (hours > 0) return t("{hours} 小时后重置", { hours });
    return t("{mins} 分钟后重置", { mins });
  }
  return "";
}

function accountStatusBadge(status: PluginProviderAccountView["status"]): { cls: string; label: string } {
  switch (status) {
    case "logged_in":
      return { cls: "connected", label: t("已登录") };
    case "needs_relogin":
      return { cls: "needs_relogin", label: t("需要重新登录") };
    case "expired":
      return { cls: "error", label: t("已过期") };
    case "error":
      return { cls: "error", label: t("出错") };
  }
}

export function PluginUpdateApprovalBanner({
  item,
  busy,
  onApprove,
  onKeepDisabled,
}: {
  item: PluginView;
  busy?: boolean;
  onApprove: () => void;
  onKeepDisabled: () => void;
}) {
  const version = pluginReviewedVersion(item.manifest, item.plugin.version);
  const changes = item.plugin.capabilityChanges ?? [];
  const allPerms = pluginPermissions(item.manifest, Boolean(item.providers?.length));

  const newPermSlugs = new Set<string>();
  const extraChanges: string[] = [];
  for (const ch of changes) {
    const match = /^新增权限[：:]\s*(.+)$/.exec(ch);
    if (match) {
      newPermSlugs.add(match[1].trim());
    } else {
      extraChanges.push(ch);
    }
  }

  const orderedPerms = [
    ...allPerms.filter((p) => newPermSlugs.has(p)).map((slug) => ({ slug, isNew: true })),
    ...[...newPermSlugs].filter((p) => !allPerms.includes(p)).map((slug) => ({ slug, isNew: true })),
    ...allPerms.filter((p) => !newPermSlugs.has(p)).map((slug) => ({ slug, isNew: false })),
  ];

  return (
    <section className="plugin-connection warn">
      <div className="plugin-connection-top">
        <span className="plugin-state needs_login">
          <span className="plugin-state-dot" />
          {t("更新后权限有变化，需要重新确认")}
        </span>
        <span className="sp" />
        <span className="plugin-state disabled">{t("已暂停")}</span>
      </div>
      <div className="plugin-connection-detail">
        {t("插件已更新到 {version}（已审）。新版本增加了以下能做的事，在你确认之前不会重新启用。", { version })}
      </div>
      {(orderedPerms.length > 0 || extraChanges.length > 0) ? (
        <div className="plugin-perm-list">
          {orderedPerms.map(({ slug, isNew }) => {
            const meta = permissionMeta(slug);
            return (
              <div className="plugin-perm-row" key={slug}>
                <span className={`plugin-perm-tag ${isNew ? "new" : "old"}`}>{isNew ? t("新增") : t("已有")}</span>
                <span className="plugin-perm-name">{meta.title}</span>
                {meta.desc ? <span className="plugin-perm-desc">{meta.desc}</span> : null}
              </div>
            );
          })}
          {extraChanges.map((text) => (
            <div className="plugin-perm-row" key={text}>
              <span className="plugin-perm-tag new">{t("新增")}</span>
              <span className="plugin-perm-name">{text}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div className="plugin-actions">
        <button type="button" className="hob-btn hob-btn-primary" disabled={busy} onClick={onApprove}>
          {busy ? <Icon name="spin" size={14} className="spin" /> : null}
          {t("确认并启用")}
        </button>
        <button type="button" className="hob-btn plugin-btn-white" disabled={busy} onClick={onKeepDisabled}>
          {t("保持停用")}
        </button>
      </div>
    </section>
  );
}

export function ProviderStatusStrip({
  providers,
  host,
  toolCount,
}: {
  providers: PluginProviderView[];
  host?: ProviderHostStatusView;
  toolCount: number;
}) {
  const accounts = providers.flatMap((p) => p.accounts);
  const active = accounts.find((a) => a.active);
  const totalModels = providers.reduce((sum, p) => sum + p.models.length, 0);
  const fellBack = providers.some((p) => p.modelsFellBack || Boolean(p.modelsError));

  let tone: "ok" | "warn" | "bad" = "warn";
  let badgeCls = "needs_login";
  let badgeLabel = t("需要登录");

  if (active?.status === "logged_in") {
    tone = "ok";
    badgeCls = "connected";
    badgeLabel = keylessOnly(providers) ? t("已启用") : t("已登录");
  } else if (active?.status === "expired" || accounts.some((a) => a.status === "expired")) {
    tone = "bad";
    badgeCls = "error";
    badgeLabel = t("已过期");
  } else if (active?.status === "needs_relogin" || accounts.some((a) => a.status === "needs_relogin")) {
    tone = "warn";
    badgeCls = "needs_relogin";
    badgeLabel = t("需要重新登录");
  } else if (active?.status === "error" || providers.some((p) => p.error && !p.accounts.length)) {
    tone = "bad";
    badgeCls = "error";
    badgeLabel = t("出错");
  }

  const summaryParts: string[] = [];
  if (totalModels > 0) {
    summaryParts.push(fellBack ? t("{n} 个模型（上次缓存）", { n: totalModels }) : t("{n} 个模型", { n: totalModels }));
  }
  if (toolCount > 0) {
    summaryParts.push(t("{n} 个工具", { n: toolCount }));
  }
  const detailError = providers.find((p) => p.error)?.error || (host?.status === "error" ? host.lastError : "");

  return (
    <section className={`plugin-connection${tone === "ok" ? "" : ` ${tone}`}`}>
      <div className="plugin-connection-top">
        <span className={`plugin-state ${badgeCls}`}>
          <span className="plugin-state-dot" />
          {badgeLabel}
        </span>
        {summaryParts.length ? <span className="plugin-connection-tools">{summaryParts.join(" · ")}</span> : null}
      </div>
      {detailError ? <div className="plugin-connection-detail">{detailError}</div> : null}
    </section>
  );
}

export function ProviderQuotaSection({
  provider,
  busy,
  onRefresh,
}: {
  provider: PluginProviderView;
  busy?: boolean;
  onRefresh: () => void;
}) {
  const active = provider.accounts.find((a) => a.active);
  const usage: PluginProviderUsageView | undefined = provider.usage;
  if (!usage || (!usage.error && !usage.windows.length && !usage.balance)) return null;

  return (
    <section className="plugin-section">
      <div className="plugin-sec-head">
        <h2>
          {t("额度")}
          {active ? <span className="plugin-state">{active.displayName}</span> : null}
        </h2>
        <span className="sp" />
        {!usage?.error ? (
          <button type="button" className="hob-icon-btn" title={t("刷新额度")} aria-label={t("刷新额度")} disabled={busy} onClick={onRefresh}>
            <Icon name={busy ? "spin" : "retry"} size={15} className={busy ? "spin" : undefined} />
          </button>
        ) : null}
      </div>

      {usage?.error ? (
        <section className="plugin-connection bad plugin-err-card">
          <div className="plugin-connection-top">
            <span className="plugin-state error"><span className="plugin-state-dot" />{t("拿不到额度")}</span>
            <span className="sp" />
            <button type="button" className="hob-btn hob-btn-compact plugin-btn-white" disabled={busy} onClick={onRefresh}>
              {t("重试")}
            </button>
          </div>
          <div className="plugin-connection-detail">{t("拿不到额度：{reason}", { reason: usage.error })}</div>
        </section>
      ) : usage && usage.windows.length > 0 ? (
        <div className="plugin-list">
          {usage.windows.map((w, idx) => {
            const pct = typeof w.used === "number" && Number.isFinite(w.used) ? Math.max(0, Math.min(100, Math.round(w.used))) : null;
            const reset = formatResetTime(w.resetsAt, w.resetSecs);
            const meta = w.display
              ? [w.display, reset].filter(Boolean).join(" · ")
              : pct !== null
                ? [t("已用 {pct}%", { pct }), reset].filter(Boolean).join(" · ")
                : reset || t("暂无数据");
            return (
              <div className="plugin-quota" key={`${w.name}-${idx}`}>
                <div className="plugin-quota-top">
                  <span className="plugin-quota-label">{w.name}</span>
                  <span className="plugin-quota-meta">{meta}</span>
                </div>
                {pct !== null ? (
                  <div className="plugin-bar"><i style={{ width: `${pct}%` }} /></div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : usage.balance ? (
        <div className="plugin-list">
          <div className="plugin-kv">
            <span className="k">{usage.plan || t("余量")}</span>
            <span className="v">{usage.balance}</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * 一个模型：一整行点开改参数，和设置 → 服务商里兼容接口的模型一样（能看图、会推理、上下文窗口、单次最多输出、思考档）。
 * 插件没给或给得不对的参数在这里改；改过的可以恢复成插件给的。
 */
function PluginModelRow({
  pluginId,
  providerId,
  model,
  onProviders,
  onChanged,
}: {
  pluginId: string;
  providerId: string;
  model: PluginProviderModelView;
  onProviders: (providers: PluginProviderView[]) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (override: PluginModelOverride | null) => {
    setBusy(true);
    setError(null);
    try {
      onProviders((await setPluginModelOverride(pluginId, providerId, { modelId: model.id, override })).providers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`plugin-model-item${open ? " open" : ""}`}>
      <button type="button" className="plugin-model" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <div className="plugin-model-main">
          <div className="plugin-model-name">{model.name || model.id}</div>
          <div className="plugin-model-sub">{modelThinkingSummary(model)}</div>
        </div>
        <span className="plugin-model-caps">
          {model.input.includes("image") ? <Icon name="image" size={14} /> : null}
          {model.reasoning ? <Icon name="bulb" size={14} /> : null}
          {model.contextWindow > 0 ? <span>{formatContextWindow(model.contextWindow)}</span> : null}
        </span>
        <Icon name="down" size={14} className="disclosure-arrow" />
      </button>
      {open ? (
        <div className="plugin-model-edit">
          <ModelParamsEditor id={model.id} params={model} busy={busy} onEdit={(patch) => void save(patch)} />
          {model.reasoning && model.thinking ? <ThinkingLevels modelRef={model.thinking.ref} info={model.thinking} disabled={busy} onSaved={onChanged} /> : null}
          {model.overridden ? (
            <button type="button" className="plugin-model-reset" disabled={busy} onClick={() => void save(null)}>
              {t("恢复插件给的参数")}
            </button>
          ) : null}
          {error ? <div className="badline">{error}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

export function ProviderModelsSection({
  pluginId,
  provider,
  busy,
  onRefresh,
  onProviders,
  onChanged,
  paused,
}: {
  pluginId: string;
  provider: PluginProviderView;
  busy?: boolean;
  onRefresh: () => void;
  onProviders: (providers: PluginProviderView[]) => void;
  onChanged: () => void;
  paused?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const models = provider.models;
  const collapse = models.length > 4 && !expanded;
  const shown = collapse ? models.slice(0, 2) : models;
  const hiddenCount = collapse ? models.length - shown.length : 0;

  if (!models.length && !provider.modelsError) return null;

  const meta = provider.modelsError && provider.modelsCachedAt
    ? t("{n} 个 · 缓存于 {time}", { n: models.length, time: fmtWhen(provider.modelsCachedAt) })
    : t("{n} 个", { n: models.length });

  return (
    <section className="plugin-section">
      <div className="plugin-sec-head">
        <h2>
          {t("模型")}
          <span className="plugin-state">{meta}</span>
        </h2>
        <span className="sp" />
        {!paused && !provider.modelsError ? (
          <button type="button" className="hob-icon-btn" title={t("刷新模型列表")} aria-label={t("刷新模型列表")} disabled={busy} onClick={onRefresh}>
            <Icon name={busy ? "spin" : "retry"} size={15} className={busy ? "spin" : undefined} />
          </button>
        ) : null}
      </div>

      {provider.modelsError ? (
        <section className="plugin-connection bad plugin-err-card">
          <div className="plugin-connection-top">
            <span className="plugin-state error"><span className="plugin-state-dot" />{t("拉取模型列表失败")}</span>
            <span className="sp" />
            <button type="button" className="hob-btn hob-btn-compact plugin-btn-white" disabled={busy} onClick={onRefresh}>
              {t("重新拉取")}
            </button>
          </div>
          <div className="plugin-connection-detail">
            {models.length > 0
              ? t("{reason} 已保留上次成功获取的模型列表，现有模型仍可继续使用。", { reason: provider.modelsError })
              : provider.modelsError}
          </div>
        </section>
      ) : null}

      {models.length > 0 ? (
        <div className="plugin-list">
          {shown.map((model) => (
            <PluginModelRow key={model.id} pluginId={pluginId} providerId={provider.providerId} model={model} onProviders={onProviders} onChanged={onChanged} />
          ))}
          {models.length > 4 ? (
            <Disclosure
              className="plugin-tool-more"
              label={t("其余模型")}
              count={hiddenCount || models.length - 2}
              open={expanded}
              onToggle={() => setExpanded((v) => !v)}
            >
              {models.slice(2).map((model) => (
                <PluginModelRow key={model.id} pluginId={pluginId} providerId={provider.providerId} model={model} onProviders={onProviders} onChanged={onChanged} />
              ))}
            </Disclosure>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function DeviceCodeLoginCard({
  userCode,
  url,
  expiresAt,
  status,
  error,
  actionError,
  busy = false,
  verbatimError = false,
  onRestart,
  onCancel,
}: {
  userCode?: string;
  url?: string;
  expiresAt?: string;
  status: "pending" | "waiting" | "failed" | "expired";
  error?: string;
  actionError?: string;
  busy?: boolean;
  verbatimError?: boolean;
  onRestart?: () => void;
  onCancel: () => void;
}) {
  const [copiedField, setCopiedField] = useState<"code" | "url" | null>(null);
  const copyText = (field: "code" | "url", text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopiedField(field);
    window.setTimeout(() => setCopiedField((cur) => (cur === field ? null : cur)), 1800);
  };
  const minsLeft = remainingMinutes(expiresAt);
  return (
    <div className="plugin-login-card">
      <div className="plugin-login-title">{t("通过设备码登录")}</div>
      <div className="plugin-login-desc">
        {t("在浏览器中打开下方网址并输入设备码完成授权。成功后会自动变成已登录状态，远程部署的 Hob 也可直接使用。")}
      </div>
      <div className="plugin-code-group">
        {userCode ? (
          <div className="plugin-code-row">
            <div className="plugin-code-main">
              <div className="plugin-code-k">{t("设备码")}</div>
              <div className="plugin-code-val">{userCode}</div>
            </div>
            <button
              type="button"
              className="hob-icon-btn"
              title={copiedField === "code" ? t("已复制") : t("复制设备码")}
              aria-label={t("复制设备码")}
              onClick={() => copyText("code", userCode)}
            >
              <Icon name={copiedField === "code" ? "check" : "copy"} size={15} />
            </button>
          </div>
        ) : null}
        {url ? (
          <div className="plugin-code-row">
            <div className="plugin-code-main">
              <div className="plugin-code-k">{t("验证网址")}</div>
              <div className="plugin-url-val">{url}</div>
            </div>
            <button
              type="button"
              className="hob-icon-btn"
              title={copiedField === "url" ? t("已复制") : t("复制网址")}
              aria-label={t("复制网址")}
              onClick={() => copyText("url", url)}
            >
              <Icon name={copiedField === "url" ? "check" : "copy"} size={15} />
            </button>
          </div>
        ) : null}
      </div>
      {actionError ? <div className="badline" role="alert">{actionError}</div> : null}
      <div className="plugin-actions">
        {url ? (
          <a className="hob-btn hob-btn-primary" href={url} target="_blank" rel="noreferrer">
            {t("打开网页")}
            <Icon name="out" size={14} />
          </a>
        ) : null}
        {(status === "expired" || status === "failed") && onRestart ? (
          <button type="button" className="hob-btn hob-btn-primary" disabled={busy} onClick={onRestart}>
            {t("重新发起")}
          </button>
        ) : null}
        <button type="button" className="hob-btn plugin-btn-white" disabled={busy} onClick={onCancel}>
          {t("取消")}
        </button>
      </div>
      {status === "expired" ? (
        <div className="plugin-wait bad" role="alert">
          <Icon name="alert" size={15} />
          <span>{error || t("登录已过期，请重新发起登录。")}</span>
        </div>
      ) : status === "failed" ? (
        <div className="plugin-wait bad" role="alert">
          <Icon name="alert" size={15} />
          <span>{verbatimError ? (error || t("未知错误")) : t("登录失败：{reason}", { reason: error || t("未知错误") })}</span>
        </div>
      ) : (
        <div className="plugin-wait">
          <Icon name="spin" size={15} className="spin" />
          <span>
            {minsLeft !== null && minsLeft > 0
              ? t("{text} · 约 {mins} 分钟后过期", { text: t("等你在网页上确认…"), mins: minsLeft })
              : t("等你在网页上确认…")}
          </span>
        </div>
      )}
    </div>
  );
}

export function ProviderSignInCard({
  pluginId,
  provider,
  session,
  cli,
  reloginAccountId,
  initialMethodIndex,
  onSessionChange,
  onCliChange,
  onDone,
  onCancel,
}: {
  pluginId: string;
  provider: PluginProviderView;
  session?: PluginSignInSessionView;
  cli?: PluginCliStatusView;
  reloginAccountId?: string;
  initialMethodIndex?: number;
  onSessionChange: (next: PluginSignInSessionView | undefined) => void;
  onCliChange: (next: PluginCliStatusView) => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const methods = provider.methods;
  const defaultIdx = initialMethodIndex !== undefined && initialMethodIndex >= 0 && initialMethodIndex < methods.length
    ? initialMethodIndex
    : session?.methodIndex ?? 0;
  const [methodIdx, setMethodIdx] = useState(defaultIdx);
  const [apiKey, setApiKey] = useState("");
  const [accountName, setAccountName] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [pasteUrl, setPasteUrl] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [prompt, setPrompt] = useState<PluginAuthPromptView | null>(null);
  const [promptInputs, setPromptInputs] = useState<Record<string, string>>({});
  const [promptVal, setPromptVal] = useState("");
  const [copiedField, setCopiedField] = useState<"code" | "url" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const copyTimer = useRef<number | null>(null);

  useEffect(() => {
    if (session && session.methodIndex !== methodIdx) {
      setMethodIdx(session.methodIndex);
    }
  }, [session?.sessionId]);

  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
  }, []);

  const method = methods[methodIdx];
  const isCliProvider = Boolean(cli?.declared || provider.cli?.declared || session?.kind === "local_cli");
  const effectiveCli = cli ?? provider.cli;

  const copyText = (field: "code" | "url", value: string) => {
    void navigator.clipboard?.writeText(value).catch(() => {});
    setCopiedField(field);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopiedField(null), 1600);
  };

  const handleCancel = async () => {
    setError("");
    if (session && (session.status === "waiting" || session.status === "pending")) {
      setBusy(true);
      try {
        await cancelPluginSignIn(pluginId, provider.providerId, session.sessionId);
      } catch { /* ignore cancel failure */ }
      finally {
        setBusy(false);
      }
    }
    onSessionChange(undefined);
    setPrompt(null);
    setPromptInputs({});
    onCancel();
  };

  const beginOAuth = async (targetIdx = methodIdx, inputs: Record<string, string> = {}) => {
    setBusy(true);
    setError("");
    try {
      const target = methods[targetIdx];
      if (target?.hasPrompts) {
        const res = await promptPluginAuth(pluginId, provider.providerId, { methodIndex: targetIdx, inputs });
        if (res.prompt) {
          setPrompt(res.prompt);
          setPromptInputs(inputs);
          setPromptVal(res.prompt.options?.[0]?.value ?? "");
          setBusy(false);
          return;
        }
      }
      setPrompt(null);
      const next = await startPluginSignIn(pluginId, provider.providerId, {
        methodIndex: targetIdx,
        inputs,
        ...(reloginAccountId ? { accountId: reloginAccountId } : {}),
      });
      onSessionChange(next);
      if (next.status === "completed") onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitPromptStep = async () => {
    if (!prompt) return;
    setBusy(true);
    setError("");
    try {
      const check = await promptPluginAuth(pluginId, provider.providerId, {
        methodIndex: methodIdx,
        validateKey: prompt.key,
        validateValue: promptVal,
      });
      if (check.error) {
        setError(check.error);
        setBusy(false);
        return;
      }
      const nextInputs = { ...promptInputs, [prompt.key]: promptVal };
      await beginOAuth(methodIdx, nextInputs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const submitApiKey = async () => {
    if (!method) return;
    if (!method.keyless && !apiKey.trim()) {
      setError(t("请填写 API 密钥"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      await signInPluginApiKey(pluginId, provider.providerId, {
        methodIndex: methodIdx,
        ...(method.keyless ? {} : { key: apiKey.trim() }),
        ...(accountName.trim() ? { displayName: accountName.trim() } : {}),
        ...(reloginAccountId ? { accountId: reloginAccountId } : {}),
      });
      setApiKey("");
      setAccountName("");
      onSessionChange(undefined);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitPaste = async () => {
    if (!session) return;
    if (!pasteUrl.trim()) {
      setError(t("请粘贴浏览器地址"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await pastePluginSignIn(pluginId, provider.providerId, { sessionId: session.sessionId, url: pasteUrl.trim() });
      onSessionChange(next);
      if (next.status === "completed") {
        setPasteUrl("");
        onDone();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async () => {
    if (!session) return;
    if (!authCode.trim()) {
      setError(t("请输入授权码"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const next = await submitPluginSignInCode(pluginId, provider.providerId, { sessionId: session.sessionId, code: authCode.trim() });
      onSessionChange(next);
      if (next.status === "completed") {
        setAuthCode("");
        onDone();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleCheckCli = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await checkPluginProviderCli(pluginId, provider.providerId);
      onCliChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleInstallCli = async () => {
    setBusy(true);
    setError("");
    try {
      const next = await installPluginProviderCli(pluginId, provider.providerId);
      onCliChange(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const switchMethod = (idx: number) => {
    if (idx === methodIdx) return;
    if (session && session.status === "waiting") {
      void cancelPluginSignIn(pluginId, provider.providerId, session.sessionId).catch(() => {});
      onSessionChange(undefined);
    }
    setPrompt(null);
    setPromptInputs({});
    setError("");
    setMethodIdx(idx);
  };

  // Method switcher when multiple methods exist (and not inside local CLI-only view before install)
  const showSwitcher = methods.length > 1 && !(isCliProvider && !effectiveCli?.installed);
  const switcher = showSwitcher ? (
    methods.length <= 3 ? (
      <div className="plugin-seg-wrap">
        <Seg
          items={methods.map((m, i) => ({ key: String(i), label: localizedMethodLabel(m) }))}
          value={String(methodIdx)}
          disabled={busy}
          onChange={(k) => switchMethod(Number(k))}
        />
      </div>
    ) : (
      <label className="lbl">
        {t("登录方式")}
        <select className="field" value={String(methodIdx)} disabled={busy} onChange={(e) => switchMethod(Number(e.target.value))}>
          {methods.map((m, i) => (
            <option key={i} value={String(i)}>{localizedMethodLabel(m)}</option>
          ))}
        </select>
      </label>
    )
  ) : null;

  const minsLeft = remainingMinutes(session?.expiresAt);
  const renderSessionFooter = (s: PluginSignInSessionView, waitingText: string) => {
    if (s.status === "expired") {
      return (
        <div className="plugin-wait bad" role="alert">
          <Icon name="alert" size={15} />
          <span>{s.error || t("登录已过期，请重新发起登录。")}</span>
        </div>
      );
    }
    if (s.status === "failed") {
      return (
        <div className="plugin-wait bad" role="alert">
          <Icon name="alert" size={15} />
          <span>{t("登录失败：{reason}", { reason: s.error || t("未知错误") })}</span>
        </div>
      );
    }
    if (s.status === "waiting" || s.status === "pending") {
      return (
        <div className="plugin-wait">
          <Icon name="spin" size={15} className="spin" />
          <span>
            {minsLeft !== null && minsLeft > 0
              ? t("{text} · 约 {mins} 分钟后过期", { text: waitingText, mins: minsLeft })
              : waitingText}
          </span>
        </div>
      );
    }
    return null;
  };

  // Flow 5: Local CLI detection (07e)
  // 只有插件不声明任何登录方式、全靠本机命令行时才出检测卡；声明了登录方式的照常走登录，缺的命令行由服务端在登录前装好
  if (isCliProvider && (session?.kind === "local_cli" || (!session && methods.length === 0))) {
    const cliName = effectiveCli?.name || t("本机客户端");
    const installed = Boolean(effectiveCli?.installed);
    const hasLoggedAccount = provider.accounts.some((a) => a.status === "logged_in");
    return (
      <section className="plugin-section">
        <h2>{t("本机客户端检测")}</h2>
        <div className="plugin-login-card">
          <div className="plugin-login-title">{t("使用本机已登录的 {name}", { name: cliName })}</div>
          <div className="plugin-remote-note">
            <Icon name="info" size={15} />
            <span>{session?.localCliNote || t("这是运行 Hob 的那台机器上的登录，不是你当前使用的设备。")}</span>
          </div>
          <div className="plugin-code-group">
            <div className="plugin-kv">
              <span className="k">{t("{name} 程序", { name: cliName })}</span>
              <span className="v">
                <span className={`plugin-state ${installed ? "connected" : "needs_login"}`}>
                  <span className="plugin-state-dot" />
                  {installed ? t("已找到") : t("未找到")}
                </span>
              </span>
            </div>
            <div className="plugin-kv">
              <span className="k">{t("登录状态")}</span>
              <span className="v">
                <span className={`plugin-state ${hasLoggedAccount ? "connected" : "disabled"}`}>
                  <span className="plugin-state-dot" />
                  {hasLoggedAccount ? t("已登录") : t("未登录")}
                </span>
              </span>
            </div>
            <div className="plugin-kv">
              <span className="k">{t("检测位置")}</span>
              <span className="v">{t("运行 Hob 的本机 PATH")}</span>
            </div>
          </div>
          {effectiveCli?.manual && !installed ? (
            <div className="plugin-cli-cmd">{effectiveCli.manual}</div>
          ) : null}
          {effectiveCli?.error ? <div className="badline" role="alert">{effectiveCli.error}</div> : null}
          {error ? <div className="badline" role="alert">{error}</div> : null}
          <div className="plugin-login-desc">
            {installed
              ? t("已找到 {name}。点击下方按钮完成本机登录授权，或重新检测状态。", { name: cliName })
              : t("此插件支持自动安装 {name}。安装并在运行 Hob 的机器上完成登录后，点击「重新检测」即可启用模型。", { name: cliName })}
          </div>
          {session ? renderSessionFooter(session, t("正在等待本机客户端完成登录…")) : null}
          <div className="plugin-actions">
            {!installed ? (
              <button type="button" className="hob-btn hob-btn-primary" disabled={busy || effectiveCli?.installing} onClick={() => void handleInstallCli()}>
                <Icon name={busy || effectiveCli?.installing ? "spin" : "dl"} size={15} className={busy || effectiveCli?.installing ? "spin" : undefined} />
                {t("安装 {name}", { name: cliName })}
              </button>
            ) : methods.length > 0 ? (
              <button type="button" className="hob-btn hob-btn-primary" disabled={busy} onClick={() => void beginOAuth(methodIdx)}>
                {busy ? <Icon name="spin" size={14} className="spin" /> : null}
                {t("开始登录")}
              </button>
            ) : null}
            <button type="button" className="hob-btn plugin-btn-white" disabled={busy} onClick={() => void handleCheckCli()}>
              <Icon name="retry" size={15} />
              {t("重新检测")}
            </button>
            <button type="button" className="hob-btn plugin-btn-white" disabled={busy} onClick={() => void handleCancel()}>
              {t("取消")}
            </button>
          </div>
        </div>
      </section>
    );
  }

  // Active OAuth / Device / Web Poll / Loopback Paste / Code session
  if (session && session.kind !== "api") {
    // Flow 1: Device code (07a) — NO divider between code & URL; BOTH copy buttons unified as hob-icon-btn!
    if (session.kind === "device_code") {
      return (
        <section className="plugin-section">
          <h2>{t("登录账号")}</h2>
          {switcher}
          <DeviceCodeLoginCard
            userCode={session.userCode}
            url={session.url}
            expiresAt={session.expiresAt}
            status={session.status === "expired" ? "expired" : session.status === "failed" ? "failed" : "waiting"}
            error={session.error}
            actionError={error || undefined}
            busy={busy}
            onRestart={() => void beginOAuth(methodIdx)}
            onCancel={() => void handleCancel()}
          />
        </section>
      );
    }

    // Flow 3: Loopback paste (07c)
    if (session.kind === "loopback_paste" || session.loopbackPasteAllowed) {
      const host = extractLoopbackHost(session.url);
      return (
        <section className="plugin-section">
          <h2>{t("登录账号")}</h2>
          {switcher}
          <div className="plugin-login-card">
            <div className="plugin-login-title">{t("网页登录并完成本机回调")}</div>
            <div className="plugin-login-desc">
              {t("1. 点击下方按钮打开登录页。如果 Hob 和浏览器在同一台机器上，登录完成后会自动跳回。")}
            </div>
            {session.url ? (
              <div className="plugin-actions">
                <a className="hob-btn plugin-btn-white" href={session.url} target="_blank" rel="noreferrer">
                  {t("打开网页登录")}
                  <Icon name="out" size={14} />
                </a>
              </div>
            ) : null}
            <div className="plugin-login-desc plugin-login-desc-sp">
              {t("2. 如果 Hob 运行在另一台机器上，浏览器最后会停在一个无法打开的本机地址，请把地址栏里的完整网址粘贴到下方：")}
            </div>
            <label className="lbl">
              {t("把浏览器最后停住的地址粘贴到这里")}
              <input
                className="field"
                value={pasteUrl}
                placeholder={`http://${host}/auth/callback?code=...`}
                onChange={(e) => { setPasteUrl(e.target.value); setError(""); }}
              />
            </label>
            <div className="plugin-note">
              {t("Hob 只接受本次登录发出的本机回调地址（{host}），其他地址会被拒绝。", { host })}
            </div>
            {error ? <div className="badline" role="alert">{error}</div> : null}
            <div className="plugin-actions">
              <button type="button" className="hob-btn hob-btn-primary" disabled={busy} onClick={() => void submitPaste()}>
                {busy ? <Icon name="spin" size={14} className="spin" /> : null}
                {t("完成登录")}
              </button>
              <button type="button" className="hob-btn plugin-btn-white" disabled={busy} onClick={() => void handleCancel()}>
                {t("取消")}
              </button>
            </div>
            {renderSessionFooter(session, t("正在等待本机回调，或提交上方地址继续…"))}
          </div>
        </section>
      );
    }

    // Manual authorization code paste (code)
    if (session.kind === "code") {
      return (
        <section className="plugin-section">
          <h2>{t("登录账号")}</h2>
          {switcher}
          <div className="plugin-login-card">
            <div className="plugin-login-title">{t("网页授权并粘贴授权码")}</div>
            <div className="plugin-login-desc">
              {session.instructions || t("在浏览器打开登录页完成授权后，把页面给出的授权码粘贴到下方。")}
            </div>
            {session.url ? (
              <div className="plugin-actions">
                <a className="hob-btn plugin-btn-white" href={session.url} target="_blank" rel="noreferrer">
                  {t("打开网页登录")}
                  <Icon name="out" size={14} />
                </a>
              </div>
            ) : null}
            <label className="lbl">
              {t("授权码")}
              <input className="field" value={authCode} onChange={(e) => { setAuthCode(e.target.value); setError(""); }} />
            </label>
            {error ? <div className="badline" role="alert">{error}</div> : null}
            <div className="plugin-actions">
              <button type="button" className="hob-btn hob-btn-primary" disabled={busy} onClick={() => void submitCode()}>
                {t("完成登录")}
              </button>
              <button type="button" className="hob-btn plugin-btn-white" disabled={busy} onClick={() => void handleCancel()}>
                {t("取消")}
              </button>
            </div>
            {renderSessionFooter(session, t("等待提交授权码…"))}
          </div>
        </section>
      );
    }

    // Flow 2: Web login server poll (07b)
    return (
      <section className="plugin-section">
        <h2>{t("登录账号")}</h2>
        {switcher}
        <div className="plugin-login-card">
          <div className="plugin-login-title">{t("在厂商网页完成登录")}</div>
          <div className="plugin-login-desc">
            {t("点击下方按钮打开 {name} 登录页。在网页上确认授权后，页面会停留在厂商提示页，Hob 会自动完成登录，无需复制回调地址。", { name: provider.name })}
          </div>
          {error ? <div className="badline" role="alert">{error}</div> : null}
          <div className="plugin-actions">
            {session.url ? (
              <a className="hob-btn hob-btn-primary" href={session.url} target="_blank" rel="noreferrer">
                {t("打开网页登录")}
                <Icon name="out" size={14} />
              </a>
            ) : null}
            {session.status === "expired" || session.status === "failed" ? (
              <button type="button" className="hob-btn hob-btn-primary" disabled={busy} onClick={() => void beginOAuth(methodIdx)}>
                {t("重新发起")}
              </button>
            ) : null}
            <button type="button" className="hob-btn plugin-btn-white" disabled={busy} onClick={() => void handleCancel()}>
              {t("取消")}
            </button>
          </div>
          {renderSessionFooter(session, t("等待你在网页上完成登录…"))}
        </div>
      </section>
    );
  }

  // Interactive prompt step before OAuth
  if (prompt) {
    return (
      <section className="plugin-section">
        <h2>{t("登录账号")}</h2>
        {switcher}
        <div className="plugin-login-card">
          <div className="plugin-login-title">{localizedMethodLabel(method)}</div>
          <label className="lbl">
            {localizedPromptMessage(prompt)}
            {prompt.type === "select" && prompt.options ? (
              <select className="field" value={promptVal} onChange={(e) => { setPromptVal(e.target.value); setError(""); }}>
                {prompt.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            ) : (
              <input
                className="field"
                value={promptVal}
                placeholder={prompt.placeholder}
                onChange={(e) => { setPromptVal(e.target.value); setError(""); }}
              />
            )}
          </label>
          {error ? <div className="badline" role="alert">{error}</div> : null}
          <div className="plugin-actions">
            <button type="button" className="hob-btn hob-btn-primary" disabled={busy} onClick={() => void submitPromptStep()}>
              {t("继续")}
            </button>
            <button type="button" className="hob-btn plugin-btn-white" disabled={busy} onClick={() => void handleCancel()}>
              {t("取消")}
            </button>
          </div>
        </div>
      </section>
    );
  }

  // Flow 4: API key or Keyless (07d)
  if (method?.type === "api") {
    if (method.keyless) {
      return (
        <section className="plugin-section">
          <h2>{t("登录账号")}</h2>
          {switcher}
          <div className="plugin-login-card">
            <div className="plugin-login-title">{localizedMethodLabel(method)}</div>
            <div className="plugin-login-desc">{t("此供应商支持免登录直接启用，模型会自动加入可用列表。")}</div>
            {error ? <div className="badline" role="alert">{error}</div> : null}
            <div className="plugin-actions">
              <button type="button" className="hob-btn hob-btn-primary" disabled={busy} onClick={() => void submitApiKey()}>
                {busy ? <Icon name="spin" size={14} className="spin" /> : null}
                {t("立即启用")}
              </button>
              <button type="button" className="hob-btn plugin-btn-white" disabled={busy} onClick={() => void handleCancel()}>
                {t("取消")}
              </button>
            </div>
          </div>
        </section>
      );
    }

    return (
      <section className="plugin-section">
        <h2>{t("登录账号")}</h2>
        {switcher}
        <form className="plugin-login-card" onSubmit={(e) => { e.preventDefault(); void submitApiKey(); }}>
          <div className="plugin-login-title">{t("使用 API 密钥登录")}</div>
          <div className="plugin-login-desc">
            {t("输入你的 {name} 密钥。密钥只保存在本机凭据库中，不写入日志，也不会发给模型。", { name: provider.name })}
          </div>
          <label className="lbl">
            {t("API 密钥 *")}
            <div className="plugin-pw">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                placeholder={method.placeholder || "sk-..."}
                autoComplete="off"
                onChange={(e) => { setApiKey(e.target.value); setError(""); }}
              />
              <button
                type="button"
                className="hob-icon-btn"
                title={showKey ? t("隐藏密钥") : t("显示密钥")}
                aria-label={showKey ? t("隐藏密钥") : t("显示密钥")}
                onClick={() => setShowKey((v) => !v)}
              >
                <Icon name={showKey ? "eyeoff" : "eye"} size={16} />
              </button>
            </div>
          </label>
          <label className="lbl">
            {t("账号名称（选填）")}
            <input
              className="field"
              value={accountName}
              placeholder={t("例如：个人编程套餐")}
              onChange={(e) => setAccountName(e.target.value)}
            />
          </label>
          {error ? <div className="badline" role="alert">{error}</div> : null}
          <div className="plugin-actions">
            <button type="submit" className="hob-btn hob-btn-primary" disabled={busy}>
              {busy ? <Icon name="spin" size={14} className="spin" /> : null}
              {t("保存并登录")}
            </button>
            <button type="button" className="hob-btn plugin-btn-white" disabled={busy} onClick={() => void handleCancel()}>
              {t("取消")}
            </button>
          </div>
        </form>
      </section>
    );
  }

  // Default OAuth start screen (before clicking start)
  return (
    <section className="plugin-section">
      <h2>{t("登录账号")}</h2>
      {switcher}
      <div className="plugin-login-card">
        <div className="plugin-login-title">{method ? localizedMethodLabel(method) : t("登录账号")}</div>
        <div className="plugin-login-desc">
          {t("点击下方按钮发起 {name} 登录。完成后即可在「设置 → 服务商」和模型列表中使用。", { name: provider.name })}
          {effectiveCli?.declared && !effectiveCli.installed ? ` ${t("第一次登录会先在运行 Hob 的机器上装好 {name}，要等一会儿。", { name: effectiveCli.name || t("本机客户端") })}` : null}
        </div>
        {error ? <div className="badline" role="alert">{error}</div> : null}
        <div className="plugin-actions">
          <button type="button" className="hob-btn hob-btn-primary" disabled={busy || !method} onClick={() => void beginOAuth(methodIdx)}>
            {busy ? <Icon name="spin" size={14} className="spin" /> : null}
            {t("开始登录")}
          </button>
          <button type="button" className="hob-btn plugin-btn-white" disabled={busy} onClick={() => void handleCancel()}>
            {t("取消")}
          </button>
        </div>
      </div>
    </section>
  );
}

export function PluginProvidersSection({
  pluginId,
  providers: initialProviders,
  host: initialHost,
  toolCount,
  paused,
  onRefreshPlugin,
}: {
  pluginId: string;
  providers: PluginProviderView[];
  host?: ProviderHostStatusView;
  toolCount: number;
  paused?: boolean;
  onRefreshPlugin: () => Promise<void>;
}) {
  const { pluginSignIn, pluginProviderTick } = useApp();
  const [providers, setProviders] = useState<PluginProviderView[]>(initialProviders);
  const [host, setHost] = useState<ProviderHostStatusView | undefined>(initialHost);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [reloginTarget, setReloginTarget] = useState<{ providerId: string; accountId: string } | null>(null);
  const [sessions, setSessions] = useState<Record<string, PluginSignInSessionView>>({});
  const [clis, setClis] = useState<Record<string, PluginCliStatusView>>({});
  const [acctMenu, setAcctMenu] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState("");
  const loadedMeta = useRef(false);

  useEffect(() => {
    setProviders(initialProviders);
    setHost(initialHost);
    const seedSessions: Record<string, PluginSignInSessionView> = {};
    const seedClis: Record<string, PluginCliStatusView> = {};
    for (const p of initialProviders) {
      if (p.signIn) seedSessions[p.providerId] = p.signIn;
      if (p.cli) seedClis[p.providerId] = p.cli;
    }
    if (Object.keys(seedSessions).length) {
      setSessions((prev) => ({ ...seedSessions, ...prev }));
    }
    if (Object.keys(seedClis).length) {
      setClis((prev) => ({ ...seedClis, ...prev }));
    }
  }, [initialProviders, initialHost]);

  // Sync SSE signIn updates from store
  useEffect(() => {
    for (const p of providers) {
      const ev = pluginSignIn[`${pluginId}:${p.providerId}`];
      if (!ev) continue;
      setSessions((prev) => ({ ...prev, [p.providerId]: ev }));
      if (ev.status === "completed") {
        setAddingFor(null);
        setReloginTarget(null);
        void onRefreshPlugin();
      }
    }
  }, [pluginSignIn, pluginId]);

  // Load provider metadata (methods/CLI) once if not yet discovered
  useEffect(() => {
    if (paused || loadedMeta.current) return;
    const needsLoad = initialProviders.length === 0 || initialProviders.some((p) => p.methods.length === 0 && !p.error);
    if (!needsLoad) return;
    loadedMeta.current = true;
    void loadPluginProviders(pluginId, true)
      .then((res) => {
        setProviders(res.providers);
        setHost(res.providerHost);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [pluginId, paused, initialProviders.length]);

  // Poll active waiting sign-in sessions (non-mock)
  useEffect(() => {
    if (MOCK) return;
    const waiting = Object.entries(sessions).filter(([, s]) => s.status === "waiting" || s.status === "pending");
    if (!waiting.length) return;
    const timer = window.setInterval(() => {
      for (const [providerId, s] of waiting) {
        void pollPluginSignIn(pluginId, providerId, s.sessionId)
          .then((next) => {
            setSessions((prev) => ({ ...prev, [providerId]: next }));
            if (next.status === "completed") {
              setAddingFor(null);
              setReloginTarget(null);
              void onRefreshPlugin();
            }
          })
          .catch(() => {});
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [sessions, pluginId]);

  // Close account menu on outside click
  useEffect(() => {
    if (!acctMenu) return;
    const close = () => setAcctMenu(null);
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [acctMenu]);

  // Auto-fetch usage once for active logged-in account when usageSupported & not yet fetched
  const usageFetched = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (paused || MOCK) return;
    for (const p of providers) {
      const active = p.accounts.find((a) => a.active && a.status === "logged_in");
      const key = `${p.providerId}:${active?.id ?? ""}`;
      if (p.usageSupported && active && !p.usage && !usageFetched.current.has(key)) {
        usageFetched.current.add(key);
        void loadPluginProviderUsage(pluginId, p.providerId, active.id)
          .then((usage) => {
            setProviders((list) => list.map((item) => item.providerId === p.providerId ? { ...item, usage } : item));
          })
          .catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            setProviders((list) => list.map((item) => item.providerId === p.providerId ? { ...item, usage: { windows: [], error: msg, fetchedAt: new Date().toISOString() } } : item));
          });
      }
    }
  }, [providers, paused, pluginId, pluginProviderTick]);

  const handleRefreshUsage = async (provider: PluginProviderView) => {
    const active = provider.accounts.find((a) => a.active);
    setBusyKey(`usage:${provider.providerId}`);
    try {
      const usage = await loadPluginProviderUsage(pluginId, provider.providerId, active?.id);
      setProviders((list) => list.map((item) => item.providerId === provider.providerId ? { ...item, usage } : item));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setProviders((list) => list.map((item) => item.providerId === provider.providerId ? { ...item, usage: { windows: [], error: msg, fetchedAt: new Date().toISOString() } } : item));
    } finally {
      setBusyKey(null);
    }
  };

  const handleRefreshModels = async (provider: PluginProviderView) => {
    const active = provider.accounts.find((a) => a.active);
    setBusyKey(`models:${provider.providerId}`);
    try {
      await refreshPluginModels(pluginId, provider.providerId, active?.id);
      await onRefreshPlugin();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await onRefreshPlugin();
    } finally {
      setBusyKey(null);
    }
  };

  const handleSwitchAccount = async (provider: PluginProviderView, accountId: string) => {
    setBusyKey(`acct:${accountId}`);
    setAcctMenu(null);
    try {
      await setPluginActiveAccount(pluginId, provider.providerId, accountId);
      await onRefreshPlugin();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeleteAccount = async (provider: PluginProviderView, account: PluginProviderAccountView) => {
    setAcctMenu(null);
    if (!window.confirm(t("删除账号「{name}」？", { name: account.displayName }))) return;
    setBusyKey(`acct:${account.id}`);
    try {
      await deletePluginAccount(pluginId, provider.providerId, account.id);
      await onRefreshPlugin();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const body = (
    <>
      {error ? <div className="badline" role="alert">{error}</div> : null}
      {providers.map((provider) => {
        const session = sessions[provider.providerId];
        const cli = clis[provider.providerId] ?? provider.cli;
        const showLogin = !paused && (
          Boolean(session && session.status !== "completed" && session.status !== "cancelled")
          || addingFor === provider.providerId
          || reloginTarget?.providerId === provider.providerId
          || provider.accounts.length === 0
        );
        const showAccounts = provider.accounts.length > 0 && !keylessOnly([provider]);

        return (
          <div key={provider.providerId}>
            {showAccounts ? (
              <section className="plugin-section">
                <h2>
                  {t("账号")}
                  <span className="plugin-state">{t("{n} 个", { n: provider.accounts.length })}</span>
                </h2>
                <div className="plugin-list">
                  {provider.accounts.map((account) => {
                    const badge = accountStatusBadge(account.status);
                    const subParts = [
                      account.plan,
                      paused
                        ? t("已保留登录态，确认权限后恢复使用")
                        : account.lastError || account.hint || (account.updatedAt ? t("上次刷新 {time}", { time: fmtWhen(account.updatedAt) }) : ""),
                    ].filter(Boolean);
                    const menuOpen = acctMenu === `${provider.providerId}:${account.id}`;
                    return (
                      <div className="plugin-acct" key={account.id}>
                        <div className="plugin-acct-main">
                          <div className="plugin-acct-name">
                            <span>{account.displayName}</span>
                            {account.active ? <span className="plugin-pill">{t("在用")}</span> : null}
                          </div>
                          {subParts.length ? <div className="plugin-acct-sub">{subParts.join(" · ")}</div> : null}
                        </div>
                        <div className={`plugin-acct-end${!paused && account.status !== "logged_in" ? " needs-action" : ""}`} onPointerDown={(e) => e.stopPropagation()}>
                          {paused ? (
                            <span className="plugin-state disabled"><span className="plugin-state-dot" />{t("已暂停")}</span>
                          ) : (
                            <>
                              <span className={`plugin-state ${badge.cls}`}><span className="plugin-state-dot" />{badge.label}</span>
                              {account.status !== "logged_in" ? (
                                <button
                                  type="button"
                                  className="hob-btn hob-btn-compact plugin-btn-white"
                                  disabled={busyKey === `acct:${account.id}`}
                                  onClick={() => setReloginTarget({ providerId: provider.providerId, accountId: account.id })}
                                >
                                  {t("重新登录")}
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="hob-icon-btn"
                                    aria-label={t("更多")}
                                    aria-expanded={menuOpen}
                                    onClick={() => setAcctMenu(menuOpen ? null : `${provider.providerId}:${account.id}`)}
                                  >
                                    <Icon name="more" size={15} />
                                  </button>
                                  {menuOpen ? (
                                    <div className="amenu plugin-acct-menu" role="menu">
                                      {!account.active ? (
                                        <button type="button" role="menuitem" onClick={() => void handleSwitchAccount(provider, account.id)}>
                                          {t("设为在用")}
                                        </button>
                                      ) : null}
                                      <button type="button" role="menuitem" onClick={() => { setAcctMenu(null); setReloginTarget({ providerId: provider.providerId, accountId: account.id }); }}>
                                        {t("重新登录")}
                                      </button>
                                      <button type="button" role="menuitem" className="danger" onClick={() => void handleDeleteAccount(provider, account)}>
                                        {t("删除账号")}
                                      </button>
                                    </div>
                                  ) : null}
                                </>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {!paused && !provider.single ? (
                    <button
                      type="button"
                      className="plugin-profile-add"
                      onClick={() => { setReloginTarget(null); setAddingFor(provider.providerId); }}
                    >
                      <Icon name="plus" size={14} />
                      {t("添加账号")}
                    </button>
                  ) : null}
                </div>
              </section>
            ) : null}

            {showLogin ? (
              <ProviderSignInCard
                pluginId={pluginId}
                provider={provider}
                session={session}
                cli={cli}
                reloginAccountId={reloginTarget?.providerId === provider.providerId ? reloginTarget.accountId : undefined}
                onSessionChange={(next) => setSessions((prev) => {
                  const copy = { ...prev };
                  if (next) copy[provider.providerId] = next;
                  else delete copy[provider.providerId];
                  return copy;
                })}
                onCliChange={(next) => setClis((prev) => ({ ...prev, [provider.providerId]: next }))}
                onDone={() => {
                  setAddingFor(null);
                  setReloginTarget(null);
                  void onRefreshPlugin();
                }}
                onCancel={() => {
                  setAddingFor(null);
                  setReloginTarget(null);
                }}
              />
            ) : null}

            {!paused ? (
              <ProviderQuotaSection
                provider={provider}
                busy={busyKey === `usage:${provider.providerId}`}
                onRefresh={() => void handleRefreshUsage(provider)}
              />
            ) : null}

            <ProviderModelsSection
              pluginId={pluginId}
              provider={provider}
              onProviders={setProviders}
              onChanged={() => void onRefreshPlugin()}
              busy={busyKey === `models:${provider.providerId}`}
              paused={paused}
              onRefresh={() => void handleRefreshModels(provider)}
            />
          </div>
        );
      })}
    </>
  );

  return (
    <>
      {!paused ? <ProviderStatusStrip providers={providers} host={host} toolCount={toolCount} /> : null}
      {paused ? <div className="plugin-paused">{body}</div> : body}
    </>
  );
}

export { approvePlugin };
