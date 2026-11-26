import { Children, useEffect, useRef, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import { newerPluginVersion } from "../../../shared/plugin-version.ts";
import type { PluginCatalogView, PluginServiceStatus, PluginToolLoginStatus, PluginToolView, PluginView } from "../../../shared/types.ts";
import { Avatar } from "../sprites.tsx";
import { Icon } from "../icons.tsx";
import { MOCK, deletePlugin, deletePluginProfile, disconnectPluginOAuth, loadPluginCatalog, loadPluginLogins, loadPlugins, logoutPluginToolLogin, openPlugins, patchPlugin, pollPluginToolLogin, removePluginLoginAuto, savePluginConfig, savePluginProfileConfig, startPluginOAuth, startPluginToolLogin, updatePlugin, updatePluginProfile, addPluginProfile, useApp } from "../store.ts";
import { Disclosure } from "./Disclosure.tsx";
import { PluginLogins, type LoginData } from "./PluginLogins.tsx";
import { PluginIcon, pluginDescription, pluginName, PluginStatus } from "./Plugins.tsx";
import { approvePlugin, DeviceCodeLoginCard, PluginProvidersSection, PluginUpdateApprovalBanner } from "./PluginProviders.tsx";
import { hasProviderContribution, isUnofficialPlugin, pluginDetailText, pluginReviewedVersion } from "./plugin-meta.ts";

export function InlineLinks({ text }: { text: string }) {
  return <>{text.split(/(\[[^\]]+\]\(https?:\/\/[^)]+\))/g).map((part, index) => {
    const match = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(part);
    return match ? <a key={index} className="link" href={match[2]} target="_blank" rel="noreferrer">{match[1]}</a> : part;
  })}</>;
}

function Description({ text }: { text: string }) {
  return <div className="plugin-sub"><InlineLinks text={text} /></div>;
}

export function ToolPluginLoginRow({
  status,
  toolSummary,
  canStart,
  canLogout,
  busy = false,
  inDeviceFlow = false,
  configButton,
  onStart,
  onLogout,
}: {
  status?: PluginToolLoginStatus;
  toolSummary?: React.ReactNode;
  canStart: boolean;
  canLogout: boolean;
  busy?: boolean;
  inDeviceFlow?: boolean;
  configButton?: React.ReactNode;
  onStart: () => void;
  onLogout: () => void;
}) {
  if (status?.signedIn) {
    const text = status.detail || (status.account ? t("已登录 {account}", { account: status.account }) : t("已登录"));
    return (
      <div className="plugin-connection-top plugin-connection-detail">
        <span><InlineLinks text={text} /></span>
        <span className="sp" />
        {canLogout ? <button type="button" className="hob-btn plugin-btn-white" disabled={busy} onClick={onLogout}>{t("退出登录")}</button> : null}
      </div>
    );
  }
  if (status?.optional) {
    return (
      <div className="plugin-connection-top plugin-connection-detail">
        <span>{status.detail ? <InlineLinks text={status.detail} /> : null}</span>
        <span className="sp" />
        {canStart && !inDeviceFlow ? <button type="button" className="plugin-link-btn" disabled={busy} onClick={onStart}>{status.startLabel || t("登录")}</button> : null}
      </div>
    );
  }
  return (
    <>
      <div className="plugin-connection-top">
        <span className="plugin-state needs_login"><span className="plugin-state-dot" />{t("未登录")}</span>
        {toolSummary}
        <span className="sp" />
        {configButton}
        {canStart && !inDeviceFlow ? <button type="button" className="hob-btn hob-btn-primary" disabled={busy} onClick={onStart}>{t("登录")}</button> : null}
      </div>
      {status?.error && !inDeviceFlow ? <div className="badline" role="alert">{status.error}</div> : null}
    </>
  );
}

interface ToolDeviceFlowState {
  service: string;
  url: string;
  userCode: string;
  expiresAt?: string;
  interval: number;
  status: "waiting" | "failed" | "expired";
  error?: string;
  pollTick: number;
}

