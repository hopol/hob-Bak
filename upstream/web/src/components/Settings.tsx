// 设置整页：桌面左侧分栏导航 + 右侧内容，手机先列表再进入。
import { Select } from "./Select.tsx";
import { DelayedText, Empty } from "./Empty.tsx";
import { SaveMessage, useSaveMessage } from "./SaveMessage.tsx";
import { Fragment, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMenu } from "./use-menu.ts";
import type {
  AboutInfo,
  ClaudeCodeSettings,
  ClaudeCodeView,
  DesktopView,
  EmbeddingSettings,
  ImageKeyView,
  ImageSettings,
  LoreTestResult,
  MemoryConfig,
  MemoryProvider,
  ModelInfo,
  ModelThinkingView,
  ModelsView,
  PluginProviderSummary,
  ProviderApi,
  ProviderImportItem,
  ProviderImportView,
  ProviderModelSetting,
  ProviderSettings,
  ProviderView,
  ProvidersView,
  PushView,
  RosterEntry,
  Rule,
  SettingsFile,
  SettingsPatch,
  ThinkingLevel,
} from "../../../shared/types.ts";
import {
  DEFAULT_OPENAI_SEARCH_BASE_URL,
  DEFAULT_OPENAI_SEARCH_MODEL,
  type SearchProviderName,
  type SearchProviderSetting,
  type SearchProviderView,
  type SearchView,
} from "../../../shared/search.ts";
import type { Palette } from "../palette.ts";
import type { SkillImportSource, SkillImportView, SkillsView, SkillView } from "../../../shared/skills.ts";
import { Markdown } from "./Markdown.tsx";
import { Disclosure } from "./Disclosure.tsx";
import { ModelParamsEditor, ThinkingLevels } from "./ModelParams.tsx";
const DesktopScreen = lazy(() => import("./DesktopView.tsx").then((module) => ({ default: module.DesktopView })) );
import { SCORE_STAGES, contextText, guessModelScores, scoreLabel, scoreSummary } from "../../../shared/model-note.ts";
import { currentLocale, t } from "../../../shared/i18n.ts";
import { thinkingText } from "../../../shared/thinking.ts";
import { Icon, type IconName } from "../icons.tsx";
import { BrandIcon, brandForRef, modelBrand, providerBrand } from "../brand-icons.tsx";
import { filterModels, fitThinking, groupByProvider, thinkingLevels } from "../model-list.ts";
import { currentSubscription, pushSupported } from "../push.ts";
import { fmtWhen } from "../util.ts";
import { skillOriginText } from "../skill-origin.ts";
import {
  changePassword,
  closeSettings,
  connectPush,
  discoverModels,
  disconnectPush,
  fileUrl,
  getState,
  loadAbout,
  loadClaude,
  saveClaude,
  loadImageKey,
  loadEmbeddingKey,
  saveEmbedding,
  testEmbedding,
  loadSearch,
  loadRules,
  saveRules,
  loadSkills,
  loadSkillImports,
  importSelectedSkills,
  deleteSkill,
  rollbackGeneralSkill,
  loadDesktop,
  saveDesktop,
  testDesktop,
  saveSearch,
  testSearch,
  loadModels,
  loadMemory,
  loadProviders,
  loadLoreImport,
  loadProviderImports,
  loadPush,
  importLore,
  importProviders,
  MOCK,
  openJobs,
  openPlugins,
  removeProvider,
  removePushDevice,
  saveImage,
  saveMemoryLore,
  saveMemoryProvider,
  saveProvider,
  saveSettings,
  sendTestPush,
  setLocale,
  setPalette,
  setSection,
  openSub,
  closeSub,
  testImage,
  testMemoryLore,
  testProviderConnection,
  useApp,
  type SettingsSection,
  type Theme,
} from "../store.ts";
import { PageHead, Group, PalettePicker, Seg, LinkRow, SetNavHead, UpdateDot, availableVersion } from "./SettingsParts.tsx";
import { UsageSection } from "./Usage.tsx";

/** 保存行的提示：成功和失败跟按钮同一行，各页一个样子。 */
/** 保存行。lead 放在最左边（测试连接这类），和保存按钮同一行。 */
function SaveRow({
  saved,
  error,
  children,
  lead,
}: {
  saved: boolean;
  error: string | null;
  children: ReactNode;
  lead?: ReactNode;
}) {
  return (
    <div className="sfoot">
      {lead}
      {saved && !error ? <span className="okline">{t("已保存")}</span> : null}
      {error ? <span className="badline">{error}</span> : null}
      <span className="sp" />
      {children}
    </div>
  );
}

function useSaveFeedback() {
  const [message, setMessage] = useSaveMessage();
  const [busy, setBusy] = useState(false);
  const save = async (patch: SettingsPatch | ((settings: SettingsFile["settings"]) => SettingsPatch)) => {
    setBusy(true);
    const ok = await saveSettings(patch);
    setBusy(false);
    setMessage(ok ? t("已保存") : getState().notice ?? t("保存失败，请重试。"));
    return ok;
  };
  return { save, busy, message };
}

/** toast：整页级的保存提示浮在右上角，出现和消失都不把页面内容顶下去。 */
function SaveFeedback({ message, toast = false }: { message: string | null; toast?: boolean }) {
  return message ? <SaveMessage message={message} toast={toast} /> : null;
}

function AutoField({ value, placeholder, multiline, onSave }: { value: string; placeholder?: string; multiline?: boolean; onSave: (value: string) => Promise<boolean> }) {
  const [text, setText] = useState(value);
  const [busy, setBusy] = useState(false);
  useEffect(() => setText(value), [value]);
  const commit = async () => {
    if (busy || text === value) return;
    setBusy(true);
    const ok = await onSave(text);
    setBusy(false);
    if (!ok) setText(value);
  };
  const props = { value: text, placeholder, disabled: busy, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setText(e.target.value), onBlur: () => void commit(), onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.currentTarget.blur(); } } };
  return <div className="field">{multiline ? <textarea {...props} rows={3} /> : <input {...props} />}</div>;
}

const SECTION_GROUPS: { id: "basics" | "capabilities" | "workspace" | "usage"; items: SettingsSection[] }[] = [
  { id: "basics", items: ["general", "rules", "push"] },
  { id: "capabilities", items: ["providers", "models", "memory", "image", "knowledge", "search"] },
  { id: "workspace", items: ["skills", "desktop", "work"] },
  { id: "usage", items: ["usage", "about"] },
];

function sectionGroupLabel(id: (typeof SECTION_GROUPS)[number]["id"]): string {
  switch (id) {
    case "basics": return t("基础");
    case "capabilities": return t("模型与能力");
    case "workspace": return t("工作空间");
    case "usage": return t("用量与关于");
  }
}

function sectionLabel(id: SettingsSection): string {
  switch (id) {
    case "general": return t("通用设置");
    case "rules": return t("规则");
    case "providers": return t("服务商");
    case "models": return t("模型");
    case "memory": return t("记忆");
    case "image": return t("图像生成");
    case "knowledge": return t("知识库");
    case "search": return t("联网搜索");
    case "skills": return t("技能");
    case "desktop": return t("云桌面");
    case "work": return t("任务");
    case "usage": return t("消耗");
    case "push": return t("通知");
    case "about": return t("关于");
  }
}

function sectionIcon(id: SettingsSection): IconName {
  switch (id) {
    case "general": return "gear";
    case "rules": return "rule";
    case "push": return "bell";
    case "providers": return "server";
    case "models": return "layers";
    case "memory": return "mem";
    case "image": return "image";
    case "knowledge": return "archive";
    case "search": return "globe";
    case "skills": return "book";
    case "desktop": return "monitor";
    case "work": return "tasks";
    case "usage": return "chart";
    case "about": return "info";
  }
}

function sectionGroups(): { id: string; label: string; items: { id: SettingsSection; label: string; icon: IconName }[] }[] {
  return SECTION_GROUPS.map((group) => ({
    id: group.id,
    label: sectionGroupLabel(group.id),
    items: group.items.map((id) => ({ id, label: sectionLabel(id), icon: sectionIcon(id) })),
  }));
}

function themeItems(): { key: Theme; label: string }[] {
  return [
    { key: "system", label: t("跟随系统") },
    { key: "light", label: t("浅色") },
    { key: "dark", label: t("深色") },
  ];
}

/**
 * 配色的中文名：放在这里而不是 shared/theme.ts，页面照常用 t() 翻。
 * 顺序和 shared/theme.ts 的 PALETTE_IDS 一致。
 */
function paletteItems(): { key: Palette; label: string }[] {
  return [
    { key: "default", label: t("默认") },
    { key: "ocean", label: t("海盐") },
    { key: "forest", label: t("森林") },
    { key: "dusk", label: t("暮紫") },
    { key: "rose", label: t("玫瑰") },
  ];
}

function timezones(): string[] {
  const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
  return list ?? [];
}

function maskProxy(value: string): string {
  if (!value) return "";
  try {
    const parsed = new URL(value);
    if (!parsed.username && !parsed.password) return value;
    parsed.username = parsed.username ? "***" : "";
    parsed.password = parsed.password ? "***" : "";
    return parsed.toString();
  } catch {
    return value;
  }
}

export function SettingsPage({ narrow, leaving }: { narrow: boolean; leaving: boolean }) {
  const s = useApp();
  const groups = sectionGroups();
  const sections = groups.flatMap((group) => group.items);
  const current = s.section ?? (narrow ? null : "general");
  const updateVersion = availableVersion(s.update);
  // 换分栏、进出子页都从顶上看起
  const main = useRef<HTMLDivElement>(null);
  useEffect(() => {
    main.current?.scrollTo(0, 0);
  }, [current, s.sub]);

  if (narrow && current === null) {
    return (
      <div className={`setpage settings-page narrow${leaving ? " leaving" : ""}`}>
        <div className="sethead">
          <button type="button" className="hob-icon-btn" title={t("返回")} onClick={closeSettings}>
            <Icon name="left" size={17} />
          </button>
          <span className="t">{t("设置")}</span>
        </div>
        <div className="setbody">
          {groups.map((group) => (
            <section className="set-mgroup" key={group.id}>
              <div className="set-mgroup-title">{group.label}</div>
              <div className="set-mgroup-card">
                {group.items.map((item) => (
                  <button type="button" className="setitem" key={item.id} onClick={() => setSection(item.id)}>
                    <Icon name={item.icon} size={16} className="setitem-ic" />
                    <span className="setitem-label">
                      {item.label}
                      {item.id === "about" && updateVersion ? <UpdateDot version={updateVersion} /> : null}
                    </span>
                    <Icon name="chev" size={15} className="setitem-chev" />
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`setpage settings-page${narrow ? " narrow" : ""}${leaving ? " leaving" : ""}`}>
      {narrow ? (
        <div className="sethead">
          <button type="button" className="hob-icon-btn" title={t("返回")} onClick={s.sub ? closeSub : () => setSection(null)}>
            <Icon name="left" size={17} />
          </button>
          <span className="t">{s.sub?.title ?? sections.find((item) => item.id === current)?.label ?? t("设置")}</span>
        </div>
      ) : (
        <nav className="setnav" aria-label={t("设置")}>
          <SetNavHead title={t("设置")} onBack={closeSettings} />
          <div className="setnav-scroll">
            {groups.map((group) => (
              <div className="setnav-group" key={group.id}>
                <div className="setnav-group-title">{group.label}</div>
                <div className="setnav-group-list">
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      className={`navrow${current === item.id ? " sel" : ""}`}
                      aria-current={current === item.id ? "page" : undefined}
                      onClick={() => setSection(item.id)}
                    >
                      <Icon name={item.icon} size={16} className="navrow-ic" />
                      <span className="navrow-label">
                        {item.label}
                        {item.id === "about" && updateVersion ? <UpdateDot version={updateVersion} /> : null}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </nav>
      )}
      <div className="setmain" ref={main}>
        {current === "rules" ? (
          <RulesSection />
        ) : current === "providers" ? (
          <ProvidersSection />
        ) : current === "models" ? (
          <ModelsSection />
        ) : current === "memory" ? (
          <MemorySection />
        ) : current === "image" ? (
          <ImageSection />
        ) : current === "knowledge" ? (
          <KnowledgeSection />
        ) : current === "search" ? (
          <SearchSection />
        ) : current === "skills" ? (
          <SkillsSection />
        ) : current === "desktop" ? (
          <DesktopSection />
        ) : current === "work" ? (
          <WorkSection />
        ) : current === "usage" ? (
          <UsageSection />
        ) : current === "push" ? (
          <PushSection />
        ) : current === "about" ? (
          <AboutSection />
        ) : (
          <GeneralSection />
        )}
      </div>
    </div>
  );
}

function RulesSection() {
  const { rules, error, busy } = useApp().globalRules;
  useEffect(() => { void loadRules(); }, []);

  const change = (next: { id?: string; text: string; mode: Rule["mode"] }[]) => saveRules(next);
  return <>
    <PageHead title={t("全局规则")} desc={t("所有助手和任务都遵守的规则。「执行前确认」的规则，助手执行前会征求你的确认；「一律照做」表示无需确认即可执行。每个助手自己的规则在其档案中修改。")} />
    {error ? <div className="badline" role="status">{error}</div> : null}
    {rules === null ? error ? <button className="hob-btn" onClick={() => void loadRules()}>{t("重试")}</button> : <Empty><DelayedText text={t("正在读取全局规则…")} /></Empty> :
      ([{ mode: "ask", label: t("执行前确认") }, { mode: "allow", label: t("一律照做") }] as const).map(({ mode, label }) => <Group key={mode}>
        <div className="lbl">{label}</div>
        <div className="group-card settings-card rules-card">
          {rules.filter((rule) => rule.mode === mode).map((rule) => <GlobalRuleRow key={rule.id} rule={rule} busy={busy} onSave={(text) => change(rules.map((item) => item.id === rule.id ? { ...item, text } : item))} onDelete={() => void change(rules.filter((item) => item.id !== rule.id))} />)}
          <RuleAdd label={label} busy={busy} onAdd={(text) => change([...rules, { text, mode }])} />
        </div>
      </Group>)}
  </>;
}

function GlobalRuleRow({ rule, busy, onSave, onDelete }: { rule: Rule; busy: boolean; onSave: (text: string) => Promise<boolean>; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rule.text);
  const cancel = useRef(false);
  const commit = () => {
    if (cancel.current) { cancel.current = false; return; }
    const value = text.trim();
    if (!value || value === rule.text) { setEditing(false); return; }
    void onSave(value).then((ok) => { if (ok) setEditing(false); });
  };
  const age = Date.now() - Date.parse(rule.changedAt);
  return <div className="rule">
    {editing ? <input className="rule-input" aria-label={t("编辑规则")} autoFocus maxLength={1000} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => {
      if (e.key === "Enter") e.currentTarget.blur();
      if (e.key === "Escape") { cancel.current = true; setText(rule.text); setEditing(false); }
    }} /> : <button className="rule-text" title={t("编辑规则")} disabled={busy} onClick={() => { cancel.current = false; setText(rule.text); setEditing(true); }}>{rule.text}</button>}
    <span className="v">{age >= 0 && age < 86400000 ? <span className="rule-recent">{t("最近修改")}</span> : null}<button className="del" aria-label={t("删除规则：{rule}", { rule: rule.text })} title={t("删除这条规则")} disabled={busy} onClick={onDelete}><Icon name="close" size={13} /></button></span>
  </div>;
}

function RuleAdd({ label, busy, onAdd }: { label: string; busy: boolean; onAdd: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  return <form className="rule-add-form" onSubmit={(e) => { e.preventDefault(); const value = text.trim(); if (value && !busy) void onAdd(value).then((ok) => { if (ok) setText(""); }); }}>
    <input className="rule-input" aria-label={t("{label}添加规则", { label })} placeholder={t("＋ 添加规则")} maxLength={1000} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
    <button className="hob-btn" type="submit" disabled={busy || !text.trim()}>{t("添加")}</button>
  </form>;
}

function DesktopSection() {
  const [view, setView] = useState<DesktopView | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDesktop, setShowDesktop] = useState(false);

  useEffect(() => {
    void loadDesktop()
      .then((v) => {
        setView(v);
        setUrl(v.url);
        setEnabled(v.enabled);
      })
      .catch((e: Error) => setMessage({ ok: false, text: t("无法读取云桌面配置：{error}", { error: e.message }) }));
  }, []);

  const deployed = view?.deployed ?? false;
  /** 开关是本地草稿，点保存才生效；提醒一句，免得以为已经启用 */
  const enabledPending = view !== null && enabled !== view.enabled;

  async function save() {
    if (!view) return;
    setBusy(true);
    setMessage(null);
    try {
      const v = await saveDesktop({ revision: view.revision, url, enabled, ...(token ? { token } : {}) });
      setView(v);
      setToken("");
      setMessage({ ok: true, text: t("已保存") });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function testConnection() {
    setBusy(true);
    setTest(null);
    try {
      const result = await testDesktop();
      if (!result.ok) {
        setTest({ ok: false, text: result.error });
        return;
      }
      const profiles = result.health.screens.filter((item) => item.browserRunning).map((item) => item.id).join(t("、"));
      setTest({ ok: true, text: t("已连接 · {width}×{height} · 浏览器：{profiles}", { width: result.health.display.width, height: result.health.display.height, profiles: profiles || t("无") }) });
    } catch (e) {
      setTest({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const statusLine = test ? <span className={test.ok ? "okline" : "badline"} style={test.ok ? undefined : { color: "var(--danger)" }} role="status">{test.text}</span> : null;

  return (
    <>
      <PageHead title={t("云桌面")} desc={t("云桌面需要单独部署。登录 Hob 的用户可以观看和接管桌面。")} />
      {deployed ? (
        <Group>
          <div className="note">{t("由部署配置（compose 的 desktop 服务）")}</div>
          <div className="formcard">
            <div className="lbl sub">{t("地址")}</div>
            <div className="sline mono">{view?.url || t("未配置")}</div>
            <div className="lbl sub">{t("令牌")}</div>
            <div className="sline">{view?.tokenConfigured ? t("已设置") : t("未设置")}</div>
            <div className="lbl sub">{t("启用")}</div>
            <div className="sline">{view?.enabled ? t("已启用") : t("未启用")}</div>
            <div className="ctl">
              <button className="hob-btn" disabled={busy || !view} onClick={() => void testConnection()}>{t("测试连接")}</button>
              <button className="hob-btn" disabled={!view?.enabled} onClick={() => setShowDesktop(true)}>{t("打开桌面")}</button>
              {statusLine}
            </div>
          </div>
        </Group>
      ) : (
        <>
          <Group>
            <div className="lbl">{t("启用")}</div>
            <div className="ctl">
              <button className={`tog${enabled ? "" : " off"}`} aria-label={t("启用云桌面")} aria-pressed={enabled} disabled={!view} onClick={() => setEnabled(!enabled)} />
              <span className="note">
                {(enabled ? t("已启用。登录 Hob 的用户可以观看桌面，接管后可以操作。") : t("未启用。界面不打开桌面，任务也不能使用桌面。")) + (enabledPending ? t("（保存后生效）") : "")}
              </span>
            </div>
          </Group>
          <Group>
            <div className="lbl">{t("连接")}</div>
            <div className="formcard">
              <div className="lbl">{t("地址")}</div>
              <div className="field">
                <input value={url} disabled={!view || busy} onChange={(e) => setUrl(e.target.value)} placeholder={t("桌面地址示例")} />
              </div>
              <div className="lbl">{t("令牌")}</div>
              <div className="field">
                <input type="password" value={token} disabled={!view || busy} onChange={(e) => setToken(e.target.value)} placeholder={view?.tokenConfigured ? t("已保存，留空不变") : t("云桌面的访问令牌")} />
              </div>
              <div className="sfoot">
                <button className="hob-btn" disabled={busy || !view} onClick={() => void testConnection()}>{t("测试连接")}</button>
                <button className="hob-btn" disabled={!view?.enabled} onClick={() => setShowDesktop(true)}>{t("打开桌面")}</button>
                {statusLine}
                {message ? <span className={message.ok ? "okline" : "badline"} role="status">{message.text}</span> : null}
                <span className="sp" />
                <button className="hob-btn hob-btn-primary" disabled={busy || !view} onClick={() => void save()}>{t("保存")}</button>
              </div>
            </div>
            <div className="note">{t("部署说明见")} <a href="https://github.com/FFatTiger/hob#云桌面" target="_blank" rel="noreferrer">{t("云桌面文档")}</a>{t("。测试连接会检查地址、令牌和云桌面是否可用。")}</div>
          </Group>
        </>
      )}
      {showDesktop ? <Suspense fallback={null}><DesktopScreen initialScreen="hob" takeOver onClose={() => setShowDesktop(false)} /></Suspense> : null}
    </>
  );
}

function GeneralSection() {
  const s = useApp();
  const themes = themeItems();
  const about = s.settings.settings.general.aboutYou;
  const feedback = useSaveFeedback();
  const timezoneFeedback = useSaveFeedback();
  const proxyFeedback = useSaveFeedback();
  const aboutFeedback = useSaveFeedback();
  const proxyValue = s.settings.settings.general.proxy;
  const noProxyValue = s.settings.settings.general.noProxy;
  const [proxyInput, setProxyInput] = useState(proxyValue);
  const [proxyFocused, setProxyFocused] = useState(false);
  useEffect(() => setProxyInput(proxyValue), [proxyValue]);
  const saveProxy = async () => {
    if (proxyInput === proxyValue) return true;
    return proxyFeedback.save({ general: { proxy: proxyInput } });
  };
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <>
      <PageHead title={t("通用设置")} desc={t("主题、时区、网络代理、个人信息、登录密码。")} />
      <Group>
        <div className="lbl">{t("主题")}</div>
        <Seg items={themes} value={s.theme} disabled={feedback.busy} onChange={(theme) => void feedback.save({ general: { theme } })} />
        <SaveFeedback message={feedback.message} />
      </Group>

      <Group>
        <div className="lbl">{t("配色")}</div>
        <PalettePicker
          items={paletteItems()}
          value={s.palette}
          dark={s.theme === "dark" || (s.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)}
          onChange={setPalette}
        />
        <div className="note">{t("深色和浅色各有一套颜色，配色不影响深浅；选了只存在这台设备的浏览器里，不跟着账号同步。")}</div>
      </Group>

      <Group>
        <div className="lbl">{t("界面语言")}</div>
        <Seg items={[{ key: "zh-CN", label: t("中文") }, { key: "en", label: "English" }]} value={s.locale} disabled={feedback.busy} onChange={(locale) => setLocale(locale)} />
        <SaveFeedback message={feedback.message} />
      </Group>

      <Group>
        <div className="lbl">{t("时区")}</div>
        <TimezoneField value={s.settings.settings.general.timezone} onSave={(timezone) => timezoneFeedback.save({ general: { timezone } })} />
        <SaveFeedback message={timezoneFeedback.message} />
        <div className="note">{t("助手的「现在时间」和定时任务都按这个时区算。")}</div>
      </Group>

      <Group>
        <div className="lbl">{t("网络代理")}</div>
        <div className="field">
          <input
            value={proxyFocused ? proxyInput : maskProxy(proxyInput)}
            placeholder={t("如 http://用户名:密码@127.0.0.1:7890")}
            disabled={proxyFeedback.busy}
            onFocus={() => setProxyFocused(true)}
            onChange={(e) => setProxyInput(e.target.value)}
            onBlur={() => { setProxyFocused(false); void saveProxy().then((ok) => { if (!ok) setProxyInput(proxyValue); }); }}
          />
        </div>
        <SaveFeedback message={proxyFeedback.message} />
        <div className="lbl sub">{t("不走代理的地址")}</div>
        <AutoField value={noProxyValue} placeholder={t("如 localhost,127.0.0.1,::1")} onSave={(noProxy) => feedback.save({ general: { noProxy } })} />
        <div className="note">{t("填了以后，Hob 连接模型、插件、网页搜索，以及助手运行的命令，都通过这个代理。")}</div>
      </Group>

      <Group>
        <div className="lbl">{t("展示页面")}</div>
        <button className={`tog${s.settings.settings.general.showPage === false ? " off" : ""}`} aria-label={t("展示页面")} aria-pressed={s.settings.settings.general.showPage !== false} disabled={feedback.busy} onClick={() => void feedback.save({ general: { showPage: s.settings.settings.general.showPage === false } })} />
        <SaveFeedback message={feedback.message} />
        <div className="note">{t("允许助手把适合可视化的内容展示为页面。")}</div>
      </Group>

      <Group>
        <div className="lbl">{t("个人信息")}</div>
        <div className="lbl sub">{t("称呼")}</div>
        <AutoField placeholder={t("如「王先生」")} value={about.name} onSave={(name) => aboutFeedback.save({ general: { aboutYou: { name: name.trim() } } })} />
        <div className="lbl sub">{t("语言")}</div>
        <AutoField placeholder={t("如「中文」")} value={about.language} onSave={(language) => aboutFeedback.save({ general: { aboutYou: { language: language.trim() } } })} />
        <div className="lbl sub">{t("其他")}</div>
        <AutoField multiline placeholder={t("如「不要看融资新闻」")} value={about.notes} onSave={(notes) => aboutFeedback.save({ general: { aboutYou: { notes } } })} />
        <SaveFeedback message={aboutFeedback.message} />
        <div className="note">{t("所有助手都会参考这些信息；未填写的项不使用。")}</div>
      </Group>

      <Group>
        <div className="formcard">
          <PasswordSection onDone={setNotice} />
          {notice ? <div className="note">{notice}</div> : null}
        </div>
      </Group>
    </>
  );
}

function TimezoneField({ value, onSave }: { value: string; onSave: (zone: string) => Promise<boolean> }) {
  const all = timezones();
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => setQuery(value), [value]);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const matches = all.filter((zone) => zone.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 40);

  const commit = (zone: string) => {
    setOpen(false);
    setError(null);
    setQuery(zone);
    if (zone !== value) void onSave(zone).then((ok) => { if (!ok) setQuery(value); });
  };

  return (
    <div className="tz" ref={wrap}>
      <label className="field">
        <input
          value={query}
          placeholder={t("搜索时区，如 Berlin")}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onBlur={() => {
            if (query.trim() !== value) {
              if (all.includes(query.trim())) commit(query.trim());
              else { setQuery(value); setError(t("时区无效，请从列表中选择。")); }
            }
          }}
        />
      </label>
      {error ? <div className="badline" role="status">{error}</div> : null}
      {open && matches.length ? (
        <div className="tzlist">
          {matches.map((zone) => (
            <button key={zone} className={zone === value ? "sel" : ""} onMouseDown={() => commit(zone)}>
              {zone}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PasswordSection({ onDone }: { onDone: (text: string) => void }) {
  const [old, setOld] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!old || !next) {
      onDone(t("请填写旧密码和新密码。"));
      return;
    }
    if (next !== again) {
      onDone(t("两次输入的新密码不一致。"));
      return;
    }
    setBusy(true);
    const error = await changePassword(old, next);
    setBusy(false);
    if (error) {
      onDone(t("修改失败：{error}", { error }));
      return;
    }
    setOld("");
    setNext("");
    setAgain("");
    onDone(t("密码已修改。"));
  };

  return (
    <>
      <div className="lbl">{t("登录密码")}</div>
      <div className="field">
        <input type="password" placeholder={t("旧密码")} value={old} onChange={(e) => setOld(e.target.value)} />
      </div>
      <div className="field">
        <input type="password" placeholder={t("新密码")} value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      <div className="field">
        <input type="password" placeholder={t("再次输入新密码")} value={again} onChange={(e) => setAgain(e.target.value)} />
      </div>
      <SaveRow saved={false} error={null}>
        {old || next || again ? <span className="note">{t("未保存的修改")}</span> : null}
        <button className="hob-btn" disabled={busy || !(old || next || again)} onClick={() => { setOld(""); setNext(""); setAgain(""); onDone(""); }}>{t("取消")}</button>
        <button className="hob-btn hob-btn-primary" onClick={() => void submit()} disabled={busy || !old || !next || !again}>
          {busy ? t("正在验证…") : t("保存")}
        </button>
      </SaveRow>
    </>
  );
}

/** 行内选择：显示当前值和上下箭头，透明的原生下拉盖在上面（手机上弹系统选择器）。 */
function ValuePick<V extends string>({
  value,
  options,
  label,
  icon,
  onChange,
}: {
  value: V;
  options: { value: V; text: string; meta?: string; icon?: ReactNode }[];
  label: string;
  icon?: IconName;
  onChange: (next: V) => void;
}) {
  return (
    <span className="ctl">
      {icon ? <Icon name={icon} size={14} /> : null}
      <Select aria-label={label} value={value} onChange={(next) => onChange(next as V)} options={options.map((item) => ({ value: item.value, label: item.text, meta: item.meta, icon: item.icon }))} />
    </span>
  );
}

/** 思考强度：灯泡 + 档位（和能力图标里的「推理」同一个灯泡）。不支持推理的模型不显示。 */
function ThinkingPicker({
  value,
  model,
  onChange,
}: {
  value: ThinkingLevel;
  model: ModelInfo | undefined;
  onChange: (next: ThinkingLevel) => void;
}) {
  const levels = thinkingLevels(model);
  if (levels.length === 1) return null;
  return (
    <ValuePick
      value={value}
      label={t("思考强度")}
      icon="bulb"
      options={levels.map((level) => ({ value: level, text: thinkingText(level) }))}
      onChange={onChange}
    />
  );
}

/** 模型能力：图片输入、推理用图标，上下文只写数字；悬停有完整说明。 */
function CapIcons({ info }: { info: ModelInfo }) {
  const context = contextText(info.contextWindow);
  return (
    <span className="caps">
      {info.input.includes("image") ? (
        <span title={t("支持图片输入")} aria-label={t("支持图片输入")}>
          <Icon name="image" size={14} />
        </span>
      ) : null}
      {info.reasoning ? (
        <span title={t("支持推理")} aria-label={t("支持推理")}>
          <Icon name="bulb" size={14} />
        </span>
      ) : null}
      <span className="ctx" title={t("上下文 {context}", { context })}>
        {context}
      </span>
    </span>
  );
}

const PROVIDER_APIS: { key: ProviderApi }[] = [
  { key: "openai-completions" },
  { key: "openai-responses" },
  { key: "anthropic-messages" },
  { key: "google-generative-ai" },
];

function providerApiLabel(api: ProviderApi): string {
  switch (api) {
    case "openai-completions": return t("OpenAI 兼容");
    case "openai-responses": return t("OpenAI Responses 兼容");
    case "anthropic-messages": return t("Anthropic 兼容");
    case "google-generative-ai": return t("Google 兼容");
  }
}


/** 一个正在编辑的服务商（API Key 始终为空：留空则沿用已保存的 Key）。 */
type ProviderDraft =
  | { kind: "builtin"; isNew: boolean; id: string; key: string }
  | {
      kind: "custom";
      isNew: boolean;
      id: string;
      name: string;
      api: ProviderApi;
      baseUrl: string;
      key: string;
      models: ProviderModelSetting[];
    };

const slugOf = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

function importKeyLabel(key: ProviderImportItem["key"]): string {
  if (key === "literal" || key === "env") return t("包含 Key");
  if (key === "command") return t("需手动填写");
  return t("无 Key");
}

/** 设置 → 服务商：三层。服务商列表 → 服务商详情 / 添加服务商 / 从本机导入。 */
function ProvidersSection() {
  const s = useApp();
  const sub = s.sub;
  const [view, setView] = useState<ProvidersView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<Record<string, "connected" | "failed">>({});
  const connectionSaved = (id: string, status: "connected" | "failed") => setConnectionStatus((current) => ({ ...current, [id]: status }));

  useEffect(() => {
    void loadProviders().then((result) => (result.ok ? setView(result.view) : setLoadError(result.error)));
  }, []);
  // 进子页时清掉列表上的提示；保存成功回来时重新给
  useEffect(() => {
    if (sub) setNotice(null);
  }, [sub]);
  useEffect(() => {
    if (!view) return;
    setConnectionStatus((current) => Object.fromEntries(Object.entries(current).filter(([id]) => view.providers.some((provider) => provider.id === id))));
  }, [view]);

  if (loadError) return <div className="note">{loadError}</div>;
  if (!view) return <Empty>{t("正在读取服务商…")}</Empty>;

  /** 改完回到列表，并给一行提示。 */
  const done = (next: ProvidersView, message: string) => {
    if (message.startsWith(t("已导入"))) setConnectionStatus({});
    setView(next);
    setNotice(message);
    closeSub();
  };

  /** 改了一个模型的思考档：整份设置换新的（新 revision），这个模型的思考档就地更新。 */
  const thinkingSaved = (providerId: string, thinking: ModelThinkingView, settings: SettingsFile) => {
    setView((current) =>
      current
        ? {
            ...current,
            settings,
            models: {
              ...current.models,
              [providerId]: (current.models[providerId] ?? []).map((item) =>
                item.ref === thinking.ref ? thinking : item,
              ),
            },
          }
        : current,
    );
  };

  if (sub?.kind === "provider")
    return (
      <ProviderDetail id={sub.id} view={view} onView={setView} onSaved={done} onThinking={thinkingSaved} onConnection={connectionSaved} connectionStatus={connectionStatus[sub.id]} />
    );
  if (sub?.kind === "addProvider") return <AddProvider view={view} onSaved={done} onConnection={connectionSaved} />;
  if (sub?.kind === "importProviders") return <ImportProviders onSaved={done} />;
  return <ProvidersHome view={view} notice={notice} connectionStatus={connectionStatus} />;
}

function PluginProviderIcon({ provider, models, size = 32 }: { provider: PluginProviderSummary; models?: readonly { id: string; name?: string }[]; size?: number }) {
  const [failed, setFailed] = useState(false);
  const lower = `${provider.pluginId} ${provider.name}`.toLowerCase();
  if (!MOCK && !failed) {
    return (
      <span className="brand-icon" style={{ width: size, height: size }}>
        <img alt="" src={`/api/plugins/${encodeURIComponent(provider.pluginId)}/icon`} onError={() => setFailed(true)} />
      </span>
    );
  }
  if (lower.includes("copilot") || lower.includes("github")) {
    return <span className="brand-icon" style={{ width: size, height: size }}><Icon name="github" size={Math.round(size * 0.58)} /></span>;
  }
  return <BrandIcon size={size} brand={providerBrand(provider.id, provider.name, models)} />;
}

function pluginProviderStatus(provider: PluginProviderSummary): { cls: string; text: string } {
  if (!provider.enabled) return { cls: "note", text: t("已停用") };
  if (provider.error && !provider.loggedIn) {
    return /过期|重新登录|失效|expired|relogin/i.test(provider.error)
      ? { cls: "provider-status-warn", text: t("需要重新登录") }
      : { cls: "badline", text: t("出错") };
  }
  if (provider.loggedIn) {
    const isKeyless = provider.pluginId === "zen-free" || provider.activeAccount?.toLowerCase() === "public";
    return { cls: "provider-status-ok", text: isKeyless ? t("已启用") : t("已登录") };
  }
  return { cls: "provider-status-warn", text: t("需要登录") };
}

/** 服务商页：已配置的服务商（整行点进详情）、来自插件的服务商（点进插件页）、添加服务商、从本机导入。 */
function ProvidersHome({ view, notice, connectionStatus }: { view: ProvidersView; notice: string | null; connectionStatus: Record<string, "connected" | "failed"> }) {
  const builtinName = (id: string) => view.builtin.find((item) => item.id === id)?.name ?? id;
  const label = (provider: ProviderView) => (provider.kind === "builtin" ? builtinName(provider.id) : provider.name);
  const pluginProviders = view.pluginProviders ?? [];

  return (
    <>
      <PageHead
        title={t("服务商")}
        desc={t("模型服务商与 API Key。内置服务商只需填写 API Key；兼容接口需填写服务地址、协议与模型。API Key 只保存在本机，保存后不再显示。")}
      />

      <ClaudeProviderCard />
      <Group>
        <div className="lbl">{t("已配置的服务商")}</div>
        <div className="group-card settings-card providers-list">
          {view.providers.map((provider) => (
            <button
              className="list-row setting-row"
              key={provider.id}
              onClick={() => openSub({ kind: "provider", id: provider.id, title: label(provider) })}
            >
              <BrandIcon brand={providerBrand(provider.id, label(provider), view.models[provider.id])} />
              <div className="rmain">
                <div className="rname">{label(provider)}</div>
                <div className="rprov">{provider.kind === "builtin" ? t("内置服务商") : t("兼容接口")} · {t("{n} 个模型", { n: view.models[provider.id]?.length ?? 0 })}</div>
              </div>
              <span className={provider.keyConfigured && connectionStatus[provider.id] !== "failed" ? (connectionStatus[provider.id] === "connected" ? "provider-status-ok" : "note") : "badline"}>
                {provider.keyConfigured ? (connectionStatus[provider.id] === "connected" ? t("已连接") : connectionStatus[provider.id] === "failed" ? t("连接失败") : t("未验证")) : t("未填 Key")}
              </span>
              <Icon name="chev" size={15} className="rgo" />
            </button>
          ))}
          {pluginProviders.map((provider) => {
            const st = pluginProviderStatus(provider);
            return (
              <button
                className="list-row setting-row"
                key={provider.id}
                onClick={() => openPlugins(provider.pluginId)}
              >
                <PluginProviderIcon provider={provider} models={view.models[provider.id]} />
                <div className="rmain">
                  <div className="rname">{provider.name}</div>
                  <div className="rprov">
                    {t("来自插件 {plugin}", { plugin: provider.pluginName })} · {t("{n} 个模型", { n: provider.modelCount })}
                  </div>
                </div>
                <span className={st.cls}>{st.text}</span>
                <Icon name="chev" size={15} className="rgo" />
              </button>
            );
          })}
          <button className="maddrow" onClick={() => openSub({ kind: "addProvider", title: t("添加服务商") })}>
            <Icon name="plus" size={16} />
            {t("添加服务商")}
          </button>
          <button className="maddrow" onClick={() => openSub({ kind: "importProviders", title: t("从本机导入") })}>
            <Icon name="doc" size={16} />
            {t("从本机导入")}
          </button>
        </div>
        {view.providers.length || pluginProviders.length ? null : (
          <Empty>{t("尚未添加其他服务商。")}</Empty>
        )}
        <div className="note">
          {pluginProviders.length
            ? t("来自插件的服务商点击后前往对应插件页管理账号与模型；从本机导入会只读本机配置并一次性复制到 Hob。")
            : t("从本机导入会只读本机配置并一次性复制到 Hob，不会修改来源。")}
        </div>
        {notice ? <div className="okline">{notice}</div> : null}
      </Group>
    </>
  );
}

function claudeStatusText(status: ClaudeCodeView["status"] | undefined): string {
  if (!status) return t("正在检测…");
  if (!status.found) return t("未找到 Claude Code，当前不可用。");
  if (status.error) return status.error;
  const details = [status.version, status.plan, status.email].filter(Boolean).join(" · ");
  return status.loggedIn ? t("已登录{details}", { details: details ? ` · ${details}` : "" }) : t("未登录{details}，当前不可用。", { details });
}

function ClaudeProviderCard() {
  const [view, setView] = useState<ClaudeCodeView | null>(null);
  const [draft, setDraft] = useState<ClaudeCodeSettings>({ enabled: false, plan: "pro", executable: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function detect(reset = false) {
    setBusy(true);
    setMessage("");
    try {
      const next = await loadClaude();
      setView(next);
      if (reset) setDraft(next.settings.settings.claude ?? { enabled: false, plan: "pro", executable: "" });
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }
  useEffect(() => { void detect(true); }, []);

  async function save() {
    setBusy(true);
    setMessage("");
    try { setView(await saveClaude(draft)); setMessage(t("已保存")); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  const status = view?.status;
  return <Group>
    <div className="lbl">{t("Claude 订阅（经本机 Claude Code）")}</div>
    <div className="formcard">
      <div className="ctl">
        <button className={`tog${draft.enabled ? "" : " off"}`} aria-label={t("启用 Claude 订阅")} aria-pressed={draft.enabled} disabled={!view || busy} onClick={() => setDraft({ ...draft, enabled: !draft.enabled })} />
        <span className="note">{draft.enabled ? t("已启用") : t("未启用")}{view && draft.enabled !== (view.settings.settings.claude?.enabled ?? false) ? t("（保存后生效）") : ""}</span>
      </div>
      <div className="lbl sub">{t("状态")}</div>
      <div className={status?.loggedIn ? "okline" : "badline"} role="status">
        {claudeStatusText(status)}
      </div>
      {status?.found && !status.loggedIn ? <div className="note">{t("请在终端执行")} <code>claude auth login</code>{t("，然后重新检测。")}</div> : null}
      <div className="lbl sub">{t("套餐")}</div>
      <Select value={draft.plan} disabled={busy || !view} onChange={(value) => setDraft({ ...draft, plan: value as "pro" | "max" })} options={[{ value: "pro", label: "Pro" }, { value: "max", label: "Max" }]} />
      <div className="lbl sub">{t("Claude Code 程序路径")}</div>
      <div className="field"><input value={draft.executable} disabled={busy || !view} onChange={(e) => setDraft({ ...draft, executable: e.target.value })} placeholder={status?.executable || t("留空时自动查找")} /></div>
      <div className="note">{t("用量计入你的 Claude 订阅额度，与 Claude Code 共用。Docker 镜像不支持此功能。")}</div>
      <div className="sfoot">
        <button className="hob-btn" disabled={busy} onClick={() => void detect()}>{t("重新检测")}</button>
        {message ? <span className="note" role="status">{message}</span> : null}
        <span className="sp" />
        <button className="hob-btn hob-btn-primary" disabled={busy || !view} onClick={() => void save()}>{t("保存")}</button>
      </div>
    </div>
  </Group>;
}

/** 服务商详情：改字段、从接口获取模型列表、保存；页底删除。 */
function ProviderDetail({
  id,
  view,
  onView,
  onSaved,
  onThinking,
  onConnection,
  connectionStatus,
}: {
  id: string;
  view: ProvidersView;
  onView: (view: ProvidersView) => void;
  onSaved: (view: ProvidersView, message: string) => void;
  onThinking: (providerId: string, thinking: ModelThinkingView, settings: SettingsFile) => void;
  onConnection: (id: string, status: "connected" | "failed") => void;
  connectionStatus?: "connected" | "failed";
}) {
  const provider = view.providers.find((item) => item.id === id);
  useEffect(() => {
    if (!provider) closeSub();
  }, [provider]);
  if (!provider) return null;

  const initial: ProviderDraft =
    provider.kind === "builtin"
      ? { kind: "builtin", isNew: false, id: provider.id, key: "" }
      : {
          kind: "custom",
          isNew: false,
          id: provider.id,
          name: provider.name,
          api: provider.api,
          baseUrl: provider.baseUrl,
          key: "",
          models: provider.models,
        };

  return (
    <ProviderForm
      view={view}
      initial={initial}
      onSaved={onSaved}
      onView={onView}
      onConnection={onConnection}
      connectionStatus={connectionStatus}
      onThinking={(thinking, settings) => onThinking(id, thinking, settings)}
      extra={
        <DeleteProvider
          view={view}
          provider={provider}
          onDeleted={(next) => {
            onView(next);
            closeSub();
          }}
        />
      }
    />
  );
}

/** 添加服务商：先选内置服务商或兼容接口，再填表。 */
function AddProvider({
  view,
  onSaved,
  onConnection,
}: {
  view: ProvidersView;
  onSaved: (view: ProvidersView, message: string) => void;
  onConnection: (id: string, status: "connected" | "failed") => void;
}) {
  const [kind, setKind] = useState<"builtin" | "custom" | null>(null);
  const [builtinId, setBuiltinId] = useState<string | null>(null);
  const available = view.builtin.filter((item) => !view.providers.some((provider) => provider.id === item.id));

  if (kind === null) {
    return (
      <>
        <SubBack label={t("服务商")} />
        <PageHead title={t("添加服务商")} desc={t("内置服务商只需填写 API Key；兼容接口需填写服务地址、协议与模型。")} />
        <Group>
          <div className="group-card settings-card">
            <button className="list-row model-row" onClick={() => setKind("builtin")}>
              <span className="mtop">
                <span className="mname">{t("内置服务商")}</span>
                <span className="sp" />
                <Icon name="chev" size={14} />
              </span>
              <span className="mprev">{t("提供完整的模型目录，填写 API Key 即可。")}</span>
            </button>
            <button className="list-row model-row" onClick={() => setKind("custom")}>
              <span className="mtop">
                <span className="mname">{t("兼容接口")}</span>
                <span className="sp" />
                <Icon name="chev" size={14} />
              </span>
              <span className="mprev">{t("填写服务地址、协议与模型；模型列表可从接口获取。")}</span>
            </button>
          </div>
        </Group>
      </>
    );
  }

  if (kind === "builtin" && builtinId === null) {
    return <><button className="subback" onClick={() => setKind(null)}><Icon name="left" size={15} />{t("添加服务商")}</button>
      <PageHead title={t("选择内置服务商")} desc={t("选择服务商后填写 API Key。")} />
      <Group><div className="group-card settings-card">{available.length ? available.map((item) => <button className="list-row setting-row" key={item.id} onClick={() => setBuiltinId(item.id)}><BrandIcon brand={providerBrand(item.id, item.name)} /><span className="rmain"><span className="rname">{item.name}</span><span className="rprov">{t("内置服务商")}</span></span><Icon name="chev" size={14} /></button>) : <Empty>{t("所有内置服务商均已添加。")}</Empty>}</div></Group>
    </>;
  }

  const initial: ProviderDraft =
    kind === "builtin"
      ? { kind: "builtin", isNew: true, id: builtinId ?? "", key: "" }
      : { kind: "custom", isNew: true, id: "", name: "", api: "openai-completions", baseUrl: "", key: "", models: [] };

  return <ProviderForm view={view} initial={initial} onSaved={onSaved} onConnection={onConnection} onThinking={() => undefined} />;
}

/** 从本机导入：读本机配置，列出能导入的服务商（不显示 Key）。 */
function ImportProviders({ onSaved }: { onSaved: (view: ProvidersView, message: string) => void }) {
  const [view, setView] = useState<ProviderImportView | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadProviderImports().then((result) => {
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setView(result.view);
      // 默认选中所有能导入、且还没有配过的
      setChosen(new Set(result.view.items.filter((item) => item.selectable && !item.exists).map((item) => item.id)));
    });
  }, []);

  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const commit = async () => {
    if (busy || !chosen.size) return;
    setBusy(true);
    setError(null);
    const ids = [...chosen];
    const result = await importProviders(ids);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onSaved(result.view, t("已导入 {n} 个服务商", { n: ids.length }));
  };

  return (
    <>
      <SubBack label={t("服务商")} />
      <PageHead
        title={t("从本机导入")}
        desc={t("读取本机其他客户端保存的服务商配置。来源文件只读，导入后 Key 存入 Hob，不再显示。")}
      />
      {view === null ? (
        error ? null : <Empty>{t("正在读取…")}</Empty>
      ) : (
        <Group>
          <div className="sline">{t("来源：{source}", { source: view.source })}</div>
          {view.items.length ? (
            <div className="group-card settings-card" style={{ marginTop: 8 }}>
              {view.items.map((item) => (
                <label className={`list-row setting-row${item.selectable ? "" : " gone"}`} key={item.id}>
                  <input
                    type="checkbox"
                    className="rcheck"
                    checked={chosen.has(item.id)}
                    disabled={!item.selectable || busy}
                    onChange={() => toggle(item.id)}
                  />
                  <div className="rmain">
                    <div className="rname">
                      {item.id}
                      <span className="rtags">
                        <span className="rtag">
                          {item.kind === "builtin"
                            ? t("内置服务商")
                            : t("兼容接口{api}", { api: item.api ? ` · ${providerApiLabel(item.api)}` : "" })}
                        </span>
                        {item.models ? <span className="rtag">{t("{n} 个模型", { n: item.models })}</span> : null}
                        {item.exists ? <span className="rtag">{t("将覆盖")}</span> : null}
                      </span>
                    </div>
                    {item.baseUrl ? <div className="rprov">{item.baseUrl}</div> : null}
                    <div className="rfoot">
                      <span className={item.key === "none" && !item.note ? "rtag bad" : "rtag"}>
                        {importKeyLabel(item.key)}
                      </span>
                    </div>
                    {item.note ? <div className="note">{item.note}</div> : null}
                  </div>
                </label>
              ))}
            </div>
          ) : (
            <Empty>{t("未找到可导入的配置。")}</Empty>
          )}
          <div className="ctl" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            <button className="hob-btn hob-btn-primary" onClick={() => void commit()} disabled={busy || !chosen.size}>
              {busy ? t("正在导入…") : t("导入所选")}
            </button>
            <button className="hob-btn" onClick={closeSub} disabled={busy}>
              {t("取消")}
            </button>
          </div>
        </Group>
      )}
      {error ? <div className="badline">{error}</div> : null}
    </>
  );
}

/** 删除服务商（详情页页底，删除前二次确认）。 */
function DeleteProvider({
  view,
  provider,
  onDeleted,
}: {
  view: ProvidersView;
  provider: ProviderView;
  onDeleted: (view: ProvidersView) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const menu = useMenu();
  const affected = (["conversation", "work"] as const).filter((role) =>
    view.settings.settings.models[role].ref.startsWith(`${provider.id}/`),
  );
  const label =
    provider.kind === "builtin"
      ? (view.builtin.find((item) => item.id === provider.id)?.name ?? provider.id)
      : provider.name;

  const drop = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await removeProvider(provider.id);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onDeleted(result.view);
  };

  return <>
    <button className="hob-icon-btn" aria-label={t("更多")} onClick={(event) => menu.toggle("provider", event.currentTarget)}><Icon name="more" size={18} /></button>
    {menu.menu ? createPortal(<div className="amenu" ref={menu.box}><button className="danger" onClick={() => { menu.close(); setConfirming(true); }}>{t("删除服务商")}</button></div>, document.body) : null}
    {confirming ? <div className="group-card sidebar-card-group">
      <div>{t("删除「{name}」后，该服务商的模型将不可用。{affected}", { name: label, affected: affected.length ? t("受影响的默认模型：{roles}。", { roles: affected.map((role) => role === "conversation" ? t("对话") : t("任务执行")).join(t("、")) }) : t("当前默认模型不受影响。") })}</div>
      <div className="ctl"><button className="hob-btn" onClick={() => setConfirming(false)} disabled={busy}>{t("取消")}</button><button className="hob-btn hob-btn-danger" onClick={() => void drop()} disabled={busy}>{t("确认删除")}</button></div>
    </div> : null}
    {error ? <div className="badline">{error}</div> : null}
  </>;
}

/** 服务商表单：内置服务商只填 Key；兼容接口还要名称、协议、服务地址与模型。 */
function ProviderForm({
  view,
  initial,
  onSaved,
  onView,
  onConnection,
  onThinking,
  extra,
  connectionStatus,
}: {
  view: ProvidersView;
  initial: ProviderDraft;
  onSaved: (view: ProvidersView, message: string) => void;
  onView?: (view: ProvidersView) => void;
  onConnection: (id: string, status: "connected" | "failed") => void;
  onThinking: (thinking: ModelThinkingView, settings: SettingsFile) => void;
  extra?: ReactNode;
  connectionStatus?: "connected" | "failed";
}) {
  const s = useApp();
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [confirmModel, setConfirmModel] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState(false);
  const [draft, setDraft] = useState<ProviderDraft>(initial);
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterNotice, setRosterNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!rosterNotice || rosterNotice !== t("已保存")) return;
    const timer = setTimeout(() => setRosterNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [rosterNotice]);
  const [found, setFound] = useState<{ id: string; name?: string }[]>([]);
  const [changingKey, setChangingKey] = useState(initial.isNew || !view.providers.find((provider) => provider.id === initial.id)?.keyConfigured);
  const [tested, setTested] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const configured = new Set(view.providers.map((provider) => provider.id));
  const builtinName = (id: string) => view.builtin.find((item) => item.id === id)?.name ?? id;
  /** 这个服务商的每个模型现在的思考档（服务端算好的：自定义或默认规则）。 */
  const thinkingOf = (modelId: string) => view.models[draft.id]?.find((item) => item.id === modelId);

  const patch = (next: Record<string, unknown>) => setDraft((current) => ({ ...current, ...next }) as ProviderDraft);
  const dirty = draft.isNew || JSON.stringify(draft) !== JSON.stringify(initial);
  const connection = draft.kind === "builtin"
    ? { kind: "builtin" as const, id: draft.id, ...(draft.key.trim() ? { apiKey: draft.key.trim() } : {}) }
    : { kind: "custom" as const, ...(draft.id ? { id: draft.id } : {}), api: draft.api, baseUrl: draft.baseUrl.trim(), ...(draft.key.trim() ? { apiKey: draft.key.trim() } : {}) };
  const fingerprint = JSON.stringify(connection);
  const runConnectionTest = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setTestStatus(null);
    const result = await testProviderConnection(connection);
    setBusy(false);
    if (!dirty && draft.id) onConnection(draft.id, result ? "failed" : "connected");
    if (result) { setTested(null); setError(result); return; }
    setTested(fingerprint);
    setTestStatus(t("连接成功"));
  };

  const rosterControl = (model: { id: string; name?: string; reasoning?: boolean }) => {
    const ref = `${draft.id}/${model.id}`;
    const settings = s.settings.settings.models;
    const selected = settings.roster.some((entry) => entry.ref === ref);
    const isDefault = settings.conversation.ref === ref || settings.work.ref === ref;
    if (isDefault) return <span className="note" title={t("这是默认模型。要移除，请先在「默认模型」中更换。")}>{t("默认模型")}</span>;
    return (
      <span className="ctl">
        <button
          type="button"
          className={`tog${selected ? "" : " off"}`}
          title={t("加入可用模型")}
          aria-label={t("加入可用模型")}
          aria-pressed={selected}
          disabled={draft.isNew || !thinkingOf(model.id) || rosterBusy || busy}
          onClick={() => {
            const roster = selected
              ? settings.roster.filter((entry) => entry.ref !== ref)
              : [...settings.roster, { ref, note: "", scores: guessModelScores({ id: model.id, name: model.name ?? model.id, reasoning: Boolean(model.reasoning) }), scoresConfirmed: false }];
            setRosterBusy(true);
            setRosterNotice(null);
            void saveSettings({ models: { roster } }).then((ok) => {
              setRosterBusy(false);
              setRosterNotice(ok ? t("已保存") : t("保存失败，请重试。"));
            });
          }}
        />
      </span>
    );
  };

  const runDiscover = async () => {
    if (draft.kind !== "custom" || busy) return;
    setBusy(true);
    setError(null);
    const result = await discoverModels({
      api: draft.api,
      baseUrl: draft.baseUrl.trim(),
      ...(draft.key.trim() ? { apiKey: draft.key.trim() } : {}),
      ...(draft.id ? { id: draft.id } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      setFound([]);
      return;
    }
    setFound(result.models);
  };

  const saveModels = async (models: ProviderModelSetting[]) => {
    if (draft.kind !== "custom") return;
    if (draft.isNew) { patch({ models }); return; }
    const existing = view.providers.find((provider) => provider.id === draft.id);
    if (!existing || existing.kind !== "custom") return;
    setBusy(true);
    setError(null);
    const { id, keyConfigured, ...body } = existing;
    const result = await saveProvider(id, { ...body, models });
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    patch({ models });
    onView?.(result.view);
    setRosterNotice(t("已保存"));
  };

  const toggleFound = (model: { id: string; name?: string }) => {
    if (draft.kind !== "custom") return;
    const exists = draft.models.some((item) => item.id === model.id);
    void saveModels(exists
      ? draft.models.filter((item) => item.id !== model.id)
      : [...draft.models, { id: model.id, ...(model.name ? { name: model.name } : {}) }]);
  };

  const addModel = (id: string) => {
    if (draft.kind !== "custom") return;
    const clean = id.trim();
    if (!clean || draft.models.some((item) => item.id === clean)) return;
    void saveModels([...draft.models, { id: clean }]);
  };

  const editModel = (id: string, next: Partial<ProviderModelSetting>) => {
    if (draft.kind !== "custom") return;
    void saveModels(draft.models.map((item) => (item.id === id ? { ...item, ...next } : item)) );
  };

  /** 模型行和思考档在内置及兼容接口中共用；只有兼容接口允许编辑能力。 */
  const modelRow = (model: ProviderModelSetting | ModelThinkingView, editable: boolean) => {
    const info = thinkingOf(model.id);
    const open = expandedModel === model.id;
    const summary = [model.contextWindow ? t("上下文 {size}", { size: contextText(model.contextWindow) }) : "", model.input?.includes("image") ? t("能看图") : "", model.reasoning ? t("会推理") : "", model.reasoning && info ? t("{n} 档思考", { n: info.levels.length }) : ""].filter(Boolean).join(" · ");
    const ref = `${draft.id}/${model.id}`;
    const isDefault = s.settings.settings.models.conversation.ref === ref || s.settings.settings.models.work.ref === ref || s.settings.settings.models.suggest?.ref === ref;
    return <div className={`provider-model${open ? " open" : ""}`} key={model.id}>
      {/* 一整行：点名字那块就地展开；右边是加不加入可用模型的开关（默认模型写「默认模型」） */}
      <div className="provider-model-head">
        <button type="button" className="provider-model-label" aria-expanded={open} onClick={() => setExpandedModel(open ? null : model.id)}>
          <BrandIcon size={28} brand={modelBrand(model.id, model.name, draft.id, draft.kind === "custom" ? draft.name : builtinName(draft.id))} />
          <span className="rmain"><span className="rname">{model.name || model.id}</span><span className="rprov">{summary}</span></span>
        </button>
        {rosterControl(model)}
      </div>
      {open ? <div className="provider-model-content">
        {editable ? <ModelParamsEditor id={model.id} params={model} busy={busy} onEdit={(patch) => editModel(model.id, patch)} /> : <div className="note">{summary || t("暂无能力信息")}</div>}
        {model.reasoning ? info ? <ThinkingLevels modelRef={ref} info={info} disabled={busy} onSaved={onThinking} /> : <div className="note">{t("保存服务商后可以设置思考档。")}</div> : null}
        {isDefault ? <div className="note">{t("这是默认模型。要移除，请先在「默认模型」中更换。")}</div> : editable && draft.kind === "custom" ? confirmModel === model.id ? <div className="mline"><span>{t("确定从这个服务商移除这个模型？")}</span><span className="ctl"><button className="hob-btn" disabled={busy} onClick={() => setConfirmModel(null)}>{t("取消")}</button><button className="hob-btn hob-btn-danger" disabled={busy} onClick={() => { void saveModels(draft.models.filter((item) => item.id !== model.id)); setConfirmModel(null); }}>{t("确认移除")}</button></span></div> : <button className="provider-model-remove" disabled={busy} onClick={() => setConfirmModel(model.id)}>{t("从这个服务商移除这个模型")}</button> : null}
      </div> : null}
    </div>;
  };

  const builtinModelList = (id: string) => {
    const models = view.models[id] ?? [];
    if (!models.length) return null;
    return <><div className="lbl">{t("模型")}</div><div className="group-card provider-models">{models.map((model) => modelRow(model, false))}</div><div className="note">{t("模型由服务商提供。会推理的模型可以改每个思考档发给服务商的字符。")}</div></>;
  };

  const commit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const existing = view.providers.find((provider) => provider.id === draft.id);
    const body =
      draft.kind === "builtin"
        ? { kind: "builtin", ...(draft.key.trim() ? { key: draft.key.trim() } : {}) }
        : {
            kind: "custom",
            name: draft.name.trim(),
            api: draft.api,
            baseUrl: draft.baseUrl.trim(),
            models: draft.models,
            ...(existing?.kind === "custom" && existing.extra ? { extra: existing.extra } : {}),
            ...(draft.key.trim() ? { key: draft.key.trim() } : {}),
          };
    const id = draft.kind === "custom" && draft.isNew ? draft.id.trim() || slugOf(draft.name) : draft.id;
    if (!id) {
      setBusy(false);
      setError(t("保存失败：请填写标识。模型引用使用该标识，只能包含小写字母、数字、点和短横线，例如 my-proxy。"));
      return;
    }
    if (draft.isNew && configured.has(id)) {
      setBusy(false);
      setError(t("该服务商标识已存在，请使用其他标识。"));
      return;
    }
    if (tested !== fingerprint) {
      setTestStatus(t("正在验证连接…"));
      const testError = await testProviderConnection(connection);
      setTestStatus(null);
      if (testError) { setBusy(false); setError(t("测试连接失败：{error}", { error: testError })); return; }
    }
    const result = await saveProvider(id, body);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onConnection(id, "connected");
    onSaved(result.view, t("已保存"));
  };

  const title =
    draft.kind === "builtin"
      ? draft.isNew
        ? t("添加内置服务商")
        : builtinName(draft.id)
      : draft.isNew
        ? t("添加兼容接口")
        : draft.name || t("兼容接口");
  // 新兼容接口未填名称时还没有标识，不显示占位字
  const idText = draft.kind === "builtin" ? draft.id : draft.id || slugOf(draft.name);

  return (
    <>
      <SubBack label={t("服务商")} />
      <div className="provider-heading">
        <BrandIcon size={48} brand={providerBrand(draft.id, title, view.models[draft.id])} />
        <div className="rmain"><div className="rname">{title}</div><div className="rprov">{draft.kind === "builtin" ? t("内置服务商") : <>{t("兼容接口")} · {providerApiLabel(draft.api)}{idText ? ` · ${t("标识 {id}", { id: idText })}` : ""}</>}</div></div>
        {!draft.isNew ? <span className={connectionStatus === "failed" || !view.providers.find((provider) => provider.id === draft.id)?.keyConfigured ? "badline" : "note"}>{connectionStatus === "connected" ? t("已连接") : connectionStatus === "failed" ? t("连接失败") : view.providers.find((provider) => provider.id === draft.id)?.keyConfigured ? t("未验证") : t("未填 Key")}</span> : null}
        {extra}
      </div>

      {draft.kind === "builtin" ? (
        <Group>
          <div className="lbl">{t("连接")}</div><div className="formcard">
          <div className="lbl sub">{t("服务商")}</div>
          <div className="ctl">
            <Select className="grow" value={draft.id} onChange={(value) => patch({ id: value })} disabled options={view.builtin.filter((item) => !draft.isNew || !configured.has(item.id)).map((item) => ({ value: item.id, label: `${item.name}${configured.has(item.id) ? t("（已配置）") : ""}` }))} />
          </div>
          <div className="lbl sub">API Key</div>
          {!changingKey ? <div className="ctl"><span className="note">{t("已保存")}</span><button className="hob-btn" onClick={() => setChangingKey(true)}>{t("更换")}</button></div> : <div className="field">
            <input
              type="password"
              value={draft.key}
              placeholder={
                view.providers.find((provider) => provider.id === draft.id)?.keyConfigured
                  ? t("已保存，留空不变")
                  : "sk-…"
              }
              onChange={(e) => patch({ key: e.target.value })}
              disabled={busy}
            />
          </div>}
          <div className="ctl"><button className="hob-btn" disabled={busy} onClick={() => void runConnectionTest()}>{t("测试连接")}</button><span className="note">{t("测试会请求模型，可能产生费用。")}</span>{testStatus && tested === fingerprint ? <span className="okline">{testStatus}</span> : null}{error ? <span className="badline" role="status">{error}</span> : null}</div>
          <ProviderFoot busy={busy} error={error} dirty={dirty} onCancel={closeSub} onSave={() => void commit()} />
          </div>
        </Group>
      ) : (
        <>
          <Group>
            <div className="lbl">{t("连接")}</div><div className="formcard">
            <div className="lbl sub">{t("名称")}</div>
            <div className="field">
              <input
                value={draft.name}
                placeholder={t("如「我的代理」")}
                onChange={(e) => patch({ name: e.target.value })}
                disabled={busy}
              />
            </div>
            {draft.isNew ? (
              <>
                <div className="lbl sub">{t("标识")}</div>
                <div className="field">
                  <input
                    value={draft.id}
                    placeholder={slugOf(draft.name) || "my-proxy"}
                    onChange={(e) => patch({ id: e.target.value })}
                    disabled={busy}
                  />
                </div>
                <div className="note">{t("模型引用使用该标识，例如 my-proxy/gpt-x。留空则按名称自动生成。")}</div>
              </>
            ) : null}
            <div className="lbl sub">{t("协议")}</div>
            <div className="ctl">
              <Select className="grow" value={draft.api} onChange={(value) => patch({ api: value as ProviderApi })} disabled={busy} options={PROVIDER_APIS.map((item) => ({ value: item.key, label: providerApiLabel(item.key) }))} />
            </div>
            <div className="lbl sub">{t("服务地址")}</div>
            <div className="field">
              <input
                value={draft.baseUrl}
                placeholder="http://127.0.0.1:8080/v1"
                onChange={(e) => patch({ baseUrl: e.target.value })}
                disabled={busy}
              />
            </div>
            <div className="lbl sub">API Key</div>
            {!changingKey ? <div className="ctl"><span className="note">{t("已保存")}</span><button className="hob-btn" onClick={() => setChangingKey(true)}>{t("更换")}</button></div> : <div className="field">
              <input
                type="password"
                value={draft.key}
                placeholder={
                  view.providers.find((provider) => provider.id === draft.id)?.keyConfigured
                    ? t("已保存，留空不变")
                    : "sk-…"
                }
                onChange={(e) => patch({ key: e.target.value })}
                disabled={busy}
              />
            </div>}
            <div className="ctl" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="hob-btn" disabled={busy || !draft.baseUrl.trim()} onClick={() => void runConnectionTest()}>{t("测试连接")}</button>
              {testStatus && tested === fingerprint ? <span className="okline">{testStatus}</span> : null}
              {error ? <span className="badline" role="status">{error}</span> : null}
            </div>
            <ProviderFoot busy={busy} error={error} dirty={dirty} onCancel={closeSub} onSave={() => void commit()} />
            </div>
          </Group>

          {found.length ? (
            <Group>
              <div className="lbl">{t("接口上的模型")}</div>
              <div className="group-card providers-list settings-card">
                {found.map((model) => {
                  const on = draft.models.some((item) => item.id === model.id);
                  return <div className="list-row setting-row" key={model.id}><BrandIcon size={28} brand={modelBrand(model.id, model.name, draft.id, draft.name)} /><span className="rmain">{model.name ?? model.id}</span><button className="hob-btn" onClick={() => toggleFound(model)} disabled={busy || on}>{on ? t("已添加") : t("添加")}</button></div>;
                })}
              </div>
            </Group>
          ) : null}

          <Group>
            <div className="provider-model-title"><div className="lbl">{t("模型")}</div><span className="sp" /><button className="hob-btn" onClick={() => void runDiscover()} disabled={busy || !draft.baseUrl.trim()}>{busy ? t("正在获取…") : t("获取模型列表")}</button><button className="hob-btn" onClick={() => setManualModel(!manualModel)}>{t("手动添加")}</button></div>
            {draft.models.length ? <><div className="group-card provider-models">{draft.models.map((model) => modelRow(model, true))}</div><div className="note">{t("开关打开的模型加入可用模型，助手和输入框里都能选。")}</div></> : <Empty>{t("尚未添加模型。可获取模型列表后勾选，或手动填写模型 ID。")}</Empty>}
            {manualModel ? <ManualModel disabled={busy} onAdd={addModel} /> : null}
          </Group>

        </>
      )}
      {draft.kind === "builtin" && !draft.isNew ? <Group>{builtinModelList(draft.id)}</Group> : null}
      {rosterNotice ? <div className={rosterNotice === t("已保存") ? "okline" : "badline"} role="status">{rosterNotice}</div> : null}
    </>
  );
}

/** 手动填写模型 ID（接口不支持获取模型列表，或需要使用列表外的模型）。 */
function ManualModel({ disabled, onAdd }: { disabled: boolean; onAdd: (id: string) => void }) {
  const [text, setText] = useState("");
  const submit = () => {
    if (!text.trim()) return;
    onAdd(text);
    setText("");
  };
  return (
    <div className="ctl" style={{ gap: 8, marginTop: 10 }}>
      <div className="field" style={{ flex: 1 }}>
        <input
          value={text}
          placeholder={t("手动填写模型 ID，如 gpt-4o-mini")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          disabled={disabled}
        />
      </div>
      <button className="hob-btn" onClick={submit} disabled={disabled || !text.trim()}>
        {t("添加")}
      </button>
    </div>
  );
}

function ProviderFoot({
  busy,
  error,
  dirty,
  onCancel,
  onSave,
}: {
  busy: boolean;
  error: string | null;
  dirty: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  if (!dirty) return null;
  return (
    <SaveRow saved={false} error={null}>
      {!error && dirty ? <span className="note">{t("未保存的修改")}</span> : null}
      <button className="hob-btn" onClick={onCancel} disabled={busy}>
        {t("取消")}
      </button>
      <button className="hob-btn hob-btn-primary" onClick={onSave} disabled={busy || !dirty}>
        {busy ? t("正在验证…") : t("保存")}
      </button>
    </SaveRow>
  );
}

/** 设置 → 模型：三层。模型页（默认模型、可用模型）→ 模型详情 / 添加模型。 */
function ModelsSection() {
  const s = useApp();
  const [view, setView] = useState<ModelsView | null>(null);
  const [providerNames, setProviderNames] = useState<Record<string, string>>({});
  useEffect(() => {
    void loadModels().then(setView);
    void loadProviders().then((res) => {
      if (!res.ok) return;
      const pv = res.view;
      const names: Record<string, string> = {};
      for (const b of pv.builtin) names[b.id] = b.name;
      for (const p of pv.providers) if (p.kind === "custom" && p.name) names[p.id] = p.name;
      for (const pp of pv.pluginProviders ?? []) names[pp.id] = pp.name;
      setProviderNames(names);
    });
  }, []);

  if (!view) return <Empty>{t("正在读取模型列表…")}</Empty>;
  if (s.sub?.kind === "model") return <ModelDetail view={view} modelRef={s.sub.ref} />;
  if (s.sub?.kind === "addModels") return <AddModels view={view} providerNames={providerNames} />;
  return <ModelsHome view={view} providerNames={providerNames} />;
}

function modelUseState(entry: RosterEntry, info?: ModelInfo) {
  return {
    scores: entry.scores ?? guessModelScores(info ?? { id: entry.ref.split("/").at(-1) ?? entry.ref, name: "", reasoning: false }),
    unconfirmed: !entry.scores || entry.scoresConfirmed !== true,
  };
}

function ModelUseEditor({ entry, info, update, collapsible = false }: { entry: RosterEntry; info?: ModelInfo; update: (patch: Partial<RosterEntry>) => void; collapsible?: boolean }) {
  const initial = modelUseState(entry, info);
  const [expanded, setExpanded] = useState(!collapsible);
  const [scores, setScores] = useState(initial.scores);
  const [note, setNote] = useState(entry.note);
  // 拖动中只改本地，松手才保存；拖动时不让服务端回来的旧值把滑块拽回去（否则会来回闪）
  const dragging = useRef(false);
  const latest = useRef(scores);
  latest.current = scores;
  useEffect(() => { if (!dragging.current) setScores(modelUseState(entry, info).scores); }, [entry.scores, info]);
  useEffect(() => setNote(entry.note), [entry.note]);
  const save = (next: typeof scores) => update({ scores: next, scoresConfirmed: true });
  const release = () => {
    if (!dragging.current) return;
    dragging.current = false;
    const saved = entry.scores;
    const next = latest.current;
    if (!saved || entry.scoresConfirmed !== true || saved.smart !== next.smart || saved.cost !== next.cost || saved.speed !== next.speed) save(next);
  };
  if (collapsible && !expanded) return <Disclosure className="model-use-disclosure" label={t("用途说明")} count={scoreSummary(entry.scores ?? scores)} open={false} onToggle={() => setExpanded(true)} />;
  const names = { smart: t("智能程度"), cost: t("成本"), speed: t("速度") } as const;
  const content = (
    <div className="group">
      <div className="note">{t("Hob 按用途选择分派任务的模型。")} {initial.unconfirmed ? t("数值按模型名称推测，请确认。") : ""}</div>
      {(Object.keys(names) as (keyof typeof names)[]).map((kind) => (
        <div className="score-row" key={kind}>
          <div className="score-head">
            <label htmlFor={`${entry.ref}-${kind}`}>{names[kind]}</label>
            <span>{scoreLabel(kind, scores[kind])} · {scores[kind]}%</span>
          </div>
          <input id={`${entry.ref}-${kind}`} className="score-range" type="range" min="0" max="100" step="5" value={scores[kind]}
            onChange={(e) => { dragging.current = true; setScores({ ...latest.current, [kind]: Number(e.target.value) }); }}
            onPointerUp={release} onTouchEnd={release} onKeyUp={release} onBlur={release} />
          <div className="score-ticks">
            {SCORE_STAGES[kind].map((stage) => (
              <button key={stage.value} style={{ left: `${stage.value}%` }} className={stage.value === 0 ? "first" : stage.value === 100 ? "last" : undefined}
                aria-pressed={t(stage.label) === scoreLabel(kind, scores[kind])}
                onClick={() => { const next = { ...latest.current, [kind]: stage.value }; setScores(next); save(next); }}>{stage.label}</button>
            ))}
          </div>
        </div>
      ))}
      <div className="field"><input value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => { if (note !== entry.note) update({ note }); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} placeholder={t("补充说明（选填），如「中文写作特别好」")} /></div>
    </div>
  );
  return collapsible ? <Disclosure className="model-use-disclosure" label={t("用途说明")} count={scoreSummary(entry.scores ?? scores)} open onToggle={() => setExpanded(false)}>{content}</Disclosure> : content;
}

/** 模型设置的读写：名单（可用模型）和两个默认角色。 */
function useModelSettings() {
  const s = useApp();
  const models = s.settings.settings.models;
  const feedback = useSaveFeedback();
  const save = (patch: Partial<typeof models>) => void feedback.save({ models: patch });
  const setRoster = (roster: RosterEntry[]) => save({ roster });
  const update = (ref: string, patch: Partial<RosterEntry>) =>
    void feedback.save((current) => ({ models: { roster: current.models.roster.map((entry) => entry.ref === ref ? { ...entry, ...patch } : entry) } }));
  /** 这个模型当前担任的默认角色。 */
  const roles = (ref: string) =>
    [models.conversation.ref === ref ? t("对话") : null, models.work.ref === ref ? t("任务执行") : null, models.suggest?.ref === ref ? t("推荐提问") : null].filter(
      (role): role is string => role !== null,
    );
  return { models, save, setRoster, update, roles, feedback };
}

function roleLabel(key: "conversation" | "work" | "suggest"): string {
  return key === "conversation" ? t("对话") : key === "work" ? t("任务执行") : t("推荐提问");
}

function SubBack({ label }: { label?: string }) {
  const title = label ?? t("模型");
  return (
    <button className="subback" onClick={closeSub}>
      <Icon name="left" size={15} />
      {title}
    </button>
  );
}

function ModelsHome({ view, providerNames = {} }: { view: ModelsView; providerNames?: Record<string, string> }) {
  const providers = useApp().settings.settings.providers;
  const { models, save, roles, feedback } = useModelSettings();
  const byRef = new Map(view.models.map((model) => [model.ref, model]));
  const providerLabel = (providerId?: string) => (providerId ? providerNames[providerId] ?? providerId : "");
  const suggestOff = "__suggest_off__";
  const pickOptions = (current: string) => [
    ...(models.roster.length ? [] : [{ value: "", text: t("未设置") }]),
    ...models.roster
      .filter((entry) => byRef.has(entry.ref) || entry.ref === current)
      .map((entry) => {
        const info = byRef.get(entry.ref);
        return {
          value: entry.ref,
          text: info?.name ?? entry.ref,
          meta: info ? providerLabel(info.provider) : undefined,
          icon: <BrandIcon size={20} brand={brandForRef(entry.ref, view.models, providers)} />,
        };
      }),
  ];
  const role = (key: "conversation" | "work", label: string, pickLabel: string) => (
    <div className="mline">
      <span className="k">{label}</span>
      <span className="vals">
        <ValuePick
          value={models[key].ref}
          label={pickLabel}
          options={pickOptions(models[key].ref)}
          onChange={(ref) => save({ [key]: { ref, thinking: fitThinking(byRef.get(ref), models[key].thinking) } })}
        />
        <ThinkingPicker
          value={fitThinking(byRef.get(models[key].ref), models[key].thinking)}
          model={byRef.get(models[key].ref)}
          onChange={(thinking) => save({ [key]: { ...models[key], thinking } })}
        />
      </span>
    </div>
  );
  const suggestRef = models.suggest === null ? suggestOff : models.suggest?.ref ?? "";
  const suggestOptions = [
    { value: "", text: t("跟随对话模型") },
    { value: suggestOff, text: currentLocale() === "en" ? t("推荐提问关闭") : t("关闭") },
    ...pickOptions(models.suggest?.ref ?? ""),
  ];

  return (
    <>
      <PageHead title={t("模型")} desc={t("可用模型来自「服务商」，默认模型从可用模型中选择。")} />
      <SaveFeedback message={feedback.message} toast />

      <Group>
        <div className="lbl">{t("默认模型")}</div>
        <div className="group-card settings-card">
          {role("conversation", t("对话"), t("对话模型"))}
          {role("work", t("任务执行"), t("默认任务模型"))}
          <div className="mline">
            <span className="k">{t("推荐提问模型")}</span>
            <span className="vals">
              <ValuePick
                value={suggestRef}
                label={t("推荐提问模型")}
                options={suggestOptions}
                onChange={(ref) => save({ suggest: ref === suggestOff ? null : ref ? { ref, thinking: "off" } : { ref: "", thinking: "off" } })}
              />
            </span>
          </div>
        </div>
        <div className="note">{t("助手每轮做完后，用这个模型在输入框上方推荐你接下来可能说的话。选便宜的模型就行。")}</div>
        <div className="note">{t("助手分派任务时未指定模型，使用任务执行的模型。")}</div>
        <div className="lbl">{t("任务的思考档")}</div>
        <Seg items={[{ key: "auto", label: t("助手按任务选择") }, { key: "fixed", label: t("固定使用默认档") }]} value={models.thinkingChoice ?? "auto"} disabled={feedback.busy} onChange={(thinkingChoice) => save({ thinkingChoice })} />
        <div className="note">{t("按任务选择时，助手会给简单的活用低档、复杂的活用高档；固定时一律使用上面设置的默认档。")}</div>
      </Group>

      <Group>
        <div className="lbl">{t("可用模型")}</div>
        <div className="group-card settings-card">
          {models.roster.map((entry) => {
            const info = byRef.get(entry.ref);
            const name = info?.name ?? entry.ref;
            const usage = modelUseState(entry, info);
            return (
              <button
                className={`list-row model-row${info ? "" : " gone"}`}
                key={entry.ref}
                onClick={() => openSub({ kind: "model", ref: entry.ref, title: name })}
              >
                <span className="mtop">
                  <BrandIcon size={28} brand={brandForRef(entry.ref, view.models, providers)} />
                  <span className="mname">{name}</span>
                  <span className="sp" />
                  {info ? <CapIcons info={info} /> : <span className="mbad">{t("不可用")}</span>}
                  <Icon name="chev" size={14} />
                </span>
                <span className="mprev">
                  {roles(entry.ref).map((label) => (
                    <span className="mrole" key={label}>
                      {roleLabel(label === t("对话") ? "conversation" : label === t("任务执行") ? "work" : "suggest")}
                    </span>
                  ))}
                  {info?.provider.startsWith("plugin-") ? `${providerLabel(info.provider)} · ` : ""}
                  {scoreSummary(usage.scores)}
                  {usage.unconfirmed ? <span className="model-use-warning">{t("请确认用途")}</span> : null}
                  {!info ? ` · ${t("该模型的服务商已删除或未配置 Key")}` : null}
                </span>
              </button>
            );
          })}
          <button className="maddrow" onClick={() => openSub({ kind: "addModels", title: t("添加模型") })}>
            <Icon name="plus" size={16} />
            {t("添加模型")}
          </button>
        </div>
        <div className="note">{t("助手分派任务时，按用途说明在可用模型中选择。")}</div>
      </Group>
    </>
  );
}

function ModelDetail({ view, modelRef }: { view: ModelsView; modelRef: string }) {
  const { models, setRoster, update, roles, feedback } = useModelSettings();
  const [confirming, setConfirming] = useState(false);
  const entry = models.roster.find((item) => item.ref === modelRef);
  useEffect(() => {
    if (!entry) closeSub();
  }, [entry]);
  if (!entry) return null;
  const info = view.models.find((model) => model.ref === modelRef);
  const used = roles(modelRef);

  return (
    <>
      <SubBack />
      <PageHead title={info?.name ?? modelRef} desc={<span className="mono">{modelRef}</span>} />
      <SaveFeedback message={feedback.message} toast />

      <Group>
        <div className="lbl">{t("用途说明")}</div>
        <ModelUseEditor entry={entry} info={info} update={(patch) => update(modelRef, patch)} />
      </Group>

      {info?.reasoning ? (
        <Group>
          <div className="group-card settings-card">
            <div className="mline">
              <span className="k">{t("分派时的思考强度")}</span>
              <ThinkingPicker
                value={fitThinking(info, entry.thinking ?? models.work.thinking)}
                model={info}
                onChange={(thinking) => update(modelRef, { thinking })}
              />
            </div>
          </div>
          <div className="note">{t("助手把任务分派给这个模型时使用。作为默认模型时，以「默认模型」中的设置为准。")}</div>
        </Group>
      ) : null}

      <Group>
        <div className="lbl">{t("信息")}</div>
        <div className="kvcard">
          <div className="kvrow">
            <span className="k">{t("服务商")}</span>
            <span className="v">{info?.provider ?? t("不可用")}</span>
          </div>
          {info ? (
            <>
              <div className="kvrow">
                <span className="k kicon">
                  <Icon name="image" size={14} />
                  {t("图片输入")}
                </span>
                <span className="v">{info.input.includes("image") ? t("支持") : t("不支持")}</span>
              </div>
              <div className="kvrow">
                <span className="k kicon">
                  <Icon name="bulb" size={14} />
                  {t("推理")}
                </span>
                <span className="v">{info.reasoning ? t("支持") : t("不支持")}</span>
              </div>
              <div className="kvrow">
                <span className="k">{t("上下文")}</span>
                <span className="v">{contextText(info.contextWindow)}</span>
              </div>
            </>
          ) : null}
        </div>
      </Group>

      <Group>
        <div className="lbl">{t("危险操作")}</div>
        <div className="group-card settings-card">
          {confirming ? <div className="ctl" style={{ flexWrap: "wrap", padding: 12 }}><span>{t("确定从可用模型中移除？")}</span><button className="hob-btn" onClick={() => setConfirming(false)}>{t("取消")}</button><button className="hob-btn hob-btn-danger" onClick={() => setRoster(models.roster.filter((item) => item.ref !== modelRef))}>{t("确认移除")}</button></div> : <button className="mline danger" disabled={used.length > 0} onClick={() => setConfirming(true)}>{t("从可用模型中移除")}</button>}
        </div>
        {used.length ? (
          <div className="note">{t("这是 {roles} 的默认模型。要移除，请先在「默认模型」中更换。", { roles: used.join(t("和")) })}</div>
        ) : null}
      </Group>
    </>
  );
}

function AddModels({ view, providerNames = {} }: { view: ModelsView; providerNames?: Record<string, string> }) {
  const providers = useApp().settings.settings.providers;
  const providerName = (id: string) => {
    if (providerNames[id]) return providerNames[id];
    const provider = providers.find((item) => item.id === id);
    return provider?.kind === "custom" ? provider.name : undefined;
  };
  const { models, setRoster, roles, update, feedback } = useModelSettings();
  const [query, setQuery] = useState("");
  const chosen = new Set(models.roster.map((entry) => entry.ref));
  // 服务商一开始都收起，用户点开哪个看哪个
  const [openGroups, setOpenGroups] = useState<string[]>([]);
  const groups = groupByProvider(filterModels(view.models, query));
  const searching = query.trim().length > 0;
  const toggleGroup = (provider: string) =>
    setOpenGroups((list) => (list.includes(provider) ? list.filter((item) => item !== provider) : [...list, provider]));
  const toggle = (model: ModelInfo) =>
    setRoster(
      chosen.has(model.ref)
        ? models.roster.filter((entry) => entry.ref !== model.ref)
        : [
            ...models.roster,
            { ref: model.ref, scores: guessModelScores(model), note: "", scoresConfirmed: false, ...(model.reasoning ? { thinking: fitThinking(model, "medium") } : {}) },
          ],
    );

  return (
    <>
      <SubBack />
      <PageHead title={t("添加模型")} desc={t("「服务商」提供的全部模型，已勾选的已在可用模型中。")} />
      <SaveFeedback message={feedback.message} toast />
      {view.models.length === 0 ? (
        <Group>
          <Empty>{t("尚无可用模型。请先在「服务商」中配置服务商并填写 API Key。")}</Empty>
          <div className="ctl">
            <button className="hob-btn" onClick={() => setSection("providers")}>
              {t("配置服务商")}
            </button>
          </div>
        </Group>
      ) : (
        <div className="madd-list">
          <label className="mfind group-card">
            <Icon name="search" size={15} />
            <input value={query} placeholder={t("搜索名称或引用，如 claude")} onChange={(e) => setQuery(e.target.value)} />
          </label>
          {groups.length === 0 ? (
            <div className="group-card"><Empty>{t("没有匹配的模型。")} </Empty></div>
          ) : (
            groups.map((group) => {
              const open = searching || openGroups.includes(group.provider);
              const picked = group.models.filter((model) => chosen.has(model.ref)).length;
              return (
                <Disclosure
                  key={group.provider}
                  className="mgroup-disclosure"
                  label={<span className="provider-model-label"><BrandIcon size={28} brand={providerBrand(group.provider, providerName(group.provider), group.models)} /><span className="n">{providerName(group.provider) ?? group.provider}</span></span>}
                  count={picked ? t("已加入 {picked} / {total}", { picked, total: group.models.length }) : t("{n} 个模型", { n: group.models.length })}
                  open={open}
                  onToggle={() => toggleGroup(group.provider)}
                >
                  {group.models.map((model) => {
                    const on = chosen.has(model.ref);
                    const locked = roles(model.ref).length > 0;
                    const entry = models.roster.find((item) => item.ref === model.ref);
                    return (
                      <div key={model.ref}>
                        <button
                          className={`madd${on ? " on" : ""}`}
                          disabled={locked}
                          title={locked ? t("默认模型不能在这里移除") : on ? t("从可用模型中移除") : t("加入可用模型")}
                          onClick={() => toggle(model)}
                        >
                          <BrandIcon size={22} brand={modelBrand(model.id, model.name, model.provider, providerName(model.provider))} />
                          <span className="mname">{model.name}</span>
                          <CapIcons info={model} />
                          <Icon name={on ? "check" : "plus"} size={16} className="mtog" />
                        </button>
                        {entry ? <div className="model-use-inline"><ModelUseEditor entry={entry} info={model} collapsible update={(patch) => update(model.ref, patch)} /></div> : null}
                      </div>
                    );
                  })}
                </Disclosure>
              );
            })
          )}
        </div>
      )}
    </>
  );
}

function WorkSection() {
  const s = useApp();
  const work = s.settings.settings.work;
  const feedback = useSaveFeedback();
  const save = (patch: Partial<typeof work>) => feedback.save({ work: patch });

  return (
    <>
      <PageHead title={t("任务")} desc={t("任务并行数、无响应判定时间，以及全部任务的任务记录。")} />

      <Group>
        <div className="lbl">{t("最大并行任务数")}</div>
        <div className="ctl">
          <Select value={String(work.maxJobs)} disabled={feedback.busy} onChange={(value) => void save({ maxJobs: Number(value) })} options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) }))} />
        </div>
        <div className="note">{t("同时运行的最大任务数，超出后排队。")}</div>
        <SaveFeedback message={feedback.message} />
      </Group>

      <Group>
        <div className="lbl">{t("无响应判定时间")}</div>
        <div className="lbl sub">{t("任务")}</div>
        <div className="ctl">
          <AutoField value={String(work.jobStallMinutes)} onSave={(value) => save({ jobStallMinutes: Number(value) })} />
          <span className="note">{t("分钟")}</span>
        </div>

        <div className="lbl sub">{t("助手回复")}</div>
        <div className="ctl">
          <AutoField value={String(work.routerStallMinutes)} onSave={(value) => save({ routerStallMinutes: Number(value) })} />
          <span className="note">{t("分钟")}</span>
        </div>
        <SaveFeedback message={feedback.message} />
        <div className="note">{t("修改后立即生效，无需重启。")}</div>
      </Group>

      <Group>
        <div className="lbl">{t("任务记录")}</div>
        <div className="ctl">
          <button className="hob-btn" onClick={() => openJobs()}>
            {t("查看全部任务")}
          </button>
        </div>
        <div className="note">{t("可查看每个任务的完整执行过程。")}</div>
      </Group>
    </>
  );
}

/** 设置 → 通知：本机推送开关、已订阅设备、测试、iOS 说明。 */
function PushSection() {
  const s = useApp();
  const feedback = useSaveFeedback();
  const [view, setView] = useState<PushView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [confirmEndpoint, setConfirmEndpoint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const supported = pushSupported();

  const refreshSubscribed = () =>
    void currentSubscription().then((subscription) => setEndpoint(subscription?.endpoint ?? null));

  useEffect(() => {
    void loadPush().then((result) => (result.ok ? setView(result.view) : setLoadError(result.error)));
    refreshSubscribed();
  }, []);

  if (loadError) return <div className="note">{loadError}</div>;
  if (!view) return <Empty>{t("正在读取推送设置…")}</Empty>;

  const denied = typeof Notification !== "undefined" && Notification.permission === "denied";
  const on = Boolean(endpoint && view.devices.some((device) => device.endpoint === endpoint));

  const toggle = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = on ? await disconnectPush() : await connectPush();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setView(result.view);
      refreshSubscribed();
      setDone(on ? t("此设备将不再接收推送") : t("此设备将接收推送"));
    } finally {
      setBusy(false);
    }
  };

  const drop = async (target: string) => {
    const result = await removePushDevice(target);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setView(result.view);
    setConfirmEndpoint(null);
    refreshSubscribed();
  };

  const test = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await sendTestPush();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.sent) setDone(t("测试通知已发送"));
      else if (result.removed) {
        // 订阅已经失效被服务端删了：刷新列表，开关会显示成关
        setError(t("这台设备的订阅已失效，已移除；请重新开启本机推送"));
        void loadPush().then((next) => next.ok && setView(next.view));
      } else setDone(t("未发送：这台设备尚未订阅"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title={t("通知")} desc={t("本机推送与已订阅的设备。")} />

      <Group>
        <div className="lbl">{t("本机推送")}</div>
        {supported ? (
          <div className="ctl">
            <span style={{ fontSize: 14 }}>{t("需要我回答或做完时通知我")}</span>
            <span className="sp" />
            <button
              className={`tog${on ? "" : " off"}`}
              title={on ? t("关闭本机推送") : t("开启本机推送")}
              onClick={() => void toggle()}
              disabled={busy}
            />
          </div>
      ) : (
          <div className="note">{t("这个浏览器不支持推送：请使用 Chrome、Edge、Safari 16.4+，或在 iPhone 上将 Hob 添加到主屏幕。")}</div>
        )}
        {denied ? (
          <div className="note">
            {t("浏览器已拒绝通知权限：点击地址栏左侧的图标 → 通知 → 允许，然后刷新本页并重新开启。")}
          </div>
        ) : null}
        <div className="note">{t("页面在前台时不推送，页面不在前台或锁屏时才推送。各助手还需在助手设置中开启「需要我回答或做完时通知我」。")}</div>
        <div className="note">{t("在 iPhone 上需先将 Hob 添加到主屏幕，再从主屏幕打开才能接收推送。")}</div>
      </Group>

      <Group>
        <div className="lbl">{t("已订阅的设备")}</div>
        {view.devices.length ? (
          view.devices.map((device) => (
            <div className="dev" key={device.endpoint}>
              <span className="n">{device.label}</span>
              <span className="tm">{fmtWhen(device.createdAt)}</span>
              <span className="sp" />
              {confirmEndpoint === device.endpoint ? <><span className="note">{t("确认删除？")}</span><button className="hob-btn" onClick={() => setConfirmEndpoint(null)}>{t("取消")}</button><button className="hob-btn hob-btn-danger" onClick={() => void drop(device.endpoint)}>{t("确认删除")}</button></> : <button className="del" title={t("删除这台设备")} onClick={() => setConfirmEndpoint(device.endpoint)}>{t("删除")}</button>}
            </div>
          ))
        ) : (
          <Empty>{t("暂无已订阅的设备")}</Empty>
        )}
        <div className="ctl">
          <button className="hob-btn" onClick={() => void test()} disabled={busy || !view.devices.length}>
            {t("发送测试通知")}
          </button>
          {done && !error ? <span className="okline">{done}</span> : null}
          {error ? <span className="badline">{error}</span> : null}
        </div>
      </Group>

      <Group>
        <div className="lbl">{t("推送服务联系邮箱（选填）")}</div>
        <AutoField placeholder="name@example.com" value={s.settings.settings.push.email} onSave={(email) => feedback.save({ push: { email: email.trim() } })} />
        <SaveFeedback message={feedback.message} />
        <div className="note">{t("推送服务使用此地址联系你；留空使用 Hob 的项目主页。")}</div>
      </Group>
    </>
  );
}

const LORE_SAAS = "https://api.loremem.com";
/** 注册 / 登录入口：Token 小标题右边那个链接。 */
const LORE_LINKS = { saas: "https://app.loremem.com/login" };

const DEPLOYMENTS: { key: "saas" | "self" }[] = [{ key: "saas" }, { key: "self" }];
function deploymentLabel(key: "saas" | "self"): string {
  return key === "saas" ? t("Lore 云服务") : t("自部署");
}

const PROVIDERS: { key: MemoryProvider }[] = [{ key: "local" }, { key: "lore" }, { key: "off" }];
function memoryProviderLabel(key: MemoryProvider): string {
  if (key === "local") return t("本地记忆");
  if (key === "lore") return "Lore";
  return t("关闭");
}

function loreTestReason(reason: Exclude<LoreTestResult, { ok: true }>["reason"]): string {
  switch (reason) {
    case "invalid_url": return t("服务地址无效。");
    case "insecure_http": return t("公网地址必须使用 https，明文 http 仅允许本机或局域网地址。");
    case "missing_token": return t("缺少 API Token。");
    case "unauthorized": return t("API Token 被拒绝。");
    case "unreachable": return t("无法连接该地址。");
  }
}

const normalizeBase = (value: string) => value.trim().replace(/\/+$/, "");

/** 部署方式：已存的地址等于云服务（或还没配）就是云服务。 */
function deploymentOf(baseUrl: string | null): "saas" | "self" {
  return baseUrl === null || normalizeBase(baseUrl) === LORE_SAAS ? "saas" : "self";
}

function MemorySection() {
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [provider, setProvider] = useState<MemoryProvider | null>(null);
  const [deployment, setDeployment] = useState<"saas" | "self">("saas");
  const [baseUrl, setBaseUrl] = useState(LORE_SAAS);
  const [token, setToken] = useState("");
  const [connectionDirty, setConnectionDirty] = useState(false);
  const [tested, setTested] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [loreSource, setLoreSource] = useState<{ source: string; found: boolean } | null>(null);
  const [loreImportError, setLoreImportError] = useState<string | null>(null);
  const [loreImported, setLoreImported] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [saved]);

  const reset = (next: MemoryConfig) => {
    setConfig(next);
    setLoadError(null);
    setProvider(null);
    setDeployment(deploymentOf(next.lore.baseUrl));
    setBaseUrl(next.lore.baseUrl ?? LORE_SAAS);
    setToken("");
    setConnectionDirty(false);
    setTested(false);
    setTest(null);
    setError(null);
    setSaved(false);
  };

  useEffect(() => {
    void loadMemory().then((result) => {
      if (result.ok) reset(result.config);
      else setLoadError(result.error);
    });
  }, []);

  if (loadError) return <div className="note">{loadError}</div>;
  if (!config) return <Empty>{t("正在读取记忆设置…")}</Empty>;

  const shown = provider ?? config.provider;
  // 存的 Token 只对存的地址生效：换了地址就要重新填
  const tokenKept = config.lore.tokenConfigured && normalizeBase(baseUrl) === normalizeBase(config.lore.baseUrl ?? "");
  const verified = provider === "lore" && !connectionDirty ? config.lore.configured : tested;
  const dirty = provider !== null || connectionDirty;

  const changeProvider = async (next: MemoryProvider) => {
    if (busy) return;
    if (next === config.provider) { setProvider(null); return; }
    setError(null);
    setSaved(false);
    if (next === "lore" && !config.lore.configured) {
      setProvider("lore");
      return;
    }
    setBusy(true);
    const result = await saveMemoryProvider(config.revision, next);
    setBusy(false);
    if (!result.ok) { setError(result.error); return; }
    reset(result.config);
    setSaved(true);
  };

  const edit = (fn: () => void) => {
    if (busy) return;
    fn();
    setConnectionDirty(true);
    setTested(false);
    setTest(null);
    setError(null);
    setSaved(false);
  };

  const chooseDeployment = (next: "saas" | "self") =>
    edit(() => {
      setDeployment(next);
      setBaseUrl(next === "saas" ? LORE_SAAS : deploymentOf(config.lore.baseUrl) === "self" ? config.lore.baseUrl ?? "" : "");
    });

  /** 从本机导入 Lore 连接：只读本机那份配置，写进 Hob 自己的。 */
  const importFromLocal = async () => {
    if (busy) return;
    setBusy(true);
    setLoreImportError(null);
    setLoreImported(false);
    const listed = await loadLoreImport();
    if (!listed.ok) {
      setBusy(false);
      setLoreImportError(listed.error);
      return;
    }
    setLoreSource({ source: listed.view.source, found: listed.view.found });
    if (!listed.view.found) {
      setBusy(false);
      return;
    }
    const result = await importLore();
    setBusy(false);
    if (!result.ok) {
      setLoreImportError(result.error);
      return;
    }
    reset(result.config);
    setProvider("lore");
    setLoreImported(true);
  };

  const runTest = async () => {
    if (busy) return;
    setBusy(true);
    setTest(null);
    const body = { baseUrl: baseUrl.trim(), ...(token ? { token } : {}) };
    const outcome = await testMemoryLore(body);
    setBusy(false);
    if (!outcome.ok) {
      setTest({ ok: false, text: outcome.error });
      return;
    }
    if (outcome.result.ok) {
      setTested(true);
      setTest({ ok: true, text: t("已连接") });
    } else {
      setTest({ ok: false, text: loreTestReason(outcome.result.reason) });
    }
  };

  const commit = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    if (shown === "lore" && !verified) {
      const outcome = await testMemoryLore({ baseUrl: baseUrl.trim(), ...(token ? { token } : {}) });
      if (!outcome.ok) {
        setBusy(false);
        setError(outcome.error);
        return;
      }
      if (!outcome.result.ok) {
        setBusy(false);
        setError(loreTestReason(outcome.result.reason));
        return;
      }
      setTested(true);
    }
    let current = config;
    if (shown === "lore" && connectionDirty) {
      const connection = await saveMemoryLore({ baseUrl: baseUrl.trim(), ...(token ? { token } : {}) });
      if (!connection.ok) {
        setBusy(false);
        setError(connection.error);
        return;
      }
      current = connection.config;
    }
    const result = await saveMemoryProvider(current.revision, shown);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      // 被别处改过：重新拉一份，不猜
      if (/已刷新/.test(result.error)) void loadMemory().then((again) => again.ok && reset(again.config));
      return;
    }
    reset(result.config);
    setSaved(true);
  };

  const statusText = config.provider === "lore"
    ? config.lore.configured ? t("Lore · 已连接 · 插件 {plugin}", { plugin: config.lorePlugin }) : t("Lore · 尚未配置完成：请填写服务地址与 API Token 后保存")
    : config.provider === "local" ? t("本地记忆 · 已启用") : t("关闭 · 助手不使用长期记忆");

  return (
    <>
      <PageHead
        title={t("记忆")}
        desc={t("所有助手共用同一份长期记忆。")}
      />

      <Group>
        <div className="lbl">{t("提供者")}</div>
        <Seg items={PROVIDERS.map((item) => ({ ...item, label: memoryProviderLabel(item.key) }))} value={shown} onChange={(next) => void changeProvider(next)} disabled={busy} />
        <div className="sline">{statusText}</div>
        <SaveFeedback message={error ?? (saved ? t("已保存") : null)} />
      </Group>

      {shown === "lore" ? (
        <>
          <Group>
            <div className="formcard">
            <div className="lbl">{t("部署方式")}</div>
            <Seg items={DEPLOYMENTS.map((item) => ({ ...item, label: deploymentLabel(item.key) }))} value={deployment} onChange={chooseDeployment} disabled={busy} />
            <div className="lbl">{t("服务地址")}</div>
            {deployment === "saas" ? (
              <div className="field ro">{LORE_SAAS}</div>
            ) : (
              <div className="field">
                <input
                  value={baseUrl}
                  placeholder={t("自部署地址示例")}
                  onChange={(e) => edit(() => setBaseUrl(e.target.value))}
                  disabled={busy}
                />
              </div>
            )}
            <div className="lblrow">
              <span className="lbl">{t("Token")}</span>
              <a className="link" href={LORE_LINKS.saas} target="_blank" rel="noreferrer">
                {t("注册 / 登录 Lore")}
              </a>
            </div>
            <div className="field">
              <input
                type="password"
                value={token}
                placeholder={tokenKept ? t("已保存，留空不变") : "lm_…"}
                onChange={(e) => edit(() => setToken(e.target.value))}
                disabled={busy}
              />
            </div>
            <SaveRow saved={saved && !dirty} error={error} lead={<>
              <button className="hob-btn" onClick={() => void runTest()} disabled={busy || baseUrl.trim() === ""}>
                {t("测试连接")}
              </button>
              {test ? <span className={test.ok ? "okline" : "badline"}>{test.text}</span> : null}
            </>}>
              {!error && dirty ? <span className="note">{t("未保存的修改")}</span> : null}
              <button className="hob-btn" onClick={() => void loadMemory().then((r) => (r.ok ? reset(r.config) : setLoadError(r.error)))} disabled={busy || !dirty}>{t("取消")}</button>
              <button className="hob-btn hob-btn-primary" onClick={() => void commit()} disabled={busy || !dirty}>{busy ? t("正在验证…") : t("保存")}</button>
            </SaveRow>
            </div>
          </Group>

          <Group>
            <div className="lbl">{t("本机配置")}</div>
            <div className="ctl" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="hob-btn" onClick={() => void importFromLocal()} disabled={busy}>
                {busy ? t("正在导入…") : t("从本机导入")}
              </button>
              {loreImported ? <span className="okline">{t("已导入本机的连接")}</span> : null}
            </div>
            <div className="note">{t("读取这台电脑上已保存的 Lore 连接，导入后无需重新填写。")}</div>
            {loreSource ? <div className="sline">{t("来源：{source}", { source: loreSource.source })}</div> : null}
            {loreSource && !loreSource.found ? <div className="note">{t("未找到可导入的配置。")}</div> : null}
            {loreImportError ? <div className="badline">{loreImportError}</div> : null}
          </Group>
        </>
      ) : null}

    </>
  );
}

const IMAGE_SOURCE_KEYS: ImageSettings["source"][] = ["off", "openai"];
function imageSourceLabel(source: ImageSettings["source"]): string {
  return source === "off" ? t("关闭") : t("OpenAI 兼容接口");
}

/** 默认尺寸：不指定就交给服务自己定。 */
const IMAGE_SIZES = ["1024x1024", "1536x1024", "1024x1536", "512x512"];


/** 设置 → 图像生成：关闭或 OpenAI 兼容接口，并提供生成测试图片。 */
function KnowledgeSection() {
  const s = useApp();
  const saved = s.settings.settings.knowledge?.embedding ?? { source: "off" as const };
  const [source, setSource] = useState<EmbeddingSettings["source"]>(saved.source);
  const [baseUrl, setBaseUrl] = useState(saved.source === "openai" ? saved.baseUrl : "");
  const [model, setModel] = useState(saved.source === "openai" ? saved.model : "");
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => { void loadEmbeddingKey().then((value) => setConfigured(value.keyConfigured)).catch((e: unknown) => setMessage({ ok: false, text: t("读取设置失败：{error}", { error: e instanceof Error ? e.message : String(e) }) })); }, []);
  const form: EmbeddingSettings = source === "off" ? { source: "off" } : { source: "openai", baseUrl: normalizeBase(baseUrl), model: model.trim() };
  const run = async (save: boolean) => {
    setBusy(true); setMessage(null);
    try {
      if (save) {
        const result = await saveEmbedding(form, apiKey.trim() || undefined);
        setConfigured(result.keyConfigured); setApiKey(""); setMessage({ ok: true, text: t("已保存") });
      } else {
        const result = await testEmbedding({ embedding: form, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
        setMessage(result.ok ? { ok: true, text: t("连接成功 · {n} 维", { n: result.dims }) } : { ok: false, text: result.error });
      }
    } catch (e) { setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  return <>
    <PageHead title={t("知识库")} desc={t("配置向量模型，关闭时只按关键词查找。")} />
    <Group><div className="lbl">{t("向量模型")}</div><Seg items={IMAGE_SOURCE_KEYS.map((key) => ({ key, label: imageSourceLabel(key) }))} value={source} onChange={setSource} disabled={busy} /></Group>
    {source === "openai" ? <Group><div className="formcard">
      <div className="lbl">{t("服务地址")}</div><div className="field"><input aria-label={t("服务地址")} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={busy} placeholder="http://127.0.0.1:8080/v1" /></div>
      <div className="lbl">{t("模型名称")}</div><div className="field"><input aria-label={t("模型名称")} value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} /></div>
      <div className="lbl">{t("API Key")}</div><div className="field"><input aria-label="API Key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={busy} placeholder={configured ? t("已保存，留空不变") : t("请输入 API Key")} /></div>
      <SaveRow saved={message?.text === t("已保存")} error={null} lead={<>
        <button className="hob-btn" disabled={busy} onClick={() => void run(false)}>{t("测试连接")}</button>
        {message && message.text !== t("已保存") ? <span className={message.ok ? "okline" : "badline"} role="status">{message.text}</span> : null}
      </>}><button className="hob-btn hob-btn-primary" disabled={busy} onClick={() => void run(true)}>{t("保存")}</button></SaveRow>
    </div><div className="note">{t("建索引和查询时，文件内容和问题会发给这个接口。")}</div></Group> : <SaveRow saved={message?.text === t("已保存")} error={message?.ok === false ? message.text : null}><button className="hob-btn hob-btn-primary" disabled={busy} onClick={() => void run(true)}>{t("保存")}</button></SaveRow>}
  </>;
}

function ImageSection() {
  const s = useApp();
  const saved = s.settings.settings.image;
  const [source, setSource] = useState<ImageSettings["source"]>(saved.source);
  const [baseUrl, setBaseUrl] = useState(saved.source === "openai" ? saved.baseUrl : "");
  const [model, setModel] = useState(saved.source === "openai" ? saved.model : "");
  const [size, setSize] = useState(saved.source === "openai" ? (saved.size ?? "") : "");
  const [apiKey, setApiKey] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string; path?: string } | null>(null);
  const [testedForm, setTestedForm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedNote, setSavedNote] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!savedNote) return;
    const timer = setTimeout(() => setSavedNote(false), 3000);
    return () => clearTimeout(timer);
  }, [savedNote]);
  useEffect(() => {
    void loadImageKey().then((result) => {
      if (result) setKeyConfigured(result.keyConfigured);
    });
  }, []);

  const form: ImageSettings =
    source === "openai"
      ? {
          source: "openai",
          baseUrl: normalizeBase(baseUrl),
          model: model.trim(),
          ...(size ? { size } : {}),
        }
      : { source: "off" };
  const dirty = JSON.stringify(form) !== JSON.stringify(saved) || apiKey.trim() !== "";
  const fingerprint = JSON.stringify({ form, apiKey: apiKey.trim() });
  useEffect(() => {
    setTest(null);
    setTestedForm(null);
  }, [fingerprint]);

  const runTest = async () => {
    if (busy) return;
    setBusy(true);
    setTest(null);
    const outcome = await testImage({
      image: form,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    setBusy(false);
    if (outcome.ok) {
      setTestedForm(fingerprint);
      setTest({ ok: true, text: t("生成成功"), path: outcome.path });
    } else {
      setTestedForm(null);
      setTest({ ok: false, text: outcome.error });
    }
  };

  const commit = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    setSavedNote(false);
    if (form.source === "openai" && testedForm !== fingerprint) {
      const tested = await testImage({ image: form, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      if (!tested.ok) {
        setBusy(false);
        setTestedForm(null);
        setError(t("测试连接失败：{error}", { error: tested.error }));
        return;
      }
      setTestedForm(fingerprint);
      setTest({ ok: true, text: t("生成成功"), path: tested.path });
    }
    const result = await saveImage(form, apiKey.trim() || undefined);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    // 存进去的是去掉空格、去掉尾部斜杠的版本，本地表单跟着对齐，别显示成“还没保存”
    if (form.source === "openai") {
      setBaseUrl(form.baseUrl);
      setModel(form.model);
    }
    setApiKey("");
    setKeyConfigured(result.keyConfigured);
    setTest(null);
    setSavedNote(true);
  };

  return (
    <>
      <PageHead
        title={t("图像生成")}
        desc={t("选择图像生成方式：关闭，或使用 OpenAI 兼容接口。配置完成后，开启了图像生成能力的助手可以在任务中生成图片。")}
      />

      <Group>
        <div className="lbl">{t("生成方式")}</div>
        <Seg
          items={IMAGE_SOURCE_KEYS.map((key) => ({ key, label: imageSourceLabel(key) }))}
          value={source}
          onChange={(key) => {
            setTest(null);
            setError(null);
            setSavedNote(false);
            if (key === "off" && saved.source !== "off") {
              setBusy(true);
              void saveImage({ source: "off" }).then((result) => {
                setBusy(false);
                if (!result.ok) { setError(result.error); return; }
                setSource("off");
                setApiKey("");
                setSavedNote(true);
              });
            } else setSource(key);
          }}
          disabled={busy}
        />
      </Group>

      {source === "openai" ? (
        <Group>
          <div className="formcard">
          <div className="lbl">{t("服务地址")}</div>
          <div className="field">
            <input
              value={baseUrl}
              placeholder="http://127.0.0.1:8080/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="lbl">{t("模型名称")}</div>
          <div className="field">
            <input
              value={model}
              placeholder="gpt-image-1"
              onChange={(e) => setModel(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="lbl">{t("默认尺寸")}</div>
          <div className="ctl">
            <Select className="grow" value={size} onChange={setSize} disabled={busy} options={[{ value: "", label: t("不指定，使用接口默认值") }, ...IMAGE_SIZES.map((item) => ({ value: item, label: item }))]} />
          </div>
          <div className="lbl">{t("API Key")}</div>
          <div className="field">
            <input
              type="password"
              value={apiKey}
              placeholder={keyConfigured ? t("已保存，留空不变") : "sk-…"}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="note">
            {t("API Key 只保存在本机，保存后不再显示。保存前会生成测试图片，可能产生费用。")}
          </div>
          {test ? (
          <div className="testrow">
            {test ? (
              <div className="testout">
                <span className={test.ok ? "okline" : "badline"}>{test.text}</span>
                {test.ok && test.path ? (
                  <button
                    className="imgcard testshot"
                    onClick={() => window.open(fileUrl(test.path!), "_blank", "noopener")}
                    title={t("查看原图")}
                  >
                    <img src={fileUrl(test.path)} alt={t("生成的图片")} />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          ) : null}
      <SaveRow saved={savedNote && !dirty} error={error} lead={<button className="hob-btn" onClick={() => void runTest()} disabled={busy}>{busy ? t("正在生成…") : t("生成测试图片")}</button>}>
        {!error && dirty ? <span className="note">{t("未保存的修改")}</span> : null}
        <button className="hob-btn" disabled={busy || !dirty} onClick={() => {
          setSource(saved.source);
          setBaseUrl(saved.source === "openai" ? saved.baseUrl : "");
          setModel(saved.source === "openai" ? saved.model : "");
          setSize(saved.source === "openai" ? saved.size ?? "" : "");
          setApiKey("");
          setTest(null);
          setTestedForm(null);
          setError(null);
        }}>{t("取消")}</button>
        <button className="hob-btn hob-btn-primary" onClick={() => void commit()} disabled={busy || !dirty}>
          {busy ? t("正在验证…") : t("保存")}
        </button>
      </SaveRow>
          </div>
        </Group>
      ) : <SaveFeedback message={error ?? (savedNote ? t("已保存") : null)} />}
    </>
  );
}

function skillSourceLabel(source: SkillView["source"]): string {
  if (source === "hob") return t("Hob 的技能");
  if (source === "common") return t("本机技能");
  return t("Lore 技能");
}
const SKILL_IMPORT_SOURCES: { key: SkillImportSource; label: string }[] = [
  { key: "claude", label: "Claude Code" },
  { key: "codex", label: "Codex" },
  { key: "pi", label: "pi" },
];
const skillKey = (skill: SkillView) => `${skill.source}:${skill.id}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 技能页：三组列表（Hob / Lore / 本机），整行点进详情，行尾是启用开关；导入和详情是子页。 */
function SkillsSection() {
  const state = useApp();
  const sub = state.sub;
  const [view, setView] = useState<SkillsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = async () => {
    try { setView(await loadSkills()); setError(null); } catch (e) { setError(errText(e)); }
  };
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { if (sub) setNotice(null); }, [sub]);
  const toggle = async (skill: SkillView) => {
    const key = `${skill.source}:${skill.name}`;
    const current = state.settings.settings.skills?.disabled ?? [];
    const disabled = skill.enabled ? [...current, key] : current.filter((item) => item !== key);
    if (await saveSettings({ skills: { disabled } })) await refresh(); else setError(getState().notice ?? t("保存失败"));
  };
  const done = (message: string) => { void refresh(); setNotice(message); closeSub(); };

  if (!view) return error ? <div className="badline">{error}</div> : <Empty>{t("正在读取技能…")}</Empty>;
  if (sub?.kind === "skill") return <SkillDetail skill={view.skills.find((skill) => skillKey(skill) === sub.key)} onDeleted={done} onRolledBack={() => void refresh()} />;
  if (sub?.kind === "importSkills") return <ImportSkills onDone={done} />;

  const rows = (skills: SkillView[], empty: string) =>
    skills.length ? skills.map((skill) => (
      <div className={`list-row setting-row${skill.enabled ? "" : " gone"}`} key={skillKey(skill)}>
        <button className="rmain rbtn" onClick={() => openSub({ kind: "skill", key: skillKey(skill), title: skill.title || skill.name })}>
          <div className="rname">
            {skill.title || skill.name}
            {skill.version ? <span className="rtag">{t("第 {version} 版", { version: skill.version })}</span> : null}
            {skill.overridden ? <span className="rtag">{t("被同名技能覆盖")}</span> : null}
          </div>
          <div className="rprov rclamp">
            {skill.updatedAt ? `${fmtWhen(skill.updatedAt)} · ` : ""}
            {skill.name !== (skill.title || skill.name) ? `${skill.name} · ` : ""}
            {skill.description}{skillOriginText(skill, state) ? ` · ${skillOriginText(skill, state)}` : ""}
          </div>
        </button>
        <button className={`tog${skill.enabled ? "" : " off"}`} aria-label={t("{name}启用", { name: skill.name })} aria-pressed={skill.enabled} onClick={() => void toggle(skill)} />
      </div>
    )) : <Empty>{empty}</Empty>;
  const hob = view.skills.filter((x) => x.source === "hob");
  return (
    <>
      <PageHead title={t("技能")} desc={t("这里的技能所有助手都能用，任务按需读取。助手也能改 Hob 的技能；Lore 和本机目录里的只读，去原处改。同名时 Hob 的技能优先，其次是 Lore，最后是本机目录。")} />
      <Group>
        <div className="lbl">{t("Hob 的技能")}</div>
        <div className="group-card settings-card">
          {rows(hob, t("还没有技能，可以从其他工具导入"))}
          <button className="maddrow" onClick={() => openSub({ kind: "importSkills", title: t("导入技能") })}>
            <Icon name="plus" size={16} />
            {t("从 Claude Code、Codex、pi 导入")}
          </button>
        </div>
        {notice ? <div className="okline">{notice}</div> : null}
      </Group>
      <Group>
        <div className="lbl">{t("Lore 技能")}{view.loreActive && view.loreUrl ? <a className="lbl-aside" href={view.loreUrl} target="_blank" rel="noreferrer">{t("在 Lore 控制台管理")}</a> : null}</div>
        {view.loreError ? <div className="badline" role="alert">{view.loreError} <button onClick={() => void refresh()}>{t("重试")}</button></div>
          : view.loreActive
          ? <div className="group-card settings-card">{rows(view.skills.filter((x) => x.source === "lore"), t("Lore 中没有技能"))}</div>
          : <div className="note">{t("在 设置 → 记忆 中连接 Lore 后，这里会列出 Lore 中的技能。")}</div>}
      </Group>
      <Group>
        <div className="lbl">{t("本机技能")} <span className="lbl-aside">~/.agents/skills</span></div>
        <div className="group-card settings-card">{rows(view.skills.filter((x) => x.source === "common"), t("目录中没有技能"))}</div>
      </Group>
      {error ? <div className="badline" role="alert">{error}</div> : null}
    </>
  );
}

function SkillDetail({ skill, onDeleted, onRolledBack }: { skill: SkillView | undefined; onDeleted: (message: string) => void; onRolledBack: () => void }) {
  const [error, setError] = useState<string | null>(null);
  if (!skill) return <><SubBack label={t("技能")} /><div className="note">{t("技能不存在或已删除。")}</div></>;
  const remove = async () => {
    if (!window.confirm(t("把技能「{name}」移到归档？它将不再出现在技能列表中，文件仍保留在归档目录。", { name: skill.title || skill.name }))) return;
    try { await deleteSkill(skill.name); onDeleted(t("已把「{name}」移到归档", { name: skill.title || skill.name })); } catch (e) { setError(errText(e)); }
  };
  const rollback = async () => {
    if (!window.confirm(t("把技能「{name}」回退到上一版？当前版本将保留在历史记录中。", { name: skill.title || skill.name }))) return;
    try { await rollbackGeneralSkill(skill.name); setError(null); onRolledBack(); } catch (e) { setError(errText(e)); }
  };
  return (
    <>
      <SubBack label={t("技能")} />
      <PageHead title={skill.title || skill.name} desc={skill.description} />
      <div className="sline">{skillSourceLabel(skill.source)}{skill.version ? t(" · 第 {version} 版", { version: skill.version }) : ""}{skill.updatedAt ? t(" · {when} 更新", { when: fmtWhen(skill.updatedAt) }) : ""}{skill.overridden ? t(" · 被优先级更高的同名技能覆盖") : ""}{skill.enabled ? "" : t(" · 已停用")}</div>
      <Markdown className="skill-doc fp-md markdown-body" text={skill.content} />
      {skill.source === "hob" ? (
        <SaveRow saved={false} error={error}>
          {skill.rollbackable ? <button className="hob-btn" onClick={() => void rollback()}>{t("回退到上一版")}</button> : null}
          <button className="hob-btn hob-btn-danger" onClick={() => void remove()}>{t("移到归档")}</button>
        </SaveRow>
      ) : null}
    </>
  );
}

function ImportSkills({ onDone }: { onDone: (message: string) => void }) {
  const [source, setSource] = useState<SkillImportSource>("claude");
  const [view, setView] = useState<SkillImportView | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setView(null); setChosen([]); setError(null);
    void loadSkillImports(source).then((next) => { if (live) setView(next); }).catch((e) => { if (live) setError(errText(e)); });
    return () => { live = false; };
  }, [source]);
  const commit = async () => {
    setBusy(true); setError(null);
    try {
      const result = await importSelectedSkills(source, chosen, overwrite);
      const problems = [...result.skipped, ...result.errors];
      if (problems.length) setError(problems.join(t("；")));
      else onDone(t("已导入 {n} 个技能", { n: result.imported.length }));
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <SubBack label={t("技能")} />
      <PageHead title={t("导入技能")} desc={t("从其他工具的技能目录复制到 Hob，来源只读。")} />
      <Group>
        <Seg items={SKILL_IMPORT_SOURCES} value={source} onChange={setSource} disabled={busy} />
      </Group>
      <Group>
        {view === null ? (error ? null : <Empty>{t("正在读取…")}</Empty>) : !view.found ? (
          <Empty>{t("未找到这个工具的技能目录。")}</Empty>
        ) : (
          <div className="group-card settings-card">
            {view.skills.length ? view.skills.map((skill) => (
              <label className="list-row setting-row" key={skill.id}>
                <input type="checkbox" className="rcheck" checked={chosen.includes(skill.id)} disabled={busy}
                  onChange={(e) => setChosen(e.target.checked ? [...chosen, skill.id] : chosen.filter((id) => id !== skill.id))} />
                <div className="rmain">
                  <div className="rname">{skill.name}{skill.exists ? <span className="rtag">{t("已存在")}</span> : null}</div>
                  <div className="rprov rclamp">{skill.description}</div>
                </div>
              </label>
            )) : <Empty>{t("目录中没有技能")}</Empty>}
          </div>
        )}
        {view?.skipped.map((message) => <div className="note" key={message}>{message}</div>)}
      </Group>
      {view?.skills.some((skill) => skill.exists) ? (
        <label className="ctl skill-overwrite">
          <input type="checkbox" className="rcheck" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          {t("覆盖已存在的同名技能")}
        </label>
      ) : null}
      <SaveRow saved={false} error={error}>
        <button className="hob-btn" onClick={closeSub} disabled={busy}>{t("取消")}</button>
        <button className="hob-btn hob-btn-primary" disabled={busy || !chosen.length} onClick={() => void commit()}>{busy ? t("正在导入…") : chosen.length ? t("导入 {n} 个", { n: chosen.length }) : t("导入所选")}</button>
      </SaveRow>
    </>
  );
}

/* ---------------- MCP ---------------- */

/** MCP 页：列表 → 详情 / 添加 / 从本机导入（照服务商页的三层结构）。 */
const SEARCH_INFO: Record<SearchProviderName, { label: string; url?: boolean; keyOptional?: boolean }> = {
  searxng: { label: "SearXNG", url: true, keyOptional: true },
  exa: { label: "Exa" },
  tavily: { label: "Tavily" },
  brave: { label: "Brave Search" },
  serper: { label: "Serper" },
  jina: { label: "Jina" },
  firecrawl: { label: "Firecrawl" },
  perplexity: { label: "Perplexity" },
  youcom: { label: "You.com" },
  ollama: { label: "Ollama", url: true },
  openai: { label: "OpenAI", url: true },
};
function searchDesc(name: SearchProviderName): string {
  switch (name) {
    case "searxng": return t("自建的元搜索服务，填写服务地址即可");
    case "exa": return t("语义搜索，适合查找技术资料");
    case "tavily": return t("面向 AI 的搜索接口");
    case "brave": return t("Brave 的独立网页索引");
    case "serper": return t("Google 搜索结果");
    case "jina": return t("搜索并读取网页正文");
    case "firecrawl": return t("搜索并抓取网页正文");
    case "perplexity": return t("带摘要的搜索结果");
    case "youcom": return t("You.com 搜索接口");
    case "ollama": return t("Ollama 的网页搜索");
    case "openai": return t("使用 OpenAI Responses API 原生联网搜索，可复用已有 OpenAI 服务商");
  }
}

function isReusableOpenAIProvider(p: ProviderSettings): boolean {
  return (p.kind === "builtin" && p.id === "openai") || (p.kind === "custom" && p.api === "openai-responses");
}

/** 联网搜索页：上面是已启用的（按顺序使用，可上下移），下面是其余服务商；整行点进详情配置。 */
function SearchSection() {
  const s = useApp();
  const sub = s.sub;
  const providers = s.settings.settings.search;
  const modelProviders = s.settings.settings.providers;
  const [view, setView] = useState<SearchView | null>(null);
  const [providersView, setProvidersView] = useState<ProvidersView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => setView(await loadSearch());
  useEffect(() => {
    void refresh().catch((e) => setNotice(errText(e)));
    void loadProviders().then((res) => { if (res.ok) setProvidersView(res.view); });
  }, []);
  useEffect(() => { if (sub) setNotice(null); }, [sub]);
  const reusableOpenAI: ProviderView[] = (
    providersView?.providers ?? modelProviders.map((p) => ({ ...p, keyConfigured: false }))
  ).filter(isReusableOpenAIProvider);
  const viewItem = (name: SearchProviderName) => view?.providers.find((p) => p.name === name);
  const configured = (name: SearchProviderName) => viewItem(name)?.keyConfigured ?? false;
  const persist = async (next: SearchProviderSetting[], keys?: Record<string, string>) => {
    setBusy(true);
    try {
      const error = await saveSearch(next, keys);
      if (error) { setNotice(error); return error; }
      await refresh(); return null;
    } catch (e) { const message = errText(e); setNotice(message); return message; }
    finally { setBusy(false); }
  };
  const enabled = providers.filter((p) => p.enabled);
  const move = (name: SearchProviderName, delta: number) => {
    const order = enabled.map((p) => p.name);
    const index = order.indexOf(name);
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    [order[index], order[target]] = [order[target], order[index]];
    void persist([...order.map((n) => providers.find((p) => p.name === n)!), ...providers.filter((p) => !p.enabled)]);
  };

  if (sub?.kind === "searchProvider") {
    const provider = providers.find((p) => p.name === sub.name);
    if (!provider) return <><SubBack label={t("联网搜索")} /><div className="note">{t("没有这个服务商。")}</div></>;
    const saveOne = (next: SearchProviderSetting, key?: string) =>
      persist(providers.map((p) => (p.name === next.name ? next : p)), key === undefined ? undefined : { [next.name]: key });
    if (provider.name === "openai") {
      return <OpenAISearchDetail provider={provider} viewItem={viewItem("openai")} reusableProviders={reusableOpenAI} busy={busy} save={saveOne} />;
    }
    return <SearchProviderDetail provider={provider} configured={configured(provider.name)} busy={busy} save={saveOne} />;
  }

  const status = (p: SearchProviderSetting) => {
    if (p.name === "openai") {
      const item = viewItem("openai");
      if (p.providerId) {
        const matched = modelProviders.find((mp) => mp.id === p.providerId && isReusableOpenAIProvider(mp));
        if (!matched || item?.resolvedProviderMissing || !item?.keyConfigured) return t("服务商未就绪");
        const label = matched.kind === "builtin" ? "OpenAI" : matched.name;
        return t("复用 {name}", { name: label });
      }
      return item?.keyConfigured ? t("已配置 Key") : p.baseUrl ? t("已填服务地址") : t("未配置");
    }
    return configured(p.name) ? t("已配置 Key") : p.baseUrl ? t("已填服务地址") : t("未配置");
  };
  return (
    <>
      <PageHead title={t("联网搜索")} desc={t("助手和任务通过这里的服务商搜索网页、读取正文。可以启用多个，按顺序使用，前一个失败时自动换下一个。")} />
      <Group>
        <div className="lbl">{t("已启用")}</div>
        {enabled.length ? (
          <div className="group-card settings-card">
            {enabled.map((p, index) => (
              <div className="list-row setting-row" key={p.name}>
                <span className="rorder">{index + 1}</span>
                <button className="rmain rbtn" onClick={() => openSub({ kind: "searchProvider", name: p.name, title: SEARCH_INFO[p.name].label })}>
                  <div className="rname">{SEARCH_INFO[p.name].label}</div>
                  <div className="rprov">{searchDesc(p.name)}</div>
                </button>
                <button className="hob-icon-btn rmove" title={t("上移")} disabled={busy || index === 0} onClick={() => move(p.name, -1)}><Icon name="down" size={15} className="up" /></button>
                <button className="hob-icon-btn rmove" title={t("下移")} disabled={busy || index === enabled.length - 1} onClick={() => move(p.name, 1)}><Icon name="down" size={15} /></button>
              </div>
            ))}
          </div>
        ) : <div className="note">{t("尚未启用服务商，助手和任务暂时不能联网搜索。")}</div>}
        {notice ? <div className="badline">{notice}</div> : null}
      </Group>
      <Group>
        <div className="lbl">{enabled.length ? t("其他服务商") : t("选择服务商")}</div>
        <div className="group-card settings-card">
          {providers.filter((p) => !p.enabled).map((p) => (
            <button className="list-row setting-row" key={p.name} onClick={() => openSub({ kind: "searchProvider", name: p.name, title: SEARCH_INFO[p.name].label })}>
              <div className="rmain">
                <div className="rname">{SEARCH_INFO[p.name].label}</div>
                <div className="rprov">{searchDesc(p.name)}</div>
              </div>
              <span className="note">{status(p)}</span>
              <Icon name="chev" size={15} className="rgo" />
            </button>
          ))}
        </div>
      </Group>
    </>
  );
}

function OpenAISearchDetail({
  provider,
  viewItem,
  reusableProviders,
  busy,
  save,
}: {
  provider: SearchProviderSetting;
  viewItem?: SearchProviderView;
  reusableProviders: ProviderView[];
  busy: boolean;
  save: (p: SearchProviderSetting, key?: string) => Promise<string | null>;
}) {
  const standaloneConfigured = viewItem?.standaloneKeyConfigured ?? (!provider.providerId && Boolean(viewItem?.keyConfigured));
  const [sourceId, setSourceId] = useState(provider.providerId ?? "");
  const [sourceTouched, setSourceTouched] = useState(false);
  const [model, setModel] = useState(provider.model ?? "");
  const [url, setUrl] = useState(provider.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => { setSourceId(provider.providerId ?? ""); setSourceTouched(false); }, [provider.providerId]);
  useEffect(() => setModel(provider.model ?? ""), [provider.model]);
  useEffect(() => setUrl(provider.baseUrl ?? ""), [provider.baseUrl]);
  // 首次尚未配置独立地址/Key 时，若已有可用的 OpenAI 服务商则默认选中复用模式
  useEffect(() => {
    if (sourceTouched || provider.providerId || provider.baseUrl || standaloneConfigured || sourceId) return;
    const preferred = reusableProviders.find((p) => p.keyConfigured);
    if (preferred) setSourceId(preferred.id);
  }, [reusableProviders, sourceTouched, provider.providerId, provider.baseUrl, standaloneConfigured, sourceId]);

  const selectedReusable = sourceId ? reusableProviders.find((p) => p.id === sourceId) : undefined;
  const reuseMissing = Boolean(sourceId && !selectedReusable);
  const reuseNoKey = Boolean(sourceId && selectedReusable && !selectedReusable.keyConfigured);
  const reuseInvalid = reuseMissing || reuseNoKey;

  const sourceOptions = [
    ...reusableProviders.map((p) => ({
      value: p.id,
      label: p.kind === "builtin" ? t("复用：OpenAI（内置）") : t("复用：{name}", { name: p.name }),
      meta: p.keyConfigured ? undefined : t("未配置 Key"),
    })),
    ...(reuseMissing ? [{ value: sourceId, label: t("已移除的服务商（{id}）", { id: sourceId }) }] : []),
    { value: "", label: t("自定义配置（单独填写地址和 Key）") },
  ];

  const dirty = sourceId !== (provider.providerId ?? "")
    || model.trim() !== (provider.model ?? "")
    || (!sourceId && (url.trim() !== (provider.baseUrl ?? "") || !!key.trim()));
  const savedReady = provider.providerId
    ? Boolean(!viewItem?.resolvedProviderMissing && viewItem?.keyConfigured)
    : standaloneConfigured;
  const canToggleEnable = provider.enabled || (savedReady && !dirty);

  const customModels = selectedReusable?.kind === "custom" ? selectedReusable.models.map((m) => m.id) : [];
  const effectiveModel = model.trim() || DEFAULT_OPENAI_SEARCH_MODEL;
  const showCustomModelsHint = customModels.length > 0 && !customModels.includes(effectiveModel);

  const runTest = async () => {
    setTesting(true); setTest(null);
    try {
      const result = await testSearch(
        "openai",
        sourceId ? "" : url.trim(),
        sourceId ? undefined : (key.trim() || undefined),
        { providerId: sourceId, model: model.trim() },
      );
      setTest({ ok: result.ok, text: result.ok ? t("搜索成功，返回 {n} 条结果", { n: result.count ?? 0 }) : result.error ?? t("搜索失败") });
      return result.ok;
    } catch (e) { setTest({ ok: false, text: errText(e) }); return false; }
    finally { setTesting(false); }
  };

  const apply = async (next: SearchProviderSetting, nextKey?: string) => {
    setError(null); setSaved(false);
    const message = await save(next, nextKey);
    if (message) { setError(message); return false; }
    setSaved(true); return true;
  };

  const commit = async () => {
    if (await runTest()) {
      const next: SearchProviderSetting = {
        ...provider,
        providerId: sourceId || undefined,
        model: model.trim() || undefined,
        baseUrl: sourceId ? undefined : (url.trim() || undefined),
      };
      if (await apply(next, !sourceId && key.trim() ? key.trim() : undefined)) setKey("");
    }
  };

  return (
    <>
      <SubBack label={t("联网搜索")} />
      <PageHead title="OpenAI" desc={searchDesc("openai")} />
      <Group>
        <div className="ctl">
          <span style={{ fontSize: 14 }}>{t("启用")}</span>
          <span className="sp" />
          <button
            className={`tog${provider.enabled ? "" : " off"}`}
            aria-label={t("{name}启用", { name: "OpenAI" })}
            aria-pressed={provider.enabled}
            disabled={busy || !canToggleEnable}
            onClick={() => void apply({ ...provider, enabled: !provider.enabled })}
          />
        </div>
        {!provider.enabled && !canToggleEnable ? (
          <div className="note">
            {reusableProviders.length ? t("选择可用服务商或填写 API Key 并保存后即可启用。") : t("填写 API Key 并保存后即可启用。")}
          </div>
        ) : null}
      </Group>
      <Group>
        <div className="formcard">
          <div className="lbl">{t("服务商来源")}</div>
          <div className="field">
            <Select
              className="grow"
              aria-label={t("服务商来源")}
              value={sourceId}
              disabled={busy}
              onChange={(value) => { setSourceId(value); setSourceTouched(true); setTest(null); }}
              options={sourceOptions}
            />
          </div>
          {!reusableProviders.length && !sourceId ? (
            <div className="note">{t("尚未在「设置 → 服务商」配置 OpenAI 或 OpenAI Responses 服务商，可先前往添加，或直接使用下方自定义配置。")}</div>
          ) : null}
          {reuseInvalid ? (
            <div className="badline">{t("所选 OpenAI 服务商已移除或未配置 Key，请重新选择或改用自定义配置。")}</div>
          ) : null}

          <div className="lbl">{t("模型名称")}</div>
          <div className="field">
            <input
              value={model}
              onChange={(e) => { setModel(e.target.value); setTest(null); }}
              placeholder={DEFAULT_OPENAI_SEARCH_MODEL}
              disabled={busy}
            />
          </div>
          <div className="note">{t("建议使用轻量模型（如 gpt-4.1-mini、gpt-4o-mini）以控制延迟和费用。")}</div>
          {showCustomModelsHint ? (
            <div className="note">{t("当前服务商配置的模型：{models}。", { models: customModels.slice(0, 6).join(", ") })}</div>
          ) : null}

          {!sourceId ? (
            <>
              <div className="lbl">{t("服务地址")}</div>
              <div className="field">
                <input
                  value={url}
                  onChange={(e) => { setUrl(e.target.value); setTest(null); }}
                  placeholder={DEFAULT_OPENAI_SEARCH_BASE_URL}
                  disabled={busy}
                />
              </div>
              <div className="lbl">{t("API Key")}</div>
              <div className="field">
                <input
                  type="password"
                  value={key}
                  onChange={(e) => { setKey(e.target.value); setTest(null); }}
                  placeholder={standaloneConfigured ? t("已保存，留空不变") : t("填写 API Key")}
                  disabled={busy}
                />
              </div>
              <div className="note">{t("API Key 只保存在本机，保存后不再显示。")}</div>
            </>
          ) : null}

          <div className="testrow">
            <button className="hob-btn" onClick={() => void runTest()} disabled={busy || testing}>{testing ? t("正在搜索…") : t("测试搜索")}</button>
            {test ? <span className={test.ok ? "okline" : "badline"}>{test.text}</span> : null}
          </div>
          <SaveRow saved={saved && !dirty} error={error}>
            {!sourceId && standaloneConfigured ? <button className="hob-btn" disabled={busy} onClick={() => void apply(provider, "")}>{t("删除 Key")}</button> : null}
            <button className="hob-btn hob-btn-primary" disabled={busy || testing || !dirty} onClick={() => void commit()}>{t("保存")}</button>
          </SaveRow>
          <div className="note">{t("按 OpenAI API 用量计费（含模型 token 与联网搜索调用费）；自定义服务地址需支持 Responses API（/v1/responses）。")}</div>
        </div>
      </Group>
    </>
  );
}

function SearchProviderDetail({ provider, configured, busy, save }: { provider: SearchProviderSetting; configured: boolean; busy: boolean; save: (p: SearchProviderSetting, key?: string) => Promise<string | null> }) {
  const info = SEARCH_INFO[provider.name];
  const [url, setUrl] = useState(provider.baseUrl ?? "");
  const [key, setKey] = useState("");
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setUrl(provider.baseUrl ?? ""), [provider.baseUrl]);
  const dirty = url.trim() !== (provider.baseUrl ?? "") || !!key.trim();
  const ready = configured || !!key.trim() || (info.keyOptional && !!url.trim());
  const runTest = async () => {
    setTesting(true); setTest(null);
    try {
      const result = await testSearch(provider.name, url.trim(), key.trim() || undefined);
      setTest({ ok: result.ok, text: result.ok ? t("搜索成功，返回 {n} 条结果", { n: result.count ?? 0 }) : result.error ?? t("搜索失败") });
      return result.ok;
    } catch (e) { setTest({ ok: false, text: errText(e) }); return false; }
    finally { setTesting(false); }
  };
  const apply = async (next: SearchProviderSetting, nextKey?: string) => {
    setError(null); setSaved(false);
    const message = await save(next, nextKey);
    if (message) { setError(message); return false; }
    setSaved(true); return true;
  };
  const commit = async () => { if (await runTest() && await apply({ ...provider, baseUrl: url.trim() || undefined }, key.trim() || undefined)) setKey(""); };
  return (
    <>
      <SubBack label={t("联网搜索")} />
      <PageHead title={info.label} desc={searchDesc(provider.name)} />
      <Group>
        <div className="ctl">
          <span style={{ fontSize: 14 }}>{t("启用")}</span>
          <span className="sp" />
          <button className={`tog${provider.enabled ? "" : " off"}`} aria-label={t("{name}启用", { name: info.label })} aria-pressed={provider.enabled}
            disabled={busy || (!provider.enabled && !ready)} onClick={() => void apply({ ...provider, enabled: !provider.enabled })} />
        </div>
        {!provider.enabled && !ready ? <div className="note">{info.url ? t("填写服务地址") : t("填写 API Key")}{t("并保存后即可启用。")}</div> : null}
      </Group>
      <Group>
        <div className="formcard">
          {info.url ? (
            <>
              <div className="lbl">{t("服务地址")}</div>
              <div className="field"><input value={url} onChange={(e) => { setUrl(e.target.value); setTest(null); }} placeholder="http://127.0.0.1:8888" disabled={busy} /></div>
            </>
          ) : null}
          <div className="lbl">{t("API Key")}{info.keyOptional ? t("（可选）") : ""}</div>
          <div className="field">
            <input type="password" value={key} onChange={(e) => { setKey(e.target.value); setTest(null); }} placeholder={configured ? t("已保存，留空不变") : t("填写 API Key")} disabled={busy} />
          </div>
          <div className="note">{t("API Key 只保存在本机，保存后不再显示。")}</div>
          <div className="testrow">
            <button className="hob-btn" onClick={() => void runTest()} disabled={busy || testing}>{testing ? t("正在搜索…") : t("测试搜索")}</button>
            {test ? <span className={test.ok ? "okline" : "badline"}>{test.text}</span> : null}
          </div>
          <SaveRow saved={saved && !dirty} error={error}>
            {configured ? <button className="hob-btn" disabled={busy} onClick={() => void apply(provider, "")}>{t("删除 Key")}</button> : null}
            <button className="hob-btn hob-btn-primary" disabled={busy || testing || !dirty} onClick={() => void commit()}>{t("保存")}</button>
          </SaveRow>
        </div>
      </Group>
    </>
  );
}

const REPO_URL = "https://github.com/FFatTiger/hob";

/** 关于页：版本、更新状态、数据目录，以及仓库入口。 */
export function AboutView({ about }: { about: AboutInfo | null }) {
  if (!about) return <Empty>{t("正在读取版本信息…")}</Empty>;
  const update = about.update;
  return (
    <>
      <PageHead title={t("关于")} desc={t("Hob 的版本与数据目录。")} />
      <div className="kvcard">
        <div className="kvrow">
          <span className="k">{t("Hob 版本")}</span>
          <span className="v">{about.version}</span>
        </div>
        {update?.status === "available" ? (
          <a className="kvrow linkrow" href={`${REPO_URL}/releases/tag/v${update.latest}`} target="_blank" rel="noreferrer">
            <span className="k update-available">{t("有新版本 {version}", { version: update.latest })}</span>
            <span className="v">
              <span className="link">{t("查看更新内容")}</span>
              <Icon name="out" size={13} />
            </span>
          </a>
        ) : update?.status === "up-to-date" ? (
          <div className="kvrow">
            <span className="k update-status">{t("已是最新版本")}</span>
          </div>
        ) : update?.status === "error" ? (
          <div className="kvrow">
            <span className="k update-status update-error">{t("检查更新失败：{reason}", { reason: update.error })}</span>
          </div>
        ) : null}
        <div className="kvrow">
          <span className="k">{t("数据目录")}</span>
          <span className="v">{about.home}</span>
        </div>
        <LinkRow icon="github" label="GitHub" value="FFatTiger/hob" href={REPO_URL} />
      </div>
    </>
  );
}

function AboutSection() {
  const s = useApp();
  const [about, setAbout] = useState<AboutInfo | null>(null);
  useEffect(() => {
    void loadAbout().then(setAbout);
  }, []);
  const current = about ? { ...about, ...(s.update ? { update: s.update } : {}) } : null;
  return <AboutView about={current} />;
}