/** 文件类配置项：在网页里选一个文件，存它的文本内容（比如 GitHub 下载的私钥）。 */
export function FileField({ configured, onChange }: { configured: boolean; onChange: (text: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 64 * 1024) { setError(t("文件太大了，最多 64 KB")); return; }
    setError("");
    setName(file.name);
    onChange(await file.text());
  };
  return <div className="plugin-file">
    <button type="button" className="hob-btn plugin-btn-white" onClick={() => input.current?.click()}>{configured || name ? t("重新选择文件") : t("选择文件")}</button>
    <span>{name ? t("已选 {name}，保存后生效", { name }) : configured ? t("已上传") : t("还没选文件")}</span>
    <input ref={input} type="file" hidden onChange={(e) => { void pick(e.target.files?.[0]); e.target.value = ""; }} />
    {error ? <span className="badline" role="alert">{error}</span> : null}
  </div>;
}

export function MoreSettings({ initialOpen, children }: { initialOpen: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(initialOpen);
  return <Disclosure className="plugin-more" label={t("选填设置")} count={t("{n} 项", { n: Children.count(children) })} open={open} onToggle={() => setOpen(value => !value)}>{children}</Disclosure>;
}

export function configGroups(config: PluginView["config"], values: Record<string, unknown>) {
  const fields = Object.entries(config);
  const required = fields.filter(([, field]) => field.required);
  const optional = fields.filter(([, field]) => !field.required);
  const optionalHasValue = optional.some(([key, field]) => {
    if (field.sensitive && !(key in values)) return Boolean(field.configured);
    const value = values[key] ?? field.value;
    return value !== undefined && value !== null && value !== "" && (!Array.isArray(value) || value.length > 0);
  });
  return { fields, required, optional, initialOpen: !required.length || optionalHasValue };
}

function fieldMissing(config: PluginView["config"], keys: string[]): string[] {
  return keys.map(key => String(config[key]?.title ?? key));
}

function accountValue(config: Record<string, Record<string, unknown>>): string {
  const entry = Object.values(config).find(field => typeof field.value === "string" && field.value);
  return entry && typeof entry.value === "string" ? entry.value : "";
}

function countTools(item: PluginView) {
  const tools = item.services.flatMap(service => service.tools);
  return { tools, total: tools.length, changed: tools.filter(tool => tool.annotations?.readOnlyHint !== true).length, disabled: tools.filter(tool => !tool.enabled).length };
}

function statusTone(status: PluginServiceStatus): "warn" | "bad" | "ok" {
  if (status === "connected" || status === "idle") return "ok";
  if (status === "error") return "bad";
  return "warn";
}

export function PluginDetail({ id }: { id: string }) {
  const { assistants, pluginProviderTick } = useApp();
  const [item, setItem] = useState<PluginView | null>(null);
  const [catalog, setCatalog] = useState<PluginCatalogView | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [profileId, setProfileId] = useState<string>();
  const [profileName, setProfileName] = useState("");
  const [newProfileName, setNewProfileName] = useState("");
  const [profileError, setProfileError] = useState("");
  const [adding, setAdding] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [toolFilter, setToolFilter] = useState<"all" | "readOnly" | "mutating">("all");
  const [toolsOpen, setToolsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loginData, setLoginData] = useState<LoginData | null>(null);
  const [deviceFlow, setDeviceFlow] = useState<ToolDeviceFlowState | null>(null);

  const refresh = async () => {
    const [view, entries] = await Promise.all([loadPlugins(), loadPluginCatalog()]);
    const found = view.plugins.find(p => p.plugin.id === id);
    if (!found) throw new Error(t("没有这个插件"));
    setItem(found);
    setCatalog(entries);
    setProfileId(current => found.profiles?.some(profile => profile.id === current) ? current : found.profiles?.find(profile => profile.missing.length)?.id ?? found.profiles?.[0]?.id);
    setConfigOpen(current => current || (found.missing.length > 0 && !found.profiles));
  };
  useEffect(() => {
    // 换一个插件时上一个插件的报错一起清掉，不然会挂到别的插件页上
    setItem(null); setValues({}); setProfileId(undefined); setProfileName(""); setConfigOpen(false); setMenuOpen(false); setError(""); setDeviceFlow(null);
    void refresh().catch(e => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);
  useEffect(() => {
    if (!MOCK || !item?.login || item.login.status?.signedIn || deviceFlow) return;
    const scene = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("scene") : null;
    if (scene !== "tool-login-device") return;
    let active = true;
    void startPluginToolLogin(id, item.login.service).then((started) => {
      if (!active || started.kind !== "device_code") return;
      setDeviceFlow({
        service: item.login!.service,
        url: started.url,
        userCode: started.userCode,
        expiresAt: started.expiresAt,
        interval: started.interval ?? 5,
        status: "waiting",
        pollTick: 0,
      });
    }).catch(() => {});
    return () => { active = false; };
  }, [id, item?.login?.service, item?.login?.status?.signedIn]);
  useEffect(() => {
    if (!deviceFlow || deviceFlow.status !== "waiting") return;
    let active = true;
    const delayMs = Math.max(200, deviceFlow.interval * 1000);
    const timer = window.setTimeout(() => {
      if (!active) return;
      if (deviceFlow.expiresAt && Date.parse(deviceFlow.expiresAt) <= Date.now()) {
        setDeviceFlow((cur) => (cur ? { ...cur, status: "expired" } : null));
        return;
      }
      void pollPluginToolLogin(id, deviceFlow.service)
        .then(async (res) => {
          if (!active) return;
          if (res.state === "done") {
            setDeviceFlow(null);
            await refresh();
          } else if (res.state === "error") {
            setDeviceFlow((cur) => (cur ? { ...cur, status: "failed", error: res.message || t("未知错误") } : null));
          } else {
            setDeviceFlow((cur) => (cur ? { ...cur, pollTick: cur.pollTick + 1 } : null));
          }
        })
        .catch((err) => {
          if (!active) return;
          setDeviceFlow((cur) => (cur ? { ...cur, status: "failed", error: err instanceof Error ? err.message : String(err) } : null));
        });
    }, delayMs);
    return () => { active = false; window.clearTimeout(timer); };
  }, [id, deviceFlow?.status, deviceFlow?.pollTick, deviceFlow?.service, deviceFlow?.interval, deviceFlow?.expiresAt]);
  useEffect(() => {
    if (pluginProviderTick > 0) void refresh().catch(() => {});
  }, [pluginProviderTick]);
  useEffect(() => {
    const hasList = Boolean(item?.credentialRoles?.includes("list"));
    const service = hasList ? item?.services.find(candidate => candidate.status === "connected" || candidate.status === "idle")?.name : undefined;
    if (!service) { setLoginData(null); return; }
    let active = true;
    void loadPluginLogins(id, service).then(value => { if (active) setLoginData(value); }).catch(error => { if (active) setError(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [id, item?.credentialRoles?.includes("list"), item?.services.find(candidate => candidate.status === "connected" || candidate.status === "idle")?.name]);
  useEffect(() => {
    const profile = item?.profiles?.find(candidate => candidate.id === profileId);
    if (profile) setProfileName(profile.name);
  }, [item, profileId]);
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { setError(""); setProfileError(""); await action(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  if (!item) return <div className="plugin-content"><div className="badline">{error}</div></div>;

  const hasList = item.credentialRoles?.includes("list") ?? false;
  const credentialConnected = hasList && loginData !== null;
  const extensions = item.manifest.extensions as Record<string, unknown> | undefined;
  const hob = extensions?.["com.hob.plugins"] as Record<string, unknown> | undefined;
  const profileSpec = hob?.profiles as Record<string, unknown> | undefined;
  const profile = item.profiles?.find(candidate => candidate.id === profileId);
  const profileMode = Array.isArray(item.profiles);
  const showAdd = profileMode && (adding || !item.profiles?.length);
  const profileTitle = typeof profileSpec?.title === "string" && profileSpec.title ? profileSpec.title : t("配置");
  const activeConfig = profile?.config ?? item.config;
  const { fields, required, optional, initialOpen } = configGroups(activeConfig, values);
  const missingKeys = fields.filter(([key, field]) => {
    const value = values[key] ?? (field.sensitive ? (field.configured ? true : "") : field.value);
    return field.required && (value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length));
  }).map(([key]) => key);
  const missing = fieldMissing(activeConfig, missingKeys);
  const profileMissing = profileMode ? [...new Set(item.profiles?.flatMap(candidate => candidate.missing) ?? [])] : [];
  const service = item.services[0];
  const serviceStatus = profileMissing.length && profileMode ? "pending_config" : service?.status ?? "connected";
  const tools = countTools(item);
  const visibleTools = tools.tools.filter(tool => toolFilter === "all" || (toolFilter === "readOnly" ? tool.annotations?.readOnlyHint === true : tool.annotations?.readOnlyHint !== true));
  const firstTools = visibleTools.slice(0, 6);
  const restTools = visibleTools.slice(6);
  const hasAnnotations = tools.tools.some(tool => tool.annotations !== undefined);
  const toolErrors = item.services.flatMap(serviceItem => serviceItem.toolErrors ?? []);
  const latest = catalog?.plugins.find(p => p.id === id && p.source === item.plugin.source && !p.error);
  const source = catalog?.sources?.find(source => source.id === item.plugin.source);
  const origin = item.plugin.source === "custom" ? t("自定义") : item.plugin.source === "builtin" ? t("Hob 自带") : item.plugin.source === "official" ? t("Hob 官方") : source?.name ?? t("{name}（已移除）", { name: item.plugin.sourceName ?? item.plugin.source });
  const name = pluginName(item.manifest, id);
  const publisher = typeof hob?.publisher === "string" ? hob.publisher : "";
  const hasProviders = hasProviderContribution(item.manifest, Boolean(item.providers?.length));
  const unofficial = isUnofficialPlugin(item.manifest, Boolean(item.providers?.length));
  const reviewed = pluginReviewedVersion(item.manifest, item.plugin.version);
  const subtitle = item.plugin.source === "builtin" && hasList
    ? t("Hob 自带 · 存在这台机器上，加密保存")
    : unofficial
      ? t("非官方 · 社区维护 · 我们审过的版本 {version}", { version: reviewed })
      : [publisher, origin, t("版本 {version}", { version: item.plugin.version })].filter(Boolean).join(" · ");
  const detailDesc = pluginDetailText(item.manifest, pluginDescription(item.manifest, id));
  const configFields = fields.length > 0 && !profileMode;
  const missingProfile = item.profiles?.find(candidate => candidate.missing.length);
  const missingProfileLabels = missingProfile ? fieldMissing(item.config, missingProfile.missing) : [];
  const missingText = missingProfile
    ? t("「{name}」还差：{fields}。填好保存后自动连接。", { name: missingProfile.name, fields: missingProfileLabels.join("、") })
    : missing.length ? t("还差：{fields}。填好保存后自动连接。", { fields: missing.join("、") }) : "";

  const save = async () => {
    const next = Object.fromEntries(Object.entries(values).filter(([key, value]) => !(activeConfig[key]?.sensitive && value === "")));
    if (profile) {
      if (Object.keys(next).length) await savePluginProfileConfig(id, profile.id, next);
      if (profileName.trim() !== profile.name) await updatePluginProfile(id, profile.id, profileName);
    } else if (Object.keys(next).length) await savePluginConfig(id, next);
    setValues({});
  };
  const connect = (serviceName: string) => {
    const popup = window.open("", "_blank");
    if (!popup) { setError(t("浏览器阻止了登录窗口")); return; }
    void run(async () => {
      try {
        await save();
        const result = await startPluginOAuth(id, serviceName);
        if (result.authorizationUrl) {
          popup.location.href = result.authorizationUrl;
          const timer = window.setInterval(() => { if (popup.closed) { window.clearInterval(timer); void refresh().catch(e => setError(e instanceof Error ? e.message : String(e))); } }, 500);
        } else popup.close();
      } catch (e) { popup.close(); throw e; }
    });
  };
  const selected = item.plugin.assistants ?? assistants.map(a => a.id);
  const addProfile = () => {
    const next = newProfileName.trim();
    if (!next) { setProfileError(t("名称不能为空")); return; }
    void run(async () => {
      const view = await addPluginProfile(id, next);
      setNewProfileName(""); setAdding(false); setValues({});
      setProfileId(view.profiles?.find(candidate => candidate.name === next)?.id);
    });
  };
  const removeProfile = (candidate: NonNullable<PluginView["profiles"]>[number]) => {
    if (window.confirm(t("删除这个{title}？会删掉它的配置和密码。", { title: profileTitle }))) void run(() => deletePluginProfile(id, candidate.id));
  };
  const renderField = ([key, field]: typeof fields[number]) => {
    const value = values[key] ?? (field.sensitive ? "" : field.value ?? "");
    const label = String(field.title ?? key);
    if (field.type === "boolean") {
      return <div className="lbl plugin-bool" key={key}>
        <div className="plugin-bool-row"><span>{label}</span><button type="button" role="switch" aria-label={label} aria-checked={Boolean(value)} className={`tog${value ? "" : " off"}`} onClick={() => setValues({ ...values, [key]: !value })} /></div>
        {typeof field.description === "string" && <Description text={field.description} />}
      </div>;
    }
    return <label className="lbl" key={key}>{label}{field.required ? " *" : ""}
      {field.type === "file" ? <FileField configured={Boolean(field.configured || field.value)} onChange={text => setValues({ ...values, [key]: text })} /> : Array.isArray(field.options) ? <select className="field" value={String(value)} onChange={e => setValues({ ...values, [key]: field.type === "number" ? Number(e.target.value) : e.target.value })}><option value="">{t("请选择")}</option>{field.options.map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}</select> : <input className="field" type={field.sensitive ? "password" : field.type === "number" ? "number" : "text"} min={typeof field.min === "number" ? field.min : undefined} max={typeof field.max === "number" ? field.max : undefined} placeholder={field.sensitive && field.configured ? t("已填，留空不改") : undefined} value={String(value)} onChange={e => setValues({ ...values, [key]: field.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value })} />}
      {typeof field.description === "string" && <Description text={field.description} />}</label>;
  };
  const serviceOAuth = item.services.filter(candidate => candidate.oauth?.declared);
  const toolLogin = item.login;
  const toolLoginReady = Boolean(toolLogin) && (serviceStatus === "connected" || serviceStatus === "idle");
  const toolLoginSignedIn = toolLogin?.status?.signedIn === true || toolLogin?.status?.optional === true;
  const effectiveTone = toolLoginReady && !toolLoginSignedIn ? "warn" : statusTone(serviceStatus);
  const handleStartToolLogin = async () => {
    if (!toolLogin) return;
    setBusy(true);
    setError("");
    try {
      const started = await startPluginToolLogin(id, toolLogin.service);
      if (started.kind === "done") {
        setDeviceFlow(null);
        await refresh();
      } else {
        setDeviceFlow({
          service: toolLogin.service,
          url: started.url,
          userCode: started.userCode,
          expiresAt: started.expiresAt,
          interval: started.interval ?? 5,
          status: "waiting",
          pollTick: 0,
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const handleLogoutToolLogin = async () => {
    if (!toolLogin) return;
    await run(async () => {
      setDeviceFlow(null);
      await logoutPluginToolLogin(id, toolLogin.service);
    });
  };
  const toolSummary = tools.total > 0 ? <span className="plugin-connection-tools">{t("{n} 个工具", { n: tools.total })}{tools.disabled ? `，${t("{n} 个已关", { n: tools.disabled })}` : ""}</span> : null;
  const configButton = configFields ? <button className="hob-icon-btn" title={t("修改配置")} aria-label={t("修改配置")} onClick={() => setConfigOpen(value => !value)}><Icon name="edit" size={16} /></button> : null;
  const statusBlock = serviceStatus === "connected" || serviceStatus === "idle" ? <div className="plugin-connection-top"><PluginStatus status={serviceStatus} />{toolSummary}<span className="sp" />{configButton}</div>
    : <div className="plugin-connection-top"><PluginStatus status={serviceStatus} /><span className="sp" />{serviceStatus === "error" ? <button className="hob-icon-btn plugin-retry" title={t("重试")} aria-label={t("重试")} onClick={() => void refresh()}><Icon name="retry" size={16} /></button> : serviceOAuth.length ? <button className="hob-btn hob-btn-primary" disabled={busy || missing.length > 0} onClick={() => connect(serviceOAuth[0]!.name)}>{serviceStatus === "needs_relogin" ? t("重新连接") : serviceStatus === "needs_login" ? t("登录") : t("连接")}</button> : null}</div>;

  const assistantSection = <section className="plugin-section"><h2>{t("给哪些助手用")} <span className="plugin-state">{chosenSummary(assistants.filter(a => selected.includes(a.id)).map(a => a.name), assistants.length)}</span></h2><div className="plugin-assistants">{assistants.map(a => <button type="button" role="switch" aria-label={a.name} aria-checked={selected.includes(a.id)} className={`plugin-assistant${selected.includes(a.id) ? " selected" : ""}`} key={a.id} title={a.name} onClick={() => { const next = selected.includes(a.id) ? selected.filter(value => value !== a.id) : [...selected, a.id]; void run(() => patchPlugin(id, { assistants: next })); }}><Avatar sprite={a.sprite ?? "hob"} prop={a.prop} size={40} />{selected.includes(a.id) ? <span className="avatar-check"><Icon name="check" size={11} /></span> : null}</button>)}</div></section>;

  return <div className="plugin-content">
    <div className="plugin-identity">
      <PluginIcon name={name} id={id} manifest={item.manifest} />
      <div className="plugin-identity-text"><div className="plugin-title">{name}</div><div className="plugin-sub">{subtitle}</div></div>
      <div className="plugin-identity-menu"><button className="hob-icon-btn" title={t("更多")} aria-label={t("更多")} onClick={() => setMenuOpen(value => !value)}><Icon name="more" size={17} /></button>{menuOpen ? <div className="plugin-menu">{!item.plugin.needsApproval ? <button onClick={() => void run(() => patchPlugin(id, { enabled: !item.plugin.enabled }))}>{item.plugin.enabled ? t("停用") : t("启用")}</button> : null}{latest && newerPluginVersion(latest.version, item.plugin.version) ? <button onClick={() => void run(() => updatePlugin(id))}>{t("更新")}</button> : null}<button onClick={() => { if (window.confirm(t("卸载插件「{name}」？", { name }))) void deletePlugin(id).then(() => openPlugins()).catch(e => setError(e instanceof Error ? e.message : String(e))); }}>{t("卸载插件")}</button></div> : null}</div>
    </div>
    <Description text={detailDesc} />
    {error && <div className="badline" role="alert">{error}</div>}

    {item.plugin.needsApproval ? (
      <PluginUpdateApprovalBanner
        item={item}
        busy={busy}
        onApprove={() => void run(() => approvePlugin(id))}
        onKeepDisabled={() => void run(() => patchPlugin(id, { enabled: false }))}
      />
    ) : null}

    {!credentialConnected && (!hasProviders || (item.services.length > 0 && serviceStatus !== "connected" && serviceStatus !== "idle")) ? <section className={`plugin-connection ${effectiveTone}`}>
      {toolLoginReady && toolLogin && !toolLoginSignedIn ? (
        <ToolPluginLoginRow
          status={toolLogin.status}
          toolSummary={toolSummary}
          canStart={toolLogin.roles.includes("start")}
          canLogout={toolLogin.roles.includes("logout")}
          busy={busy}
          inDeviceFlow={Boolean(deviceFlow)}
          configButton={configButton}
          onStart={() => void handleStartToolLogin()}
          onLogout={() => void handleLogoutToolLogin()}
        />
      ) : (
        <>
          {statusBlock}
          {serviceStatus === "pending_config" ? <div className="plugin-connection-detail">{missingText || t("请填写配置后保存，服务会自动连接。")} </div> : null}
          {serviceStatus === "needs_login" || serviceStatus === "needs_relogin" ? <div className="plugin-connection-detail">{service?.error ?? t("完成登录后，助手才能使用这个插件。")}</div> : null}
          {serviceStatus === "error" ? <><div className="plugin-connection-detail">{t("服务返回的原话：")}</div><div className="plugin-connection-error">{service?.error ?? t("没有返回具体原因")}</div></> : null}
          {toolLoginReady && toolLogin && toolLoginSignedIn ? (
            <ToolPluginLoginRow
              status={toolLogin.status}
              canStart={toolLogin.roles.includes("start")}
              canLogout={toolLogin.roles.includes("logout")}
              busy={busy}
              onStart={() => void handleStartToolLogin()}
              onLogout={() => void handleLogoutToolLogin()}
            />
          ) : null}
        </>
      )}
      {configFields && configOpen ? <div className="plugin-config-form">
        {required.map(renderField)}
        {optional.length > 0 && <MoreSettings key={`${id}:single`} initialOpen={initialOpen}>{optional.map(renderField)}</MoreSettings>}
        <div className="plugin-actions"><button className="hob-btn hob-btn-primary" disabled={busy} onClick={() => void run(save)}>{t("保存")}</button></div>
      </div> : null}
    </section> : null}

    {deviceFlow ? (
      <section className="plugin-section">
        <h2>{t("登录账号")}</h2>
        <DeviceCodeLoginCard
          userCode={deviceFlow.userCode}
          url={deviceFlow.url}
          expiresAt={deviceFlow.expiresAt}
          status={deviceFlow.status}
          error={deviceFlow.error}
          busy={busy}
          verbatimError
          onRestart={() => void handleStartToolLogin()}
          onCancel={() => setDeviceFlow(null)}
        />
      </section>
    ) : null}

    {hasProviders ? (
      <PluginProvidersSection
        pluginId={id}
        providers={item.providers ?? []}
        host={item.providerHost}
        toolCount={tools.total}
        paused={Boolean(item.plugin.needsApproval || !item.plugin.enabled)}
        onRefreshPlugin={refresh}
      />
    ) : null}

    {loginData ? <PluginLogins id={id} data={loginData} canSave={item.credentialRoles?.includes("save") ?? false} canDelete={item.credentialRoles?.includes("delete") ?? false} browse={item.plugin.source === "builtin"} reload={async () => { const value = await loadPluginLogins(id, loginData.service); setLoginData(value); }} /> : null}

    {item.autoLogins?.length ? <section className="plugin-section"><h2>{t("自动填写的网站")} <span className="plugin-state">{t("不用每次批准")}</span></h2><div className="plugin-list">{item.autoLogins.map((entry) => (
      <div className="plugin-tool" key={`${entry.host}:${entry.username}`}>
        <div className="tool-info"><div className="tool-name">{entry.host}</div><div className="tool-desc">{entry.username}</div></div>
        <button className="plugin-link" disabled={busy} onClick={() => void run(() => removePluginLoginAuto(id, entry.host, entry.username))}>{t("改成每次问")}</button>
      </div>
    ))}</div></section> : null}

    {profileMode ? <section className="plugin-section"><h2>{profileTitle} <span className="plugin-state">{t("{n} 个", { n: item.profiles?.length ?? 0 })}</span></h2>
      <div className="plugin-profile-list">
        {item.profiles?.map(candidate => <div key={candidate.id}>
          <Disclosure className="plugin-profile-disclosure" label={<span className="profile-info"><span className="profile-name">{candidate.name}</span><span className="profile-account">{accountValue(candidate.config)}</span></span>} count={candidate.missing.length ? <span className="profile-status plugin-state pending_config"><span className="plugin-state-dot" />{t("待配置")}</span> : undefined} open={!showAdd && candidate.id === profileId} onToggle={() => { setProfileId(candidate.id); setValues({}); setAdding(false); setProfileError(""); }}>
            <div className="plugin-profile-form">
              <label className="lbl">{t("名称")}<input className="field" value={profileName} onChange={event => setProfileName(event.target.value)} /></label>
              {required.map(renderField)}
              {optional.length > 0 && <MoreSettings key={`${id}:${candidate.id}`} initialOpen={initialOpen}>{optional.map(renderField)}</MoreSettings>}
              <div className="plugin-actions"><button className="hob-btn hob-btn-primary" disabled={busy} onClick={() => void run(save)}>{t("保存")}</button><button className="hob-btn" disabled={busy} onClick={() => removeProfile(candidate)}>{t("删除{title}", { title: profileTitle })}</button></div>
            </div>
          </Disclosure>
        </div>)}
        {showAdd ? <form className="plugin-profile-form" onSubmit={event => { event.preventDefault(); addProfile(); }}><label className="lbl">{t("名称")}<input className="field" autoFocus value={newProfileName} onChange={event => { setNewProfileName(event.target.value); setProfileError(""); }} placeholder={t("给这个{title}起个名字", { title: profileTitle })} /></label><div className="plugin-actions"><button className="hob-btn hob-btn-primary" disabled={busy}>{t("添加")}</button>{item.profiles?.length ? <button type="button" className="hob-btn" onClick={() => setAdding(false)}>{t("取消")}</button> : null}</div></form> : <button className="plugin-profile-add" type="button" onClick={() => { setAdding(true); setProfileError(""); }}><Icon name="plus" size={14} />{t("添加{title}", { title: profileTitle })}</button>}
      </div>
      {profileError && <div className="badline" role="alert">{profileError}</div>}
    </section> : null}

    {hasList ? assistantSection : null}
    {tools.total > 0 ? <section className="plugin-section"><div className="plugin-tools-head"><h2>{t("工具")} <span className="plugin-state">{t("{n} 个 · {changed} 个会改动", { n: tools.total, changed: tools.changed })}</span></h2>
      {hasAnnotations ? <div className="plugin-filter" role="tablist">{([ ["all", t("全部")], ["readOnly", t("只读")], ["mutating", t("会改动")] ] as const).map(([key, label]) => <button key={key} className={toolFilter === key ? "on" : ""} role="tab" aria-selected={toolFilter === key} onClick={() => { setToolFilter(key); setToolsOpen(false); }}>{label}</button>)}</div> : null}
    </div>
      <div className="plugin-list">
        {firstTools.map(tool => <ToolRow key={tool.toolName} tool={tool} annotated={hasAnnotations} item={item} run={run} />)}
        {restTools.length ? <Disclosure className="plugin-tool-more" label={t("其余工具")} count={restTools.length} open={toolsOpen} onToggle={() => setToolsOpen(value => !value)}>{restTools.map(tool => <ToolRow key={tool.toolName} tool={tool} annotated={hasAnnotations} item={item} run={run} />)}</Disclosure> : null}
      </div>
      {toolErrors.map(toolError => <div className="plugin-tool-error" key={`${toolError.name}:${toolError.reason}`}>{toolError.name}: {toolError.reason}</div>)}
    </section> : toolErrors.length ? <div className="plugin-tool-errors">{toolErrors.map(toolError => <div className="plugin-tool-error" key={`${toolError.name}:${toolError.reason}`}>{toolError.name}: {toolError.reason}</div>)}</div> : null}

    {!hasList && (!hasProviders || tools.total > 0) ? assistantSection : null}
    {!!item.skills?.length && <section className="plugin-section"><h2>{t("技能")}</h2><div className="plugin-list">{item.skills.map(skill => <div className="plugin-tool" key={skill}>{skill}</div>)}</div></section>}
  </div>;
}

/** 选了几个助手：全选写「全部助手」，三个以内写名字，再多写个数。 */
function chosenSummary(names: string[], total: number): string {
  if (total > 0 && names.length === total) return t("全部助手");
  return names.length <= 3 ? names.join("、") : t("{n} 个助手", { n: names.length });
}

function ToolRow({ tool, annotated, item, run }: { tool: PluginToolView; annotated: boolean; item: PluginView; run: (action: () => Promise<unknown>) => Promise<void> }) {
  return <div className="plugin-tool"><div className="tool-info"><div className="tool-name"><code>{tool.name}</code></div><div className="tool-desc">{tool.description}</div></div>{annotated && tool.annotations?.readOnlyHint !== true ? <span className="kind">{t("会改动")}</span> : null}<button type="button" role="switch" className={`tog${tool.enabled ? "" : " off"}`} aria-label={tool.name} aria-checked={tool.enabled} onClick={() => void run(() => patchPlugin(item.plugin.id, { tools: { ...item.plugin.tools, [tool.name]: { ...item.plugin.tools[tool.name], enabled: !tool.enabled } } }))} /></div>;
}
