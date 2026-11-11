// 设置整页：桌面左侧分栏导航 + 右侧内容，手机先列表再进入。
import { Select } from "./Select.tsx";
import { DelayedText, Empty } from "./Empty.tsx";
import { SaveMessage, useSaveMessage } from "./SaveMessage.tsx";
import { Fragment, Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";
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
  ThinkingLevelMapSetting,
} from "../../../shared/types.ts";
import type { SearchProviderName, SearchProviderSetting, SearchView } from "../../../shared/search.ts";
import type { McpImportView, McpSecretMutation, McpServerView, McpTestResult, McpView } from "../../../shared/mcp.ts";
import type { SkillImportSource, SkillImportView, SkillsView, SkillView } from "../../../shared/skills.ts";
import { Markdown } from "./Markdown.tsx";
const DesktopScreen = lazy(() => import("./DesktopView.tsx").then((module) => ({ default: module.DesktopView })) );
import { SCORE_STAGES, contextText, guessModelScores, scoreLabel, scoreSummary } from "../../../shared/model-note.ts";
import { THINKING_TEXT } from "../../../shared/thinking.ts";
import { Icon, type IconName } from "../icons.tsx";
import { filterModels, fitThinking, groupByProvider, THINKING_ORDER, thinkingLevels } from "../model-list.ts";
import { currentSubscription, pushSupported } from "../push.ts";
import { fmtWhen } from "../util.ts";
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
  loadMcp,
  loadDesktop,
  saveDesktop,
  saveDesktopPublic,
  testDesktop,
  putMcpServer,
  patchMcpServer,
  deleteMcpServer,
  testMcpServer,
  loadMcpImports,
  importMcpServers,
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
  openJobs,
  removeProvider,
  removePushDevice,
  saveImage,
  saveMemoryLore,
  saveMemoryProvider,
  saveProvider,
  saveSettings,
  saveThinking,
  sendTestPush,
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
import { PageHead, Group, Seg, LinkRow } from "./SettingsParts.tsx";
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
      {saved && !error ? <span className="okline">已保存</span> : null}
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
    setMessage(ok ? "已保存" : getState().notice ?? "保存失败，请重试。");
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

const SECTIONS: { id: SettingsSection; label: string }[] = [
  { id: "general", label: "通用" },
  { id: "rules", label: "规则" },
  { id: "providers", label: "服务商" },
  { id: "models", label: "模型" },
  { id: "memory", label: "记忆" },
  { id: "image", label: "图像生成" },
  { id: "knowledge", label: "知识库" },
  { id: "search", label: "联网搜索" },
  { id: "skills", label: "技能" },
  { id: "mcp", label: "MCP" },
  { id: "desktop", label: "云桌面" },
  { id: "work", label: "任务" },
  { id: "usage", label: "消耗" },
  { id: "push", label: "通知" },
  { id: "about", label: "关于" },
];


const THEMES: { key: Theme; label: string }[] = [
  { key: "system", label: "跟随系统" },
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
];

function timezones(): string[] {
  const list = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.("timeZone");
  return list ?? [];
}

export function SettingsPage({ narrow, leaving }: { narrow: boolean; leaving: boolean }) {
  const s = useApp();
  const current = s.section ?? (narrow ? null : "general");
  // 换分栏、进出子页都从顶上看起
  const main = useRef<HTMLDivElement>(null);
  useEffect(() => {
    main.current?.scrollTo(0, 0);
  }, [current, s.sub]);

  if (narrow && current === null) {
    return (
      <div className={`setpage narrow${leaving ? " leaving" : ""}`}>
        <div className="sethead">
          <button className="hob-icon-btn" title="返回" onClick={closeSettings}>
            <Icon name="left" size={17} />
          </button>
          <span className="t">设置</span>
        </div>
        <div className="setbody">
          {SECTIONS.map((item) => (
            <button className="setitem" key={item.id} onClick={() => setSection(item.id)}>
              <span>{item.label}</span>
              <Icon name="chev" size={15} />
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className={`setpage${narrow ? " narrow" : ""}${leaving ? " leaving" : ""}`}>
      {narrow ? (
        <div className="sethead">
          <button className="hob-icon-btn" title="返回" onClick={s.sub ? closeSub : () => setSection(null)}>
            <Icon name="left" size={17} />
          </button>
          <span className="t">{s.sub?.title ?? SECTIONS.find((item) => item.id === current)?.label ?? "设置"}</span>
        </div>
      ) : (
        <div className="setnav">
          <div className="setnavtitle">设置</div>
          {SECTIONS.map((item) => (
            <button
              key={item.id}
              className={`navrow${current === item.id ? " sel" : ""}`}
              onClick={() => setSection(item.id)}
            >
              {item.label}
            </button>
          ))}
          <span className="sp" />
          <button className="navrow" onClick={closeSettings}>
            返回 Hob
          </button>
        </div>
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
        ) : current === "mcp" ? (
          <McpSection />
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
    <PageHead title="全局规则" desc="所有助手和任务都遵守的规则。「执行前确认」的事项，助手执行前会征求你的确认；「一律照做」是做事的规则。每个助手自己的规则在它的档案里修改。" />
    {error ? <div className="badline" role="status">{error}</div> : null}
    {rules === null ? error ? <button className="hob-btn" onClick={() => void loadRules()}>重试</button> : <Empty><DelayedText text="正在读取全局规则…" /></Empty> :
      ([{ mode: "ask", label: "执行前确认" }, { mode: "allow", label: "一律照做" }] as const).map(({ mode, label }) => <Group key={mode}>
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
    {editing ? <input className="rule-input" aria-label="编辑规则" autoFocus maxLength={1000} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => {
      if (e.key === "Enter") e.currentTarget.blur();
      if (e.key === "Escape") { cancel.current = true; setText(rule.text); setEditing(false); }
    }} /> : <button className="rule-text" title="编辑规则" disabled={busy} onClick={() => { cancel.current = false; setText(rule.text); setEditing(true); }}>{rule.text}</button>}
    <span className="v">{age >= 0 && age < 86400000 ? <span className="rule-recent">最近修改</span> : null}<button className="del" aria-label={`删除规则：${rule.text}`} title="删除这条规则" disabled={busy} onClick={onDelete}><Icon name="close" size={13} /></button></span>
  </div>;
}

function RuleAdd({ label, busy, onAdd }: { label: string; busy: boolean; onAdd: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  return <form className="rule-add-form" onSubmit={(e) => { e.preventDefault(); const value = text.trim(); if (value && !busy) void onAdd(value).then((ok) => { if (ok) setText(""); }); }}>
    <input className="rule-input" aria-label={`${label}添加规则`} placeholder="＋ 添加规则" maxLength={1000} value={text} disabled={busy} onChange={(e) => setText(e.target.value)} />
    <button className="hob-btn" type="submit" disabled={busy || !text.trim()}>添加</button>
  </form>;
}

function DesktopSection() {
  const [view, setView] = useState<DesktopView | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string; public?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showDesktop, setShowDesktop] = useState<"hob" | "public" | null>(null);
  const [publicAssistants, setPublicAssistants] = useState<string[]>([]);
  const assistants = useApp().assistants;

  useEffect(() => {
    void loadDesktop()
      .then((v) => {
        setView(v);
        setUrl(v.url);
        setEnabled(v.enabled);
        setPublicAssistants(v.publicAssistants);
      })
      .catch((e: Error) => setMessage({ ok: false, text: `无法读取云桌面配置：${e.message}` }));
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
      setMessage({ ok: true, text: "已保存" });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function savePublic() {
    if (!view) return;
    setBusy(true);
    setMessage(null);
    try {
      const next = await saveDesktopPublic(view.revision, publicAssistants);
      setView(next);
      setPublicAssistants(next.publicAssistants);
      setMessage({ ok: true, text: "已保存", public: true });
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error), public: true });
    } finally { setBusy(false); }
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
      const profiles = result.health.screens.filter((item) => item.browserRunning).map((item) => item.id).join("、");
      setTest({ ok: true, text: `已连接 · ${result.health.display.width}×${result.health.display.height} · 浏览器：${profiles || "无"}` });
    } catch (e) {
      setTest({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const statusLine = test ? <span className={test.ok ? "okline" : "badline"} style={test.ok ? undefined : { color: "var(--danger)" }} role="status">{test.text}</span> : null;

  return (
    <>
      <PageHead title="云桌面" desc="云桌面需要单独部署。登录 Hob 的人可以观看和接管桌面。" />
      {deployed ? (
        <Group>
          <div className="note">由部署配置（compose 的 desktop 服务）</div>
          <div className="formcard">
            <div className="lbl sub">地址</div>
            <div className="sline mono">{view?.url || "未配置"}</div>
            <div className="lbl sub">令牌</div>
            <div className="sline">{view?.tokenConfigured ? "已设置" : "未设置"}</div>
            <div className="lbl sub">启用</div>
            <div className="sline">{view?.enabled ? "已启用" : "未启用"}</div>
            <div className="ctl">
              <button className="hob-btn" disabled={busy || !view} onClick={() => void testConnection()}>测试连接</button>
              <button className="hob-btn" disabled={!view?.enabled} onClick={() => setShowDesktop("hob")}>打开桌面</button>
              {statusLine}
            </div>
          </div>
        </Group>
      ) : (
        <>
          <Group>
            <div className="lbl">启用</div>
            <div className="ctl">
              <button className={`tog${enabled ? "" : " off"}`} aria-label="启用云桌面" aria-pressed={enabled} disabled={!view} onClick={() => setEnabled(!enabled)} />
              <span className="note">
                {(enabled ? "已启用。登录 Hob 的人可以观看桌面，接管后可以操作。" : "未启用。界面不打开桌面，任务也不能使用桌面。") + (enabledPending ? "（保存后生效）" : "")}
              </span>
            </div>
          </Group>
          <Group>
            <div className="lbl">连接</div>
            <div className="formcard">
              <div className="lbl">地址</div>
              <div className="field">
                <input value={url} disabled={!view || busy} onChange={(e) => setUrl(e.target.value)} placeholder="http://127.0.0.1:6080" />
              </div>
              <div className="lbl">令牌</div>
              <div className="field">
                <input type="password" value={token} disabled={!view || busy} onChange={(e) => setToken(e.target.value)} placeholder={view?.tokenConfigured ? "已保存，留空不变" : "云桌面的访问令牌"} />
              </div>
              <div className="sfoot">
                <button className="hob-btn" disabled={busy || !view} onClick={() => void testConnection()}>测试连接</button>
                <button className="hob-btn" disabled={!view?.enabled} onClick={() => setShowDesktop("hob")}>打开桌面</button>
                {statusLine}
                {message && !message.public ? <span className={message.ok ? "okline" : "badline"} role="status">{message.text}</span> : null}
                <span className="sp" />
                <button className="hob-btn hob-btn-primary" disabled={busy || !view} onClick={() => void save()}>保存</button>
              </div>
            </div>
            <div className="note">部署说明见 <a href="https://github.com/FFatTiger/hob#云桌面" target="_blank" rel="noreferrer">云桌面文档</a>。测试连接会检查地址、令牌和云桌面是否可用。</div>
          </Group>
        </>
      )}
      <Group>
        <div className="lbl">公共屏幕</div>
        <div className="formcard">
          <div className="plist">
            {assistants.map((assistant) => <label key={assistant.id}>
              <input type="checkbox" className="rcheck" checked={publicAssistants.includes(assistant.id)} disabled={busy || !view} onChange={(event) => setPublicAssistants((ids) => event.target.checked ? [...ids, assistant.id] : ids.filter((id) => id !== assistant.id))} />
              <span>{assistant.name}</span>
            </label>)}
          </div>
          <div className="sfoot">
            <button className="hob-btn" disabled={!view?.enabled || busy} onClick={() => setShowDesktop("public")}>打开公共屏幕</button>
            {message?.public ? <span className={message.ok ? "okline" : "badline"} role="status">{message.text}</span> : null}
            <span className="sp" />
            <button className="hob-btn hob-btn-primary" disabled={!view || busy} onClick={() => void savePublic()}>保存</button>
          </div>
        </div>
        <div className="note">用于登录你自己的账号，勾选的助手可以使用。受 Google 限制，目前无法登录 Google 账号。</div>
      </Group>
      {showDesktop ? <Suspense fallback={null}><DesktopScreen initialScreen={showDesktop} takeOver={showDesktop === "public"} onClose={() => setShowDesktop(null)} /></Suspense> : null}
    </>
  );
}

function GeneralSection() {
  const s = useApp();
  const about = s.settings.settings.general.aboutYou;
  const feedback = useSaveFeedback();
  const timezoneFeedback = useSaveFeedback();
  const aboutFeedback = useSaveFeedback();
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  return (
    <>
      <PageHead title="通用" desc="主题、时区、个人信息、登录密码。" />
      <Group>
        <div className="lbl">主题</div>
        <Seg items={THEMES} value={s.theme} disabled={feedback.busy} onChange={(theme) => void feedback.save({ general: { theme } })} />
        <SaveFeedback message={feedback.message} />
      </Group>

      <Group>
        <div className="lbl">时区</div>
        <TimezoneField value={s.settings.settings.general.timezone} onSave={(timezone) => timezoneFeedback.save({ general: { timezone } })} />
        <SaveFeedback message={timezoneFeedback.message} />
        <div className="note">助手的「现在时间」和定时任务都按这个时区算。</div>
      </Group>

      <Group>
        <div className="lbl">展示页面</div>
        <button className={`tog${s.settings.settings.general.showPage === false ? " off" : ""}`} aria-label="展示页面" aria-pressed={s.settings.settings.general.showPage !== false} disabled={feedback.busy} onClick={() => void feedback.save({ general: { showPage: s.settings.settings.general.showPage === false } })} />
        <SaveFeedback message={feedback.message} />
        <div className="note">允许助手把适合可视化的内容展示为页面。</div>
      </Group>

      <Group>
        <div className="lbl">个人信息</div>
        <div className="lbl sub">称呼</div>
        <AutoField placeholder="如「王先生」" value={about.name} onSave={(name) => aboutFeedback.save({ general: { aboutYou: { name: name.trim() } } })} />
        <div className="lbl sub">语言</div>
        <AutoField placeholder="如「中文」" value={about.language} onSave={(language) => aboutFeedback.save({ general: { aboutYou: { language: language.trim() } } })} />
        <div className="lbl sub">其他</div>
        <AutoField multiline placeholder="如「不要看融资新闻」" value={about.notes} onSave={(notes) => aboutFeedback.save({ general: { aboutYou: { notes } } })} />
        <SaveFeedback message={aboutFeedback.message} />
        <div className="note">所有助手都会参考这些信息；未填写的项不使用。</div>
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
          placeholder="搜索时区，如 Berlin"
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onBlur={() => {
            if (query.trim() !== value) {
              if (all.includes(query.trim())) commit(query.trim());
              else { setQuery(value); setError("时区无效，请从列表中选择。"); }
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
      onDone("请填写旧密码和新密码。");
      return;
    }
    if (next !== again) {
      onDone("两次输入的新密码不一致。");
      return;
    }
    setBusy(true);
    const error = await changePassword(old, next);
    setBusy(false);
    if (error) {
      onDone(`修改失败：${error}`);
      return;
    }
    setOld("");
    setNext("");
    setAgain("");
    onDone("密码已修改。");
  };

  return (
    <>
      <div className="lbl">登录密码</div>
      <div className="field">
        <input type="password" placeholder="旧密码" value={old} onChange={(e) => setOld(e.target.value)} />
      </div>
      <div className="field">
        <input type="password" placeholder="新密码" value={next} onChange={(e) => setNext(e.target.value)} />
      </div>
      <div className="field">
        <input type="password" placeholder="再次输入新密码" value={again} onChange={(e) => setAgain(e.target.value)} />
      </div>
      <SaveRow saved={false} error={null}>
        {old || next || again ? <span className="note">未保存的修改</span> : null}
        <button className="hob-btn" disabled={busy || !(old || next || again)} onClick={() => { setOld(""); setNext(""); setAgain(""); onDone(""); }}>取消</button>
        <button className="hob-btn hob-btn-primary" onClick={() => void submit()} disabled={busy || !old || !next || !again}>
          {busy ? "正在验证…" : "保存"}
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
  options: { value: V; text: string }[];
  label: string;
  icon?: IconName;
  onChange: (next: V) => void;
}) {
  return (
    <span className="ctl">
      {icon ? <Icon name={icon} size={14} /> : null}
      <Select aria-label={label} value={value} onChange={(next) => onChange(next as V)} options={options.map((item) => ({ value: item.value, label: item.text }))} />
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
      label="思考强度"
      icon="bulb"
      options={levels.map((level) => ({ value: level, text: THINKING_TEXT[level] }))}
      onChange={onChange}
    />
  );
}

/**
 * 一个模型的思考档：一行一个档（中文档名 + 发给服务商的字符 + 删除），底部添加档和恢复默认。
 * 存进 Hob 设置里这个模型的自定义档位，存完立即生效（下一轮对话 / 下一个任务就用新的字符）。
 */
function ThinkingLevels({
  modelRef,
  info,
  disabled,
  onSaved,
}: {
  modelRef: string;
  info: ModelThinkingView;
  disabled: boolean;
  onSaved: (thinking: ModelThinkingView, settings: SettingsFile) => void;
}) {
  type Row = { level: ThinkingLevel; text: string };
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Row[] | null>(null);
  const [pick, setPick] = useState<ThinkingLevel | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [saved]);
  const rows = draft ?? info.levels;
  const rest = THINKING_ORDER.filter((level) => !rows.some((row) => row.level === level));
  const dirty = draft !== null;

  const edit = (next: Row[]) => {
    setDraft(next.slice().sort((a, b) => THINKING_ORDER.indexOf(a.level) - THINKING_ORDER.indexOf(b.level)));
    setError(null);
    setSaved(false);
  };

  const commit = async (levels: ThinkingLevelMapSetting | null) => {
    setBusy(true);
    setError(null);
    const result = await saveThinking(modelRef, levels);
    setBusy(false);
    if (!result.ok) {
      setDraft(null);
      setError(result.error);
      return;
    }
    setDraft(null);
    setSaved(true);
    onSaved(result.thinking, result.settings);
  };

  // 删掉的档写成 null：引擎按 null 认为这个模型没有这一档；没填的档写空串，交给服务商协议自己翻译
  const save = (next: Row[] = rows) => {
    const levels: ThinkingLevelMapSetting = {};
    for (const level of THINKING_ORDER) {
      const row = next.find((item) => item.level === level);
      levels[level] = row ? row.text.trim() : null;
    }
    void commit(levels);
  };

  return (
    <div className="think-levels">
      <button className="thinkhead" onClick={() => setOpen((value) => !value)} disabled={busy}>
        <span className="lbl sub">思考档</span>
        <span className="note">
          {rows.length} 档{info.custom ? " · 有自定义" : " · 默认"}
        </span>
        <Icon name={open ? "down" : "chev"} size={14} />
      </button>
      <div className={`expand${open ? " open" : ""}`} inert={!open}>
        <div>
          <div className="thinkrows">
            {rows.map((row) => (
              <div className="thinkrow" key={row.level}>
                <span className="tname">{THINKING_TEXT[row.level]}</span>
                <input
                  className="ttext"
                  value={row.text}
                  placeholder="默认"
                  title="留空就按服务商协议的默认值发"
                  onChange={(e) =>
                    edit(
                      rows.map((item) => (item.level === row.level ? { ...item, text: e.target.value } : item)),
                    )
                  }
                  onBlur={() => { if (dirty) save(); }}
                  onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                  disabled={busy || disabled}
                />
                {row.level === "off" ? (
                  <span className="rremove still" title="关闭这一档不能删" aria-hidden />
                ) : (
                  <button
                    className="rremove"
                    title={`删掉「${THINKING_TEXT[row.level]}」`}
                    onClick={() => save(rows.filter((item) => item.level !== row.level))}
                    disabled={busy || disabled}
                  >
                    <Icon name="close" size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="ctl" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            <Select value={pick} onChange={(value) => setPick(value as ThinkingLevel | "")} disabled={busy || disabled || !rest.length} aria-label="添加思考档" options={[{ value: "", label: rest.length ? "选择档位" : "七个档都用上了" }, ...rest.map((level) => ({ value: level, label: THINKING_TEXT[level] }))]} />
            <button
              className="hob-btn"
              onClick={() => {
                if (!pick) return;
                save([...rows, { level: pick, text: "" }]);
                setPick("");
              }}
              disabled={busy || disabled || !pick}
            >
              添加思考档
            </button>
            <span className="sp" />
            {info.custom ? (
              <button className="hob-btn" onClick={() => void commit(null)} disabled={busy || disabled}>
                恢复默认
              </button>
            ) : null}
          </div>
          <div className="note">
            留空就按服务商协议的默认值发；填了才按你写的发（例如 DeepSeek 的「中」填 high）。
            关闭这一档不能删，其余档删掉后不再出现在思考强度里。
          </div>
          {error ? <div className="badline">{error}</div> : null}
          {saved ? <div className="okline">已保存思考档</div> : null}
        </div>
      </div>
    </div>
  );
}

/** 模型能力：图片输入、推理用图标，上下文只写数字；悬停有完整说明。 */
function CapIcons({ info }: { info: ModelInfo }) {
  const context = contextText(info.contextWindow);
  return (
    <span className="caps">
      {info.input.includes("image") ? (
        <span title="支持图片输入" aria-label="支持图片输入">
          <Icon name="image" size={14} />
        </span>
      ) : null}
      {info.reasoning ? (
        <span title="支持推理" aria-label="支持推理">
          <Icon name="bulb" size={14} />
        </span>
      ) : null}
      <span className="ctx" title={`上下文 ${context}`}>
        {context}
      </span>
    </span>
  );
}

const PROVIDER_APIS: { key: ProviderApi; label: string }[] = [
  { key: "openai-completions", label: "OpenAI 兼容" },
  { key: "openai-responses", label: "OpenAI Responses 兼容" },
  { key: "anthropic-messages", label: "Anthropic 兼容" },
  { key: "google-generative-ai", label: "Google 兼容" },
];

const API_LABEL = Object.fromEntries(PROVIDER_APIS.map((item) => [item.key, item.label])) as Record<ProviderApi, string>;

const DEFAULT_CONTEXT = 128_000;

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

/** 导入列表里的 Key 状态（不显示值）。 */
const IMPORT_KEY_TEXT: Record<ProviderImportItem["key"], string> = {
  literal: "包含 Key",
  env: "包含 Key",
  command: "需手动填写",
  none: "无 Key",
};

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
  if (!view) return <Empty>正在读取服务商…</Empty>;

  /** 改完回到列表，并给一行提示。 */
  const done = (next: ProvidersView, message: string) => {
    if (message.startsWith("已导入")) setConnectionStatus({});
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
      <ProviderDetail id={sub.id} view={view} onView={setView} onSaved={done} onThinking={thinkingSaved} onConnection={connectionSaved} />
    );
  if (sub?.kind === "addProvider") return <AddProvider view={view} onSaved={done} onConnection={connectionSaved} />;
  if (sub?.kind === "importProviders") return <ImportProviders onSaved={done} />;
  return <ProvidersHome view={view} notice={notice} connectionStatus={connectionStatus} />;
}

/** 服务商页：已配置的服务商（整行点进详情）、添加服务商、从本机导入。 */
function ProvidersHome({ view, notice, connectionStatus }: { view: ProvidersView; notice: string | null; connectionStatus: Record<string, "connected" | "failed"> }) {
  const builtinName = (id: string) => view.builtin.find((item) => item.id === id)?.name ?? id;
  const label = (provider: ProviderView) => (provider.kind === "builtin" ? builtinName(provider.id) : provider.name);

  return (
    <>
      <PageHead
        title="服务商"
        desc="模型服务商与 API Key。内置服务商只需填写 API Key；兼容接口需填写服务地址、协议与模型。API Key 只保存在本机，保存后不再显示。"
      />

      <ClaudeProviderCard />
      <Group>
        <div className="ctl">
          <button className="hob-btn hob-btn-primary" onClick={() => openSub({ kind: "addProvider", title: "添加服务商" })}>
            添加服务商
          </button>
        </div>
        <div className="lbl">已配置的服务商</div>
        <div className="group-card settings-card">
          {view.providers.map((provider) => (
            <button
              className="list-row setting-row"
              key={provider.id}
              onClick={() => openSub({ kind: "provider", id: provider.id, title: label(provider) })}
            >
              <div className="rmain">
                <div className="rname">{label(provider)}</div>
                <div className="rprov">{provider.kind === "builtin" ? "内置服务商" : "兼容接口"}</div>
              </div>
              <span className={provider.keyConfigured && connectionStatus[provider.id] !== "failed" ? "note" : "badline"}>
                {provider.keyConfigured ? `${connectionStatus[provider.id] === "connected" ? "已连接" : connectionStatus[provider.id] === "failed" ? "连接失败" : "未验证"} · ${view.models[provider.id]?.length ?? 0} 个模型` : "未填 Key"}
              </span>
              <Icon name="chev" size={15} className="rgo" />
            </button>
          ))}
          <button className="maddrow" onClick={() => openSub({ kind: "importProviders", title: "从本机导入" })}>
            <Icon name="doc" size={16} />
            从本机导入
          </button>
        </div>
        {view.providers.length ? null : (
          <Empty>尚未添加其他服务商。</Empty>
        )}
        <div className="note">从本机导入会只读本机配置并一次性复制到 Hob，不会修改来源。</div>
        {notice ? <div className="okline">{notice}</div> : null}
      </Group>
    </>
  );
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
    try { setView(await saveClaude(draft)); setMessage("已保存"); }
    catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  const status = view?.status;
  return <Group>
    <div className="lbl">Claude 订阅（经本机 Claude Code）</div>
    <div className="formcard">
      <div className="ctl">
        <button className={`tog${draft.enabled ? "" : " off"}`} aria-label="启用 Claude 订阅" aria-pressed={draft.enabled} disabled={!view || busy} onClick={() => setDraft({ ...draft, enabled: !draft.enabled })} />
        <span className="note">{draft.enabled ? "已启用" : "未启用"}{view && draft.enabled !== (view.settings.settings.claude?.enabled ?? false) ? "（保存后生效）" : ""}</span>
      </div>
      <div className="lbl sub">状态</div>
      <div className={status?.loggedIn ? "okline" : "badline"} role="status">
        {!status ? "正在检测…" : !status.found ? "未找到 Claude Code，当前不可用。" : status.error ? status.error : status.loggedIn ? `已登录${status.version ? ` · ${status.version}` : ""}${status.plan ? ` · ${status.plan}` : ""}${status.email ? ` · ${status.email}` : ""}` : `未登录${status.version ? ` · ${status.version}` : ""}，当前不可用。`}
      </div>
      {status?.found && !status.loggedIn ? <div className="note">请在终端执行 <code>claude auth login</code>，然后重新检测。</div> : null}
      <div className="lbl sub">套餐</div>
      <Select value={draft.plan} disabled={busy || !view} onChange={(value) => setDraft({ ...draft, plan: value as "pro" | "max" })} options={[{ value: "pro", label: "Pro" }, { value: "max", label: "Max" }]} />
      <div className="lbl sub">Claude Code 程序路径</div>
      <div className="field"><input value={draft.executable} disabled={busy || !view} onChange={(e) => setDraft({ ...draft, executable: e.target.value })} placeholder={status?.executable || "留空时自动查找"} /></div>
      <div className="note">用量计入你的 Claude 订阅额度，与 Claude Code 共用。Docker 镜像不支持此功能。</div>
      <div className="sfoot">
        <button className="hob-btn" disabled={busy} onClick={() => void detect()}>重新检测</button>
        {message ? <span className="note" role="status">{message}</span> : null}
        <span className="sp" />
        <button className="hob-btn hob-btn-primary" disabled={busy || !view} onClick={() => void save()}>保存</button>
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
}: {
  id: string;
  view: ProvidersView;
  onView: (view: ProvidersView) => void;
  onSaved: (view: ProvidersView, message: string) => void;
  onThinking: (providerId: string, thinking: ModelThinkingView, settings: SettingsFile) => void;
  onConnection: (id: string, status: "connected" | "failed") => void;
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
        <SubBack label="服务商" />
        <PageHead title="添加服务商" desc="内置服务商只需填写 API Key；兼容接口需填写服务地址、协议与模型。" />
        <Group>
          <div className="group-card settings-card">
            <button className="list-row model-row" onClick={() => setKind("builtin")}>
              <span className="mtop">
                <span className="mname">内置服务商</span>
                <span className="sp" />
                <Icon name="chev" size={14} />
              </span>
              <span className="mprev">提供完整的模型目录，填写 API Key 即可。</span>
            </button>
            <button className="list-row model-row" onClick={() => setKind("custom")}>
              <span className="mtop">
                <span className="mname">兼容接口</span>
                <span className="sp" />
                <Icon name="chev" size={14} />
              </span>
              <span className="mprev">填写服务地址、协议与模型；模型列表可从接口获取。</span>
            </button>
          </div>
        </Group>
      </>
    );
  }

  if (kind === "builtin" && builtinId === null) {
    return <><button className="subback" onClick={() => setKind(null)}><Icon name="left" size={15} />添加服务商</button>
      <PageHead title="选择内置服务商" desc="选择服务商后填写 API Key。" />
      <Group><div className="group-card settings-card">{available.length ? available.map((item) => <button className="list-row model-row" key={item.id} onClick={() => setBuiltinId(item.id)}><span className="mtop"><span className="mname">{item.name}</span><span className="sp" /><Icon name="chev" size={14} /></span><span className="mprev">内置服务商</span></button>) : <Empty>所有内置服务商均已添加。</Empty>}</div></Group>
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
    onSaved(result.view, `已导入 ${ids.length} 个服务商`);
  };

  return (
    <>
      <SubBack label="服务商" />
      <PageHead
        title="从本机导入"
        desc="读取本机其他客户端保存的服务商配置。来源文件只读，导入后 Key 存入 Hob，不再显示。"
      />
      {view === null ? (
        error ? null : <Empty>正在读取…</Empty>
      ) : (
        <Group>
          <div className="sline">来源：{view.source}</div>
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
                            ? "内置服务商"
                            : `兼容接口${item.api ? ` · ${API_LABEL[item.api]}` : ""}`}
                        </span>
                        {item.models ? <span className="rtag">{item.models} 个模型</span> : null}
                        {item.exists ? <span className="rtag">将覆盖</span> : null}
                      </span>
                    </div>
                    {item.baseUrl ? <div className="rprov">{item.baseUrl}</div> : null}
                    <div className="rfoot">
                      <span className={item.key === "none" && !item.note ? "rtag bad" : "rtag"}>
                        {IMPORT_KEY_TEXT[item.key]}
                      </span>
                    </div>
                    {item.note ? <div className="note">{item.note}</div> : null}
                  </div>
                </label>
              ))}
            </div>
          ) : (
            <Empty>未找到可导入的配置。</Empty>
          )}
          <div className="ctl" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
            <button className="hob-btn hob-btn-primary" onClick={() => void commit()} disabled={busy || !chosen.size}>
              {busy ? "正在导入…" : "导入所选"}
            </button>
            <button className="hob-btn" onClick={closeSub} disabled={busy}>
              取消
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

  return (
    <Group>
      <div className="lbl">危险操作</div>
      <div className="group-card settings-card">
        {confirming ? (
          <div className="ctl" style={{ padding: 12, gap: 8, flexWrap: "wrap" }}>
            <span>删除「{label}」后，该服务商的模型将不可用。{affected.length ? `受影响的默认模型：${affected.map((role) => role === "conversation" ? "对话" : "任务执行").join("、")}。` : "当前默认模型不受影响。"}</span>
            <button className="hob-btn" onClick={() => setConfirming(false)} disabled={busy}>取消</button>
            <button className="hob-btn hob-btn-danger" onClick={() => void drop()} disabled={busy}>确认删除</button>
          </div>
        ) : (
          <button className="mline danger" onClick={() => setConfirming(true)} disabled={busy}>删除服务商</button>
        )}
      </div>
      {error ? <div className="badline">{error}</div> : null}
    </Group>
  );
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
}: {
  view: ProvidersView;
  initial: ProviderDraft;
  onSaved: (view: ProvidersView, message: string) => void;
  onView?: (view: ProvidersView) => void;
  onConnection: (id: string, status: "connected" | "failed") => void;
  onThinking: (thinking: ModelThinkingView, settings: SettingsFile) => void;
  extra?: ReactNode;
}) {
  const s = useApp();
  const [draft, setDraft] = useState<ProviderDraft>(initial);
  const [rosterBusy, setRosterBusy] = useState(false);
  const [rosterNotice, setRosterNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!rosterNotice || rosterNotice !== "已保存") return;
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
    setTestStatus("连接成功");
  };

  const rosterControl = (model: { id: string; name?: string; reasoning?: boolean }) => {
    const ref = `${draft.id}/${model.id}`;
    const settings = s.settings.settings.models;
    const selected = settings.roster.some((entry) => entry.ref === ref);
    const isDefault = settings.conversation.ref === ref || settings.work.ref === ref;
    return (
      <label className="ctl">
        <input
          type="checkbox"
          checked={selected}
          disabled={draft.isNew || !thinkingOf(model.id) || rosterBusy || busy || isDefault}
          onChange={() => {
            const roster = selected
              ? settings.roster.filter((entry) => entry.ref !== ref)
              : [...settings.roster, { ref, note: "", scores: guessModelScores({ id: model.id, name: model.name ?? model.id, reasoning: Boolean(model.reasoning) }), scoresConfirmed: false }];
            setRosterBusy(true);
            setRosterNotice(null);
            void saveSettings({ models: { roster } }).then((ok) => {
              setRosterBusy(false);
              setRosterNotice(ok ? "已保存" : "保存失败，请重试。");
            });
          }}
        />
        <span>{isDefault ? "默认模型已加入" : "加入可用模型"}</span>
      </label>
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
    setRosterNotice("已保存");
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

  /** 内置服务商的模型列表：模型由服务商提供，会推理的可以改思考档。 */
  const builtinModelList = (id: string) => {
    const models = view.models[id] ?? [];
    if (!models.length) return null;
    return (
      <>
        <div className="lbl">模型</div>
        <div className="group-card settings-card">
          {models.map((info) => (
            <div className="list-row setting-row" key={info.id}>
              <div className="rmain">
                <div className="rname">
                  {info.name}
                  <span className="rtags">
                    <span className="rtag mono">{info.id}</span>
                  </span>
                </div>
                <div className="caps">
                  {info.input?.includes("image") ? <span title="支持图片输入" aria-label="支持图片输入"><Icon name="image" size={14} /></span> : null}
                  {info.reasoning ? <span title="支持推理" aria-label="支持推理"><Icon name="bulb" size={14} /></span> : null}
                  {info.contextWindow ? <span className="ctx">{contextText(info.contextWindow)}</span> : null}
                </div>
                {rosterControl(info)}
                {info.reasoning ? (
                  <ThinkingLevels modelRef={info.ref} info={info} disabled={busy} onSaved={onThinking} />
                ) : (
                  <div className="note">不推理，没有思考档。</div>
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="note">模型由服务商提供。会推理的模型可以改每个思考档发给服务商的字符。</div>
      </>
    );
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
      setError("保存失败：请填写标识。模型引用使用该标识，只能包含小写字母、数字、点和短横线，例如 my-proxy。");
      return;
    }
    if (draft.isNew && configured.has(id)) {
      setBusy(false);
      setError("该服务商标识已存在，请使用其他标识。");
      return;
    }
    if (tested !== fingerprint) {
      setTestStatus("正在验证连接…");
      const testError = await testProviderConnection(connection);
      setTestStatus(null);
      if (testError) { setBusy(false); setError(`测试连接失败：${testError}`); return; }
    }
    const result = await saveProvider(id, body);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onConnection(id, "connected");
    onSaved(result.view, "已保存");
  };

  const title =
    draft.kind === "builtin"
      ? draft.isNew
        ? "添加内置服务商"
        : builtinName(draft.id)
      : draft.isNew
        ? "添加兼容接口"
        : draft.name || "兼容接口";
  // 新兼容接口未填名称时还没有标识，不显示占位字
  const idText = draft.kind === "builtin" ? draft.id : draft.id || slugOf(draft.name);

  return (
    <>
      <SubBack label="服务商" />
      <PageHead title={title} desc={idText ? <span className="mono">{idText}</span> : null} />

      {draft.kind === "builtin" ? (
        <Group>
          <div className="lbl">连接</div><div className="formcard">
          <div className="lbl sub">服务商</div>
          <div className="ctl">
            <Select className="grow" value={draft.id} onChange={(value) => patch({ id: value })} disabled options={view.builtin.filter((item) => !draft.isNew || !configured.has(item.id)).map((item) => ({ value: item.id, label: `${item.name}${configured.has(item.id) ? "（已配置）" : ""}` }))} />
          </div>
          <div className="lbl sub">API Key</div>
          {!changingKey ? <div className="ctl"><span className="note">已保存</span><button className="hob-btn" onClick={() => setChangingKey(true)}>更换</button></div> : <div className="field">
            <input
              type="password"
              value={draft.key}
              placeholder={
                view.providers.find((provider) => provider.id === draft.id)?.keyConfigured
                  ? "已保存，留空不变"
                  : "sk-…"
              }
              onChange={(e) => patch({ key: e.target.value })}
              disabled={busy}
            />
          </div>}
          <div className="ctl"><button className="hob-btn" disabled={busy} onClick={() => void runConnectionTest()}>测试连接</button><span className="note">测试会请求模型，可能产生费用。</span>{testStatus && tested === fingerprint ? <span className="okline">{testStatus}</span> : null}</div>
          <ProviderFoot busy={busy} error={error} dirty={dirty} onCancel={closeSub} onSave={() => void commit()} />
          </div>
        </Group>
      ) : (
        <>
          <Group>
            <div className="lbl">连接</div><div className="formcard">
            <div className="lbl sub">名称</div>
            <div className="field">
              <input
                value={draft.name}
                placeholder="如「我的代理」"
                onChange={(e) => patch({ name: e.target.value })}
                disabled={busy}
              />
            </div>
            {draft.isNew ? (
              <>
                <div className="lbl sub">标识</div>
                <div className="field">
                  <input
                    value={draft.id}
                    placeholder={slugOf(draft.name) || "my-proxy"}
                    onChange={(e) => patch({ id: e.target.value })}
                    disabled={busy}
                  />
                </div>
                <div className="note">模型引用使用该标识，例如 my-proxy/gpt-x。留空则按名称自动生成。</div>
              </>
            ) : (
              <div className="note mono">标识：{draft.id}</div>
            )}
            <div className="lbl sub">协议</div>
            <div className="ctl">
              <Select className="grow" value={draft.api} onChange={(value) => patch({ api: value as ProviderApi })} disabled={busy} options={PROVIDER_APIS.map((item) => ({ value: item.key, label: item.label }))} />
            </div>
            <div className="lbl sub">服务地址</div>
            <div className="field">
              <input
                value={draft.baseUrl}
                placeholder="http://127.0.0.1:8080/v1"
                onChange={(e) => patch({ baseUrl: e.target.value })}
                disabled={busy}
              />
            </div>
            <div className="lbl sub">API Key</div>
            {!changingKey ? <div className="ctl"><span className="note">已保存</span><button className="hob-btn" onClick={() => setChangingKey(true)}>更换</button></div> : <div className="field">
              <input
                type="password"
                value={draft.key}
                placeholder={
                  view.providers.find((provider) => provider.id === draft.id)?.keyConfigured
                    ? "已保存，留空不变"
                    : "sk-…"
                }
                onChange={(e) => patch({ key: e.target.value })}
                disabled={busy}
              />
            </div>}
            <div className="ctl" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="hob-btn" disabled={busy || !draft.baseUrl.trim()} onClick={() => void runConnectionTest()}>测试连接</button>
              {testStatus && tested === fingerprint ? <span className="okline">{testStatus}</span> : null}
              <button className="hob-btn" onClick={() => void runDiscover()} disabled={busy || !draft.baseUrl.trim()}>
                {busy ? "正在获取…" : "获取模型列表"}
              </button>
              <span className="note">
                从接口获取模型列表，选择需要使用的模型。
              </span>
            </div>
            <ProviderFoot busy={busy} error={error} dirty={dirty} onCancel={closeSub} onSave={() => void commit()} />
            </div>
          </Group>

          {found.length ? (
            <Group>
              <div className="lbl">接口上的模型</div>
              <div className="chips">
                {found.map((model) => {
                  const on = draft.models.some((item) => item.id === model.id);
                  return (
                    <button
                      key={model.id}
                      className={`chip${on ? " on" : ""}`}
                      onClick={() => toggleFound(model)}
                      disabled={busy}
                    >
                      {model.name ?? model.id}
                    </button>
                  );
                })}
              </div>
              <div className="note">点击添加或移除，添加后可在下方修改模型能力。</div>
            </Group>
          ) : null}

          <Group>
            <div className="lbl">模型</div>
            {draft.models.length ? (
              <div className="group-card settings-card">
                {draft.models.map((model) => (
                  <div className="list-row setting-row" key={model.id}>
                    <div className="rmain">
                      <div className="rname mono">{model.id}</div>
                      <div className="rfoot">
                        <button
                          className={`chip${model.input?.includes("image") ? " on" : ""}`}
                          onClick={() =>
                            editModel(model.id, {
                              input: model.input?.includes("image") ? ["text"] : ["text", "image"],
                            })
                          }
                          disabled={busy}
                        >
                          支持图片输入
                        </button>
                        <button
                          className={`chip${model.reasoning ? " on" : ""}`}
                          onClick={() => editModel(model.id, { reasoning: !model.reasoning })}
                          disabled={busy}
                        >
                          支持推理
                        </button>
                        <span className="rtag">上下文</span>
                        <input
                          className="pmctx"
                          type="number"
                          min={1}
                          defaultValue={model.contextWindow ?? DEFAULT_CONTEXT}
                          key={`${model.id}:${model.contextWindow ?? DEFAULT_CONTEXT}`}
                          title="上下文窗口（token）"
                          onBlur={(e) => { const next = Number(e.target.value) || DEFAULT_CONTEXT; if (next !== (model.contextWindow ?? DEFAULT_CONTEXT)) editModel(model.id, { contextWindow: next }); }}
                          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                          disabled={busy}
                        />
                      </div>
                      {rosterControl(model)}
                      {model.reasoning ? (
                        thinkingOf(model.id) ? (
                          <ThinkingLevels
                            modelRef={`${draft.id}/${model.id}`}
                            info={thinkingOf(model.id)!}
                            disabled={busy}
                            onSaved={onThinking}
                          />
                        ) : (
                          <div className="note">保存服务商后可以设置思考档。</div>
                        )
                      ) : null}
                    </div>
                    <button
                      className="rremove"
                      title="移除该模型"
                      disabled={busy}
                      onClick={() => void saveModels(draft.models.filter((item) => item.id !== model.id))}
                    >
                      <Icon name="close" size={13} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty>尚未添加模型。可获取模型列表后勾选，或手动填写模型 ID。</Empty>
            )}
            <ManualModel disabled={busy} onAdd={addModel} />
          </Group>

        </>
      )}
      {draft.kind === "builtin" && !draft.isNew ? <Group>{builtinModelList(draft.id)}</Group> : null}
      {rosterNotice ? <div className={rosterNotice === "已保存" ? "okline" : "badline"} role="status">{rosterNotice}</div> : null}
      {extra}
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
          placeholder="手动填写模型 ID，如 gpt-4o-mini"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          disabled={disabled}
        />
      </div>
      <button className="hob-btn" onClick={submit} disabled={disabled || !text.trim()}>
        添加
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
  return (
    <SaveRow saved={false} error={error}>
      {!error && dirty ? <span className="note">未保存的修改</span> : null}
      <button className="hob-btn" onClick={onCancel} disabled={busy}>
        取消
      </button>
      <button className="hob-btn hob-btn-primary" onClick={onSave} disabled={busy || !dirty}>
        {busy ? "正在验证…" : "保存"}
      </button>
    </SaveRow>
  );
}

/** 设置 → 模型：三层。模型页（默认模型、可用模型）→ 模型详情 / 添加模型。 */
function ModelsSection() {
  const s = useApp();
  const [view, setView] = useState<ModelsView | null>(null);
  useEffect(() => {
    void loadModels().then(setView);
  }, []);

  if (!view) return <Empty>正在读取模型列表…</Empty>;
  if (s.sub?.kind === "model") return <ModelDetail view={view} modelRef={s.sub.ref} />;
  if (s.sub?.kind === "addModels") return <AddModels view={view} />;
  return <ModelsHome view={view} />;
}

function modelUseState(entry: RosterEntry, info?: ModelInfo) {
  return {
    scores: entry.scores ?? guessModelScores(info ?? { id: entry.ref.split("/").at(-1) ?? entry.ref, name: "", reasoning: false }),
    unconfirmed: !entry.scores || entry.scoresConfirmed !== true,
  };
}

function ModelUseEditor({ entry, info, update, collapsible = false }: { entry: RosterEntry; info?: ModelInfo; update: (patch: Partial<RosterEntry>) => void; collapsible?: boolean }) {
  const initial = modelUseState(entry, info);
  const [expanded, setExpanded] = useState(!collapsible || initial.unconfirmed);
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
  if (!expanded) return <div className="ctl"><span className="note">{scoreSummary(entry.scores ?? scores)}</span><button className="hob-btn" onClick={() => setExpanded(true)}>修改</button></div>;
  const names = { smart: "聪明程度", cost: "成本", speed: "速度" } as const;
  return (
    <div className="group">
      <div className="note">Hob 按用途选择分派任务的模型。{initial.unconfirmed ? "数值按模型名称推测，请确认。" : ""}</div>
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
                aria-pressed={stage.label === scoreLabel(kind, scores[kind])}
                onClick={() => { const next = { ...latest.current, [kind]: stage.value }; setScores(next); save(next); }}>{stage.label}</button>
            ))}
          </div>
        </div>
      ))}
      <div className="field"><input value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => { if (note !== entry.note) update({ note }); }} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} placeholder="补充说明（选填），如「中文写作特别好」" /></div>
      {collapsible ? <div className="ctl"><button className="hob-btn" onClick={() => setExpanded(false)}>收起</button></div> : null}
    </div>
  );
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
    [models.conversation.ref === ref ? "对话" : null, models.work.ref === ref ? "任务执行" : null].filter(
      (role): role is string => role !== null,
    );
  return { models, save, setRoster, update, roles, feedback };
}

/** 子页顶部的返回（桌面上子页都有，手机用标题栏的）。 */
function SubBack({ label = "模型" }: { label?: string }) {
  return (
    <button className="subback" onClick={closeSub}>
      <Icon name="left" size={15} />
      {label}
    </button>
  );
}

function ModelsHome({ view }: { view: ModelsView }) {
  const { models, save, roles, feedback } = useModelSettings();
  const byRef = new Map(view.models.map((model) => [model.ref, model]));
  const pickOptions = (current: string) => [
    ...(models.roster.length ? [] : [{ value: "", text: "未设置" }]),
    ...models.roster
      .filter((entry) => byRef.has(entry.ref) || entry.ref === current)
      .map((entry) => ({ value: entry.ref, text: byRef.get(entry.ref)?.name ?? entry.ref })),
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

  return (
    <>
      <PageHead title="模型" desc="可用模型来自「服务商」，默认模型从可用模型中选择。" />
      <SaveFeedback message={feedback.message} toast />

      <Group>
        <div className="lbl">默认模型</div>
        <div className="group-card settings-card">
          {role("conversation", "对话", "对话模型")}
          {role("work", "任务执行", "默认任务模型")}
        </div>
        <div className="note">助手分派任务时未指定模型，使用任务执行的模型。</div>
        <div className="lbl">任务的思考档</div>
        <Seg items={[{ key: "auto", label: "助手按任务选择" }, { key: "fixed", label: "固定使用默认档" }]} value={models.thinkingChoice ?? "auto"} disabled={feedback.busy} onChange={(thinkingChoice) => save({ thinkingChoice })} />
        <div className="note">按任务选择时，助手会给简单的活用低档、复杂的活用高档；固定时一律使用上面设置的默认档。</div>
      </Group>

      <Group>
        <div className="lbl">可用模型</div>
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
                  <span className="mname">{name}</span>
                  <span className="sp" />
                  {info ? <CapIcons info={info} /> : <span className="mbad">不可用</span>}
                  <Icon name="chev" size={14} />
                </span>
                <span className="mprev">
                  {roles(entry.ref).map((label) => (
                    <span className="mrole" key={label}>
                      {label}
                    </span>
                  ))}
                  {scoreSummary(usage.scores)}
                  {usage.unconfirmed ? <span className="model-use-warning">请确认用途</span> : null}
                  {!info ? " · 该模型的服务商已删除或未配置 Key" : null}
                </span>
              </button>
            );
          })}
          <button className="maddrow" onClick={() => openSub({ kind: "addModels", title: "添加模型" })}>
            <Icon name="plus" size={16} />
            添加模型
          </button>
        </div>
        <div className="note">助手分派任务时，按用途说明在可用模型中选择。</div>
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
        <div className="lbl">用途说明</div>
        <ModelUseEditor entry={entry} info={info} update={(patch) => update(modelRef, patch)} />
      </Group>

      {info?.reasoning ? (
        <Group>
          <div className="group-card settings-card">
            <div className="mline">
              <span className="k">分派时的思考强度</span>
              <ThinkingPicker
                value={fitThinking(info, entry.thinking ?? models.work.thinking)}
                model={info}
                onChange={(thinking) => update(modelRef, { thinking })}
              />
            </div>
          </div>
          <div className="note">助手把任务分派给这个模型时使用。作为默认模型时，以「默认模型」中的设置为准。</div>
        </Group>
      ) : null}

      <Group>
        <div className="lbl">信息</div>
        <div className="kvcard">
          <div className="kvrow">
            <span className="k">服务商</span>
            <span className="v">{info?.provider ?? "不可用"}</span>
          </div>
          {info ? (
            <>
              <div className="kvrow">
                <span className="k kicon">
                  <Icon name="image" size={14} />
                  图片输入
                </span>
                <span className="v">{info.input.includes("image") ? "支持" : "不支持"}</span>
              </div>
              <div className="kvrow">
                <span className="k kicon">
                  <Icon name="bulb" size={14} />
                  推理
                </span>
                <span className="v">{info.reasoning ? "支持" : "不支持"}</span>
              </div>
              <div className="kvrow">
                <span className="k">上下文</span>
                <span className="v">{contextText(info.contextWindow)}</span>
              </div>
            </>
          ) : null}
        </div>
      </Group>

      <Group>
        <div className="lbl">危险操作</div>
        <div className="group-card settings-card">
          {confirming ? <div className="ctl" style={{ flexWrap: "wrap", padding: 12 }}><span>确定从可用模型中移除？</span><button className="hob-btn" onClick={() => setConfirming(false)}>取消</button><button className="hob-btn hob-btn-danger" onClick={() => setRoster(models.roster.filter((item) => item.ref !== modelRef))}>确认移除</button></div> : <button className="mline danger" disabled={used.length > 0} onClick={() => setConfirming(true)}>从可用模型中移除</button>}
        </div>
        {used.length ? (
          <div className="note">这是{used.join("和")}的默认模型。要移除，请先在「默认模型」中更换。</div>
        ) : null}
      </Group>
    </>
  );
}

function AddModels({ view }: { view: ModelsView }) {
  const { models, setRoster, roles, update, feedback } = useModelSettings();
  const [query, setQuery] = useState("");
  const chosen = new Set(models.roster.map((entry) => entry.ref));
  // 已经有模型加入的服务商一开始就展开，看得到选了哪些
  const [openGroups, setOpenGroups] = useState<string[]>(() => [
    ...new Set(view.models.filter((model) => chosen.has(model.ref)).map((model) => model.provider)),
  ]);
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
      <PageHead title="添加模型" desc="「服务商」提供的全部模型，打勾的已在可用模型中。" />
      <SaveFeedback message={feedback.message} toast />
      {view.models.length === 0 ? (
        <Group>
          <Empty>尚无可用模型。请先在「服务商」中配置服务商并填写 API Key。</Empty>
          <div className="ctl">
            <button className="hob-btn" onClick={() => setSection("providers")}>
              配置服务商
            </button>
          </div>
        </Group>
      ) : (
        <div className="group-card settings-card">
          <label className="mfind">
            <Icon name="search" size={15} />
            <input value={query} placeholder="搜索名称或引用，如 claude" onChange={(e) => setQuery(e.target.value)} />
          </label>
          {groups.length === 0 ? (
            <Empty>没有匹配的模型。</Empty>
          ) : (
            groups.map((group) => {
              const open = searching || openGroups.includes(group.provider);
              const picked = group.models.filter((model) => chosen.has(model.ref)).length;
              return (
                <Fragment key={group.provider}>
                  <button className="mgroup" aria-expanded={open} onClick={() => toggleGroup(group.provider)}>
                    <span className="n">{group.provider}</span>
                    <span className="c">{picked ? `已加入 ${picked} / ${group.models.length}` : group.models.length}</span>
                    <Icon name={open ? "down" : "chev"} size={14} />
                  </button>
                  {open
                    ? group.models.map((model) => {
                        const on = chosen.has(model.ref);
                        const locked = roles(model.ref).length > 0;
                        const entry = models.roster.find((item) => item.ref === model.ref);
                        return (
                          <div key={model.ref}>
                            <button
                              className={`madd${on ? " on" : ""}`}
                              disabled={locked}
                              title={locked ? "默认模型不能在这里移除" : on ? "从可用模型中移除" : "加入可用模型"}
                              onClick={() => toggle(model)}
                            >
                              <span className="mname">{model.name}</span>
                              <CapIcons info={model} />
                              <Icon name={on ? "check" : "plus"} size={16} className="mtog" />
                            </button>
                            {entry ? <div className="model-use-inline"><ModelUseEditor entry={entry} info={model} collapsible update={(patch) => update(model.ref, patch)} /></div> : null}
                          </div>
                        );
                      })
                    : null}
                </Fragment>
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
      <PageHead title="任务" desc="任务并行数、无响应判定时间，以及全部任务的任务记录。" />

      <Group>
        <div className="lbl">最大并行任务数</div>
        <div className="ctl">
          <Select value={String(work.maxJobs)} disabled={feedback.busy} onChange={(value) => void save({ maxJobs: Number(value) })} options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: String(n) }))} />
        </div>
        <div className="note">同时运行的最大任务数，超出后排队。</div>
        <SaveFeedback message={feedback.message} />
      </Group>

      <Group>
        <div className="lbl">无响应判定时间</div>
        <div className="lbl sub">任务</div>
        <div className="ctl">
          <AutoField value={String(work.jobStallMinutes)} onSave={(value) => save({ jobStallMinutes: Number(value) })} />
          <span className="note">分钟</span>
        </div>

        <div className="lbl sub">助手回复</div>
        <div className="ctl">
          <AutoField value={String(work.routerStallMinutes)} onSave={(value) => save({ routerStallMinutes: Number(value) })} />
          <span className="note">分钟</span>
        </div>
        <SaveFeedback message={feedback.message} />
        <div className="note">修改后立即生效，无需重启。</div>
      </Group>

      <Group>
        <div className="lbl">任务记录</div>
        <div className="ctl">
          <button className="hob-btn" onClick={() => openJobs()}>
            查看全部任务
          </button>
        </div>
        <div className="note">可查看每个任务的完整执行过程。</div>
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
  if (!view) return <Empty>正在读取推送设置…</Empty>;

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
      setDone(on ? "此设备将不再接收推送" : "此设备将接收推送");
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
      if (result.sent) setDone("测试通知已发送");
      else if (result.removed) {
        // 订阅已经失效被服务端删了：刷新列表，开关会显示成关
        setError("这台设备的订阅已失效，已移除；请重新开启本机推送");
        void loadPush().then((next) => next.ok && setView(next.view));
      } else setDone("未发送：这台设备尚未订阅");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title="通知" desc="本机推送与已订阅的设备。" />

      <Group>
        <div className="lbl">本机推送</div>
        {supported ? (
          <div className="ctl">
            <span style={{ fontSize: 14 }}>需要确认或任务受阻时推送给我</span>
            <span className="sp" />
            <button
              className={`tog${on ? "" : " off"}`}
              title={on ? "关闭本机推送" : "开启本机推送"}
              onClick={() => void toggle()}
              disabled={busy}
            />
          </div>
      ) : (
          <div className="note">这个浏览器不支持推送：请使用 Chrome、Edge、Safari 16.4+，或在 iPhone 上将 Hob 添加到主屏幕。</div>
        )}
        {denied ? (
          <div className="note">
            浏览器已拒绝通知权限：点击地址栏左侧的图标 → 通知 → 允许，然后刷新本页并重新开启。
          </div>
        ) : null}
        <div className="note">页面在前台时不推送，页面不在前台或锁屏时才推送。各助手还需在助手设置中开启「需要确认时通知我」。</div>
        <div className="note">在 iPhone 上需先将 Hob 添加到主屏幕，再从主屏幕打开才能接收推送。</div>
      </Group>

      <Group>
        <div className="lbl">已订阅的设备</div>
        {view.devices.length ? (
          view.devices.map((device) => (
            <div className="dev" key={device.endpoint}>
              <span className="n">{device.label}</span>
              <span className="tm">{fmtWhen(device.createdAt)}</span>
              <span className="sp" />
              {confirmEndpoint === device.endpoint ? <><span className="note">确认删除？</span><button className="hob-btn" onClick={() => setConfirmEndpoint(null)}>取消</button><button className="hob-btn hob-btn-danger" onClick={() => void drop(device.endpoint)}>确认删除</button></> : <button className="del" title="删除这台设备" onClick={() => setConfirmEndpoint(device.endpoint)}>删除</button>}
            </div>
          ))
        ) : (
          <Empty>暂无已订阅的设备</Empty>
        )}
        <div className="ctl">
          <button className="hob-btn" onClick={() => void test()} disabled={busy || !view.devices.length}>
            发送测试通知
          </button>
          {done && !error ? <span className="okline">{done}</span> : null}
          {error ? <span className="badline">{error}</span> : null}
        </div>
      </Group>

      <Group>
        <div className="lbl">推送服务联系邮箱（选填）</div>
        <AutoField placeholder="name@example.com" value={s.settings.settings.push.email} onSave={(email) => feedback.save({ push: { email: email.trim() } })} />
        <SaveFeedback message={feedback.message} />
        <div className="note">推送服务使用此地址联系你；留空使用 Hob 的项目主页。</div>
      </Group>
    </>
  );
}

const LORE_SAAS = "https://api.loremem.com";
/** 注册 / 登录入口：Token 小标题右边那个链接。 */
const LORE_LINKS = { saas: "https://app.loremem.com/login" };

const DEPLOYMENTS: { key: "saas" | "self"; label: string }[] = [
  { key: "saas", label: "Lore 云服务" },
  { key: "self", label: "自部署" },
];

const PROVIDERS: { key: MemoryProvider; label: string }[] = [
  { key: "local", label: "本地记忆" },
  { key: "lore", label: "Lore" },
  { key: "off", label: "关闭" },
];

const TEST_REASONS: Record<Exclude<LoreTestResult, { ok: true }>["reason"], string> = {
  invalid_url: "服务地址无效。",
  insecure_http: "公网地址必须使用 https，明文 http 仅允许本机或局域网地址。",
  missing_token: "缺少 API Token。",
  unauthorized: "API Token 被拒绝。",
  unreachable: "无法连接该地址。",
};

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
  if (!config) return <Empty>正在读取记忆设置…</Empty>;

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
      setTest({ ok: true, text: "已连接" });
    } else {
      setTest({ ok: false, text: TEST_REASONS[outcome.result.reason] });
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
        setError(TEST_REASONS[outcome.result.reason]);
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

  const statusText =
    config.provider === "lore"
      ? config.lore.configured
        ? `Lore · 已连接 · 插件 ${config.lorePlugin}`
        : "Lore · 尚未配置完成：请填写服务地址与 API Token 后保存"
      : config.provider === "local"
        ? "本地记忆 · 已启用"
        : "关闭 · 助手不使用长期记忆";

  return (
    <>
      <PageHead
        title="记忆"
        desc="所有助手共用同一份长期记忆。各助手需要知道的专属事实写在助手设置的「补充说明」中。"
      />

      <Group>
        <div className="lbl">提供者</div>
        <Seg items={PROVIDERS} value={shown} onChange={(next) => void changeProvider(next)} disabled={busy} />
        <div className="sline">{statusText}</div>
        <SaveFeedback message={error ?? (saved ? "已保存" : null)} />
      </Group>

      {shown === "lore" ? (
        <>
          <Group>
            <div className="formcard">
            <div className="lbl">部署方式</div>
            <Seg items={DEPLOYMENTS} value={deployment} onChange={chooseDeployment} disabled={busy} />
            <div className="lbl">服务地址</div>
            {deployment === "saas" ? (
              <div className="field ro">{LORE_SAAS}</div>
            ) : (
              <div className="field">
                <input
                  value={baseUrl}
                  placeholder="http://127.0.0.1:18901"
                  onChange={(e) => edit(() => setBaseUrl(e.target.value))}
                  disabled={busy}
                />
              </div>
            )}
            <div className="lblrow">
              <span className="lbl">Token</span>
              <a className="link" href={LORE_LINKS.saas} target="_blank" rel="noreferrer">
                注册 / 登录 Lore
              </a>
            </div>
            <div className="field">
              <input
                type="password"
                value={token}
                placeholder={tokenKept ? "已保存，留空不变" : "lm_…"}
                onChange={(e) => edit(() => setToken(e.target.value))}
                disabled={busy}
              />
            </div>
            <SaveRow saved={saved && !dirty} error={error} lead={<>
              <button className="hob-btn" onClick={() => void runTest()} disabled={busy || baseUrl.trim() === ""}>
                测试连接
              </button>
              {test ? <span className={test.ok ? "okline" : "badline"}>{test.text}</span> : null}
            </>}>
              {!error && dirty ? <span className="note">未保存的修改</span> : null}
              <button className="hob-btn" onClick={() => void loadMemory().then((r) => (r.ok ? reset(r.config) : setLoadError(r.error)))} disabled={busy || !dirty}>取消</button>
              <button className="hob-btn hob-btn-primary" onClick={() => void commit()} disabled={busy || !dirty}>{busy ? "正在验证…" : "保存"}</button>
            </SaveRow>
            </div>
          </Group>

          <Group>
            <div className="lbl">本机配置</div>
            <div className="ctl" style={{ gap: 10, flexWrap: "wrap" }}>
              <button className="hob-btn" onClick={() => void importFromLocal()} disabled={busy}>
                {busy ? "正在导入…" : "从本机导入"}
              </button>
              {loreImported ? <span className="okline">已导入本机的连接</span> : null}
            </div>
            <div className="note">读取这台电脑上已保存的 Lore 连接，导入后无需重新填写。</div>
            {loreSource ? <div className="sline">来源：{loreSource.source}</div> : null}
            {loreSource && !loreSource.found ? <div className="note">未找到可导入的配置。</div> : null}
            {loreImportError ? <div className="badline">{loreImportError}</div> : null}
          </Group>
        </>
      ) : null}

    </>
  );
}

const IMAGE_SOURCES: { key: ImageSettings["source"]; label: string }[] = [
  { key: "off", label: "关闭" },
  { key: "openai", label: "OpenAI 兼容接口" },
];

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
  useEffect(() => { void loadEmbeddingKey().then((value) => setConfigured(value.keyConfigured)).catch((e: unknown) => setMessage({ ok: false, text: `读取设置失败：${e instanceof Error ? e.message : String(e)}` })); }, []);
  const form: EmbeddingSettings = source === "off" ? { source: "off" } : { source: "openai", baseUrl: normalizeBase(baseUrl), model: model.trim() };
  const run = async (save: boolean) => {
    setBusy(true); setMessage(null);
    try {
      if (save) {
        const result = await saveEmbedding(form, apiKey.trim() || undefined);
        setConfigured(result.keyConfigured); setApiKey(""); setMessage({ ok: true, text: "已保存" });
      } else {
        const result = await testEmbedding({ embedding: form, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
        setMessage(result.ok ? { ok: true, text: `连接成功 · ${result.dims} 维` } : { ok: false, text: result.error });
      }
    } catch (e) { setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) }); }
    finally { setBusy(false); }
  };
  return <>
    <PageHead title="知识库" desc="配置向量模型，关闭时只按关键词查找。" />
    <Group><div className="lbl">向量模型</div><Seg items={[{ key: "off", label: "关闭" }, { key: "openai", label: "OpenAI 兼容接口" }]} value={source} onChange={setSource} disabled={busy} /></Group>
    {source === "openai" ? <Group><div className="formcard">
      <div className="lbl">服务地址</div><div className="field"><input aria-label="服务地址" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={busy} placeholder="http://127.0.0.1:8080/v1" /></div>
      <div className="lbl">模型名称</div><div className="field"><input aria-label="模型名称" value={model} onChange={(e) => setModel(e.target.value)} disabled={busy} /></div>
      <div className="lbl">API Key</div><div className="field"><input aria-label="API Key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} disabled={busy} placeholder={configured ? "已保存，留空不变" : "请输入 API Key"} /></div>
      <SaveRow saved={message?.text === "已保存"} error={null} lead={<>
        <button className="hob-btn" disabled={busy} onClick={() => void run(false)}>测试连接</button>
        {message && message.text !== "已保存" ? <span className={message.ok ? "okline" : "badline"} role="status">{message.text}</span> : null}
      </>}><button className="hob-btn hob-btn-primary" disabled={busy} onClick={() => void run(true)}>保存</button></SaveRow>
    </div><div className="note">建索引和查询时，文件内容和问题会发给这个接口。</div></Group> : <SaveRow saved={message?.text === "已保存"} error={message?.ok === false ? message.text : null}><button className="hob-btn hob-btn-primary" disabled={busy} onClick={() => void run(true)}>保存</button></SaveRow>}
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
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!savedNote) return;
    const timer = setTimeout(() => setSavedNote(null), 3000);
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
      setTest({ ok: true, text: "生成成功", path: outcome.path });
    } else {
      setTestedForm(null);
      setTest({ ok: false, text: outcome.error });
    }
  };

  const commit = async () => {
    if (busy || !dirty) return;
    setBusy(true);
    setError(null);
    setSavedNote(null);
    if (form.source === "openai" && testedForm !== fingerprint) {
      const tested = await testImage({ image: form, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      if (!tested.ok) {
        setBusy(false);
        setTestedForm(null);
        setError(`测试连接失败：${tested.error}`);
        return;
      }
      setTestedForm(fingerprint);
      setTest({ ok: true, text: "生成成功", path: tested.path });
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
    setSavedNote("已保存");
  };

  return (
    <>
      <PageHead
        title="图像生成"
        desc="选择图像生成方式：关闭，或使用 OpenAI 兼容接口。配置完成后，开启了图像生成能力的助手可以在任务中生成图片。"
      />

      <Group>
        <div className="lbl">生成方式</div>
        <Seg
          items={IMAGE_SOURCES}
          value={source}
          onChange={(key) => {
            setTest(null);
            setError(null);
            setSavedNote(null);
            if (key === "off" && saved.source !== "off") {
              setBusy(true);
              void saveImage({ source: "off" }).then((result) => {
                setBusy(false);
                if (!result.ok) { setError(result.error); return; }
                setSource("off");
                setApiKey("");
                setSavedNote("已保存");
              });
            } else setSource(key);
          }}
          disabled={busy}
        />
      </Group>

      {source === "openai" ? (
        <Group>
          <div className="formcard">
          <div className="lbl">服务地址</div>
          <div className="field">
            <input
              value={baseUrl}
              placeholder="http://127.0.0.1:8080/v1"
              onChange={(e) => setBaseUrl(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="lbl">模型名称</div>
          <div className="field">
            <input
              value={model}
              placeholder="gpt-image-1"
              onChange={(e) => setModel(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="lbl">默认尺寸</div>
          <div className="ctl">
            <Select className="grow" value={size} onChange={setSize} disabled={busy} options={[{ value: "", label: "不指定，使用接口默认值" }, ...IMAGE_SIZES.map((item) => ({ value: item, label: item }))]} />
          </div>
          <div className="lbl">API Key</div>
          <div className="field">
            <input
              type="password"
              value={apiKey}
              placeholder={keyConfigured ? "已保存，留空不变" : "sk-…"}
              onChange={(e) => setApiKey(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="note">
            API Key 只保存在本机，保存后不再显示。保存前会生成测试图片，可能产生费用。
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
                    title="查看原图"
                  >
                    <img src={fileUrl(test.path)} alt="生成的图片" />
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
          ) : null}
      <SaveRow saved={savedNote !== null && !dirty} error={error} lead={<button className="hob-btn" onClick={() => void runTest()} disabled={busy}>{busy ? "正在生成…" : "生成测试图片"}</button>}>
        {!error && dirty ? <span className="note">未保存的修改</span> : null}
        <button className="hob-btn" disabled={busy || !dirty} onClick={() => {
          setSource(saved.source);
          setBaseUrl(saved.source === "openai" ? saved.baseUrl : "");
          setModel(saved.source === "openai" ? saved.model : "");
          setSize(saved.source === "openai" ? saved.size ?? "" : "");
          setApiKey("");
          setTest(null);
          setTestedForm(null);
          setError(null);
        }}>取消</button>
        <button className="hob-btn hob-btn-primary" onClick={() => void commit()} disabled={busy || !dirty}>
          {busy ? "正在验证…" : "保存"}
        </button>
      </SaveRow>
          </div>
        </Group>
      ) : <SaveFeedback message={error ?? savedNote} />}
    </>
  );
}

const SKILL_SOURCE_LABEL: Record<SkillView["source"], string> = { hob: "Hob 的技能", common: "通用技能 · ~/.agents/skills", lore: "Lore 技能" };
const SKILL_IMPORT_SOURCES: { key: SkillImportSource; label: string }[] = [
  { key: "claude", label: "Claude Code" },
  { key: "codex", label: "Codex" },
  { key: "pi", label: "pi" },
];
const skillKey = (skill: SkillView) => `${skill.source}:${skill.id}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** 技能页：三组列表（Hob / 通用 / Lore），整行点进详情，行尾是启用开关；导入和详情是子页。 */
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
    if (await saveSettings({ skills: { disabled } })) await refresh(); else setError(getState().notice ?? "保存失败");
  };
  const done = (message: string) => { void refresh(); setNotice(message); closeSub(); };

  if (!view) return error ? <div className="badline">{error}</div> : <Empty>正在读取技能…</Empty>;
  if (sub?.kind === "skill") return <SkillDetail skill={view.skills.find((skill) => skillKey(skill) === sub.key)} onDeleted={done} />;
  if (sub?.kind === "importSkills") return <ImportSkills onDone={done} />;

  const rows = (skills: SkillView[], empty: string) =>
    skills.length ? skills.map((skill) => (
      <div className={`list-row setting-row${skill.enabled ? "" : " gone"}`} key={skillKey(skill)}>
        <button className="rmain rbtn" onClick={() => openSub({ kind: "skill", key: skillKey(skill), title: skill.name })}>
          <div className="rname">
            {skill.name}
            {skill.overridden ? <span className="rtag">被同名技能覆盖</span> : null}
          </div>
          <div className="rprov rclamp">{skill.description}</div>
        </button>
        <button className={`tog${skill.enabled ? "" : " off"}`} aria-label={`${skill.name}启用`} aria-pressed={skill.enabled} onClick={() => void toggle(skill)} />
      </div>
    )) : <Empty>{empty}</Empty>;
  const hob = view.skills.filter((x) => x.source === "hob");
  return (
    <>
      <PageHead title="技能" desc="技能是写好的做法说明，任务按需读取。同名时 Hob 的技能优先，其次是 Lore，最后是通用技能。" />
      <Group>
        <div className="lbl">Hob 的技能</div>
        <div className="group-card settings-card">
          {rows(hob, "还没有技能，可以从其他工具导入")}
          <button className="maddrow" onClick={() => openSub({ kind: "importSkills", title: "导入技能" })}>
            <Icon name="plus" size={16} />
            从 Claude Code、Codex、pi 导入
          </button>
        </div>
        {notice ? <div className="okline">{notice}</div> : null}
      </Group>
      <Group>
        <div className="lbl">通用技能 <span className="lbl-aside">~/.agents/skills</span></div>
        <div className="group-card settings-card">{rows(view.skills.filter((x) => x.source === "common"), "目录中没有技能")}</div>
      </Group>
      <Group>
        <div className="lbl">Lore 技能{view.loreActive && view.loreUrl ? <a className="lbl-aside" href={view.loreUrl} target="_blank" rel="noreferrer">在 Lore 控制台管理</a> : null}</div>
        {view.loreError ? <div className="badline" role="alert">{view.loreError} <button onClick={() => void refresh()}>重试</button></div>
          : view.loreActive
          ? <div className="group-card settings-card">{rows(view.skills.filter((x) => x.source === "lore"), "Lore 中没有技能")}</div>
          : <div className="note">在 设置 → 记忆 中连接 Lore 后，这里会列出 Lore 中的技能。</div>}
      </Group>
      {error ? <div className="badline" role="alert">{error}</div> : null}
    </>
  );
}

function SkillDetail({ skill, onDeleted }: { skill: SkillView | undefined; onDeleted: (message: string) => void }) {
  const [error, setError] = useState<string | null>(null);
  if (!skill) return <><SubBack label="技能" /><div className="note">技能不存在或已删除。</div></>;
  const remove = async () => {
    if (!window.confirm(`删除技能「${skill.name}」？此操作不能撤销。`)) return;
    try { await deleteSkill(skill.id); onDeleted(`已删除「${skill.name}」`); } catch (e) { setError(errText(e)); }
  };
  return (
    <>
      <SubBack label="技能" />
      <PageHead title={skill.name} desc={skill.description} />
      <div className="sline">{SKILL_SOURCE_LABEL[skill.source]}{skill.overridden ? " · 被优先级更高的同名技能覆盖" : ""}{skill.enabled ? "" : " · 已停用"}</div>
      <Markdown className="skill-doc fp-md markdown-body" text={skill.content} />
      {skill.source === "hob" ? (
        <SaveRow saved={false} error={error}>
          <button className="hob-btn hob-btn-danger" onClick={() => void remove()}>删除技能</button>
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
      if (problems.length) setError(problems.join("；"));
      else onDone(`已导入 ${result.imported.length} 个技能`);
    } catch (e) { setError(errText(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <SubBack label="技能" />
      <PageHead title="导入技能" desc="从其他工具的技能目录复制到 Hob，来源只读。" />
      <Group>
        <Seg items={SKILL_IMPORT_SOURCES} value={source} onChange={setSource} disabled={busy} />
      </Group>
      <Group>
        {view === null ? (error ? null : <Empty>正在读取…</Empty>) : !view.found ? (
          <Empty>未找到这个工具的技能目录。</Empty>
        ) : (
          <div className="group-card settings-card">
            {view.skills.length ? view.skills.map((skill) => (
              <label className="list-row setting-row" key={skill.id}>
                <input type="checkbox" className="rcheck" checked={chosen.includes(skill.id)} disabled={busy}
                  onChange={(e) => setChosen(e.target.checked ? [...chosen, skill.id] : chosen.filter((id) => id !== skill.id))} />
                <div className="rmain">
                  <div className="rname">{skill.name}{skill.exists ? <span className="rtag">已存在</span> : null}</div>
                  <div className="rprov rclamp">{skill.description}</div>
                </div>
              </label>
            )) : <Empty>目录中没有技能</Empty>}
          </div>
        )}
        {view?.skipped.map((message) => <div className="note" key={message}>{message}</div>)}
      </Group>
      {view?.skills.some((skill) => skill.exists) ? (
        <label className="ctl skill-overwrite">
          <input type="checkbox" className="rcheck" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} />
          覆盖已存在的同名技能
        </label>
      ) : null}
      <SaveRow saved={false} error={error}>
        <button className="hob-btn" onClick={closeSub} disabled={busy}>取消</button>
        <button className="hob-btn hob-btn-primary" disabled={busy || !chosen.length} onClick={() => void commit()}>{busy ? "正在导入…" : chosen.length ? `导入 ${chosen.length} 个` : "导入所选"}</button>
      </SaveRow>
    </>
  );
}

/* ---------------- MCP ---------------- */

const MCP_SOURCE_LABEL: Record<"pi" | "claude" | "cursor", string> = { pi: "pi", claude: "Claude Code", cursor: "Cursor" };

/** 每个服务一行连接状态（页面加载时测一次；详情里可以重测）。 */
interface McpProbe {
  state: "probing" | "connected" | "failed" | "needs_auth";
  tools?: { name: string; description: string }[];
  error?: string;
  stderrTail?: string[];
}

function mcpStatusText(server: McpServerView, probe: McpProbe | undefined): string {
  if (!server.valid) return "配置无效";
  if (!server.enabled) return "已停用";
  if (!probe) return "未测试";
  if (probe.state === "probing") return "检测中…";
  if (probe.state === "connected") return probe.tools?.length ? `已连接 · ${probe.tools.length} 个工具` : "已连接 · 没有工具";
  if (probe.state === "needs_auth") return "需要登录，暂不支持";
  return "连接失败";
}

/** MCP 页：列表 → 详情 / 添加 / 从本机导入（照服务商页的三层结构）。 */
function McpSection() {
  const sub = useApp().sub;
  const [view, setView] = useState<McpView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, McpProbe>>({});
  const probed = useRef(new Set<string>());

  useEffect(() => {
    void loadMcp().then(setView).catch((e) => setLoadError(errText(e)));
  }, []);
  useEffect(() => {
    if (sub) setNotice(null);
  }, [sub]);

  const probe = async (server: McpServerView, refresh = false) => {
    if (!server.valid) return;
    setProbes((current) => ({ ...current, [server.name]: { state: "probing" } }));
    try {
      const result = await testMcpServer(server.name, refresh);
      setProbes((current) => ({
        ...current,
        [server.name]: result.ok ? { state: "connected", tools: result.tools } : { state: result.state, error: result.error, stderrTail: result.stderrTail },
      }));
    } catch {
      setProbes((current) => ({ ...current, [server.name]: { state: "failed", error: "无法测试连接" } }));
    }
  };

  // 首次加载：启用中的服务逐个测一次（服务端限并发，30 秒内有缓存的直接同）
  useEffect(() => {
    if (!view) return;
    for (const server of view.servers) {
      if (!server.valid || !server.enabled || probed.current.has(server.name)) continue;
      probed.current.add(server.name);
      void probe(server);
    }
  }, [view]);

  const done = (message: string) => {
    void loadMcp().then(setView).catch(() => undefined);
    setNotice(message);
    closeSub();
  };

  if (loadError) return <><PageHead title="MCP" desc="任务可以调用 MCP 服务提供的工具。" /><div className="badline" role="alert">{loadError}</div><div className="note">请修复数据目录 engine/mcp.json 后重试；修复前任务不会加载 MCP 服务。</div></>;
  if (!view) return <Empty>正在读取 MCP 服务…</Empty>;

  if (sub?.kind === "mcpServer") {
    return <McpDetail server={view.servers.find((item) => item.name === sub.name)} setView={setView} probe={probes[sub.name]} onProbe={probe} onDone={done} />;
  }
  if (sub?.kind === "addMcp") return <McpAdd onDone={done} />;
  if (sub?.kind === "importMcp") return <McpImport onDone={done} />;

  const kindLabel = (server: McpServerView) => (server.kind === "http" ? "远程地址" : "本地命令");
  const toggle = async (server: McpServerView) => {
    try {
      const next = await patchMcpServer(server.name, { enabled: !server.enabled });
      setView(next);
      if (!server.enabled) for (const item of next.servers) if (item.name === server.name && item.valid) void probe(item, true);
    } catch (e) {
      setNotice(errText(e));
    }
  };

  return (
    <>
      <PageHead
        title="MCP"
        desc="任务可以调用 MCP 服务提供的工具，所有助手派出的任务共用这份配置；对话不直接使用。配置改动对之后新开的任务生效，进行中的任务不受影响。"
      />
      <Group>
        <div className="ctl">
          <button className="hob-btn hob-btn-primary" onClick={() => openSub({ kind: "addMcp", title: "添加 MCP 服务" })}>添加服务</button>
          <span className="sp" />
          <button className="hob-btn" onClick={() => openSub({ kind: "importMcp", title: "从本机导入 MCP 服务" })}>从本机导入</button>
        </div>
        <div className="lbl">已配置的服务</div>
        <div className="group-card settings-card">
          {view.servers.map((server) => (
            <div className={`list-row setting-row${server.enabled && server.valid ? "" : " gone"}`} key={server.name}>
              <button className="rmain rbtn" onClick={() => openSub({ kind: "mcpServer", name: server.name, title: server.name })}>
                <div className="rname">{server.name}{server.valid ? null : <span className="rtag">配置无效</span>}</div>
                <div className="rprov rclamp">{server.valid ? (server.kind === "http" ? server.url : [server.command, ...(server.args ?? [])].join(" ")) : server.invalidReason}</div>
              </button>
              <span className="note" style={{ flex: "none" }}>{`${kindLabel(server)} · ${mcpStatusText(server, probes[server.name])}`}</span>
              {server.valid ? (
                <button className={`tog${server.enabled ? "" : " off"}`} aria-label={`${server.name}启用`} aria-pressed={server.enabled} onClick={() => void toggle(server)} />
              ) : null}
            </div>
          ))}
          {!view.servers.length ? <Empty>还没有配置 MCP 服务</Empty> : null}
        </div>
        {notice ? <div className={notice.startsWith("已") ? "okline" : "badline"} role="status">{notice}</div> : null}
        <div className="note">环境变量和请求头的值只保存在本机，保存后不再显示。远程服务需要 OAuth 登录时这版暂不支持。</div>
      </Group>
    </>
  );
}

/** 键值对编辑（环境变量 / 请求头）：已保存的值不回显，留空表示沿用。 */
interface PairDraft {
  key: string;
  value: string;
  /** 已保存的是密钥：留空 = 沿用已存的值 */
  secret: boolean;
}

function pairDrafts(secrets: Record<string, { redacted: boolean; value?: string }> | undefined): PairDraft[] {
  return Object.entries(secrets ?? {}).map(([key, item]) => ({ key, value: item.redacted ? "" : (item.value ?? ""), secret: item.redacted }));
}

function pairMutations(existing: Record<string, { redacted: boolean; value?: string }> | undefined, rows: PairDraft[]): Record<string, McpSecretMutation> | undefined {
  const mutations: Record<string, McpSecretMutation> = {};
  const present = new Set(rows.filter((row) => row.key.trim()).map((row) => row.key.trim()));
  for (const key of Object.keys(existing ?? {})) {
    if (!present.has(key)) mutations[key] = { mode: "remove" };
  }
  for (const row of rows) {
    const key = row.key.trim();
    if (!key) continue;
    if (row.value === "" && row.secret) mutations[key] = { mode: "preserve" };
    else if (row.value !== "") mutations[key] = { mode: "replace", value: row.value };
  }
  return Object.keys(mutations).length ? mutations : undefined;
}

function SecretPairs({ rows, onChange, keyLabel, valueLabel }: { rows: PairDraft[]; onChange: (rows: PairDraft[]) => void; keyLabel: string; valueLabel: string }) {
  const update = (index: number, patch: Partial<PairDraft>) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="pairlist">
      {rows.map((row, index) => (
        <div className="pairrow" key={index}>
          <label className="field"><input className="mono" value={row.key} placeholder={keyLabel} onChange={(e) => update(index, { key: e.target.value })} /></label>
          <label className="field"><input className="mono" type="password" value={row.value} placeholder={row.secret && row.value === "" ? "已保存，留空不变" : valueLabel} onChange={(e) => update(index, { value: e.target.value })} /></label>
          <button className="hob-icon-btn" title="删除这一项" onClick={() => onChange(rows.filter((_, i) => i !== index))}><Icon name="close" size={15} /></button>
        </div>
      ))}
      <div>
        <button className="hob-btn" onClick={() => onChange([...rows, { key: "", value: "", secret: false }])}>添加一项</button>
      </div>
    </div>
  );
}

interface McpFormDraft {
  kind: "stdio" | "http";
  command: string;
  args: string;
  env: PairDraft[];
  cwd: string;
  url: string;
  headers: PairDraft[];
  description: string;
}

const EMPTY_MCP_DRAFT: McpFormDraft = { kind: "stdio", command: "", args: "", env: [], cwd: "", url: "", headers: [], description: "" };

function mcpDraftFrom(server: McpServerView): McpFormDraft {
  return {
    kind: server.kind ?? "stdio",
    command: server.command ?? "",
    args: (server.args ?? []).join("\n"),
    env: pairDrafts(server.env),
    cwd: server.cwd ?? "",
    url: server.url ?? "",
    headers: pairDrafts(server.headers),
    description: server.description ?? "",
  };
}

/** 添加 / 编辑表单。保存走 PUT；密钥按「保留 / 替换 / 删除」逐键提交，未动的不回传。 */
function McpForm({ initial, name, onName, fixedName, onSaved, saveLabel }: { initial: McpFormDraft; name: string; onName?: (name: string) => void; fixedName: boolean; onSaved: (message: string) => void; saveLabel: string }) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (part: Partial<McpFormDraft>) => setDraft((current) => ({ ...current, ...part }));

  const submit = async () => {
    setError(null);
    const trimmed = name.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(trimmed)) {
      setError("名称只能用字母、数字、_ 和 -，最长 64 字符。");
      return;
    }
    // 已存的是密钥的键只报 redacted；未打码的（${VAR} 引用）带着原值回来，编辑后原样提交
    const storedEnv = Object.fromEntries(initial.env.map((row) => [row.key, row.secret ? { redacted: true } : { redacted: false, value: row.value }]));
    const storedHeaders = Object.fromEntries(initial.headers.map((row) => [row.key, row.secret ? { redacted: true } : { redacted: false, value: row.value }]));
    const envMutations = pairMutations(initial.env.length ? storedEnv : undefined, draft.env);
    const headerMutations = pairMutations(initial.headers.length ? storedHeaders : undefined, draft.headers);
    setBusy(true);
    try {
      await putMcpServer(trimmed, {
        kind: draft.kind,
        ...(draft.kind === "stdio"
          ? {
              command: draft.command.trim(),
              ...(draft.args.trim() ? { args: draft.args.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) } : {}),
              ...(draft.cwd.trim() ? { cwd: draft.cwd.trim() } : {}),
              ...(envMutations ? { env: envMutations } : {}),
            }
          : {
              url: draft.url.trim(),
              ...(headerMutations ? { headers: headerMutations } : {}),
            }),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      });
      onSaved(fixedName ? `已保存「${trimmed}」` : `已添加「${trimmed}」`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="formcard">
      <div className="lbl">名称</div>
      <div className="field"><input className="mono" value={name} readOnly={fixedName} placeholder="如 filesystem" onChange={(e) => onName?.(e.target.value)} /></div>
      {fixedName ? null : <div className="note">字母、数字、_ 和 -；- 和 _ 视为同名。改名请删除后重新添加。</div>}
      <div className="lbl">类型</div>
      <Seg items={[{ key: "stdio", label: "本地命令" }, { key: "http", label: "远程地址" }]} value={draft.kind} onChange={(kind) => patch({ kind })} disabled={busy} />
      <div className={`expand settings-motion${draft.kind === "stdio" ? " open" : ""}`} inert={draft.kind !== "stdio"}>
        <div>
          <div className="lbl">命令</div>
          <div className="field"><input className="mono" value={draft.command} placeholder="如 npx 或 uvx（一个可执行文件，不是整条命令行）" onChange={(e) => patch({ command: e.target.value })} /></div>
          <div className="lbl">参数</div>
          <div className="field"><textarea className="mono" rows={3} value={draft.args} placeholder={"-y\n@modelcontextprotocol/server-filesystem\n."} onChange={(e) => patch({ args: e.target.value })} /></div>
          <div className="note">一行一个参数。</div>
          <div className="lbl">环境变量</div>
          <SecretPairs rows={draft.env} onChange={(env) => patch({ env })} keyLabel="变量名" valueLabel="值" />
          <div className="lbl">工作目录</div>
          <div className="field"><input className="mono" value={draft.cwd} placeholder="可空；相对路径按任务的工作目录解析" onChange={(e) => patch({ cwd: e.target.value })} /></div>
        </div>
      </div>
      <div className={`expand settings-motion${draft.kind === "http" ? " open" : ""}`} inert={draft.kind !== "http"}>
        <div>
          <div className="lbl">地址</div>
          <div className="field"><input className="mono" value={draft.url} placeholder="https://example.com/mcp（streamable HTTP，不支持 /sse 结尾）" onChange={(e) => patch({ url: e.target.value })} /></div>
          <div className="lbl">请求头</div>
          <SecretPairs rows={draft.headers} onChange={(headers) => patch({ headers })} keyLabel="名称" valueLabel="值" />
        </div>
      </div>
      <div className="lbl">说明</div>
      <div className="field"><input value={draft.description} placeholder="这个服务提供什么，一句话（可空）" onChange={(e) => patch({ description: e.target.value })} /></div>
      {error ? <div className="badline" role="alert">{error}</div> : null}
      <SaveRow saved={false} error={null}>
        <button className="hob-btn hob-btn-primary" disabled={busy} onClick={() => void submit()}>{busy ? "正在保存…" : saveLabel}</button>
      </SaveRow>
    </div>
  );
}

function McpAdd({ onDone }: { onDone: (message: string) => void }) {
  const [name, setName] = useState("");
  return (
    <>
      <SubBack label="MCP" />
      <PageHead title="添加 MCP 服务" desc="本地命令（stdio）或远程地址（streamable HTTP）。保存后可以在详情里测试连接并开关单个工具。" />
      <Group>
        <McpForm initial={EMPTY_MCP_DRAFT} name={name} onName={setName} fixedName={false} onSaved={onDone} saveLabel="添加" />
      </Group>
    </>
  );
}

/** 详情：状态与提供方式、测试连接、工具开关、编辑、删除。 */
function McpDetail({
  server,
  setView,
  probe,
  onProbe,
  onDone,
}: {
  server: McpServerView | undefined;
  setView: (view: McpView) => void;
  probe: McpProbe | undefined;
  onProbe: (server: McpServerView, refresh?: boolean) => Promise<void>;
  onDone: (message: string) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (!server) closeSub();
  }, [server]);
  if (!server) return null;

  const hiddenTools = server.hiddenTools ?? [];
  const tools = probe?.state === "connected" ? (probe.tools ?? []) : undefined;

  const patchServer = async (patch: { enabled?: boolean; exposure?: "direct" | "deferred"; hiddenTools?: string[] }) => {
    setBusy(true);
    setError(null);
    try {
      const next = await patchMcpServer(server.name, patch);
      setView(next);
      return next;
    } catch (e) {
      setError(errText(e));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      await onProbe(server, true);
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`删除 MCP 服务「${server.name}」？此操作不能撤销。`)) return;
    try {
      setView(await deleteMcpServer(server.name));
      onDone(`已删除「${server.name}」`);
    } catch (e) {
      setError(errText(e));
    }
  };

  const kindText = server.kind === "http" ? "远程地址" : "本地命令";
  return (
    <>
      <SubBack label="MCP" />
      <PageHead title={server.name} desc={server.description ?? (server.valid ? `${kindText}的 MCP 服务` : server.invalidReason)} />
      {!server.valid ? (
        <Group>
          <div className="badline" role="alert">配置无效：{server.invalidReason}</div>
          <div className="note">删除后重新添加，或在下方按表单保存一次即可修复。</div>
        </Group>
      ) : (
        <Group>
          <div className="ctl">
            <span style={{ fontSize: 14 }}>启用</span>
            <span className="sp" />
            <button className={`tog${server.enabled ? "" : " off"}`} aria-label={`${server.name}启用`} aria-pressed={server.enabled} disabled={busy}
              onClick={() => void patchServer({ enabled: !server.enabled })} />
          </div>
          <div className="lbl">提供方式</div>
          <Seg
            items={[{ key: "direct", label: "直接提供" }, { key: "deferred", label: "按需搜索" }]}
            value={server.exposure}
            disabled={busy}
            onChange={(exposure) => void patchServer({ exposure })}
          />
          <div className="note">直接提供：工具和内置工具一样声明给模型，适合工具少的服务。按需搜索：模型先搜索再调用，适合工具多的服务。</div>
        </Group>
      )}
      {server.valid ? (
        <Group>
          <div className="testrow">
            <button className="hob-btn" onClick={() => void runTest()} disabled={testing}>{testing ? "正在测试…" : "测试连接"}</button>
            {probe ? (
              <span className={probe.state === "connected" ? "okline" : "badline"}>
                {probe.state === "connected" ? `已连接 · ${probe.tools?.length ?? 0} 个工具` : probe.state === "needs_auth" ? "需要登录，暂不支持" : probe.error ?? "连接失败"}
              </span>
            ) : (
              <span className="note">连接后列出服务提供的工具</span>
            )}
          </div>
          {probe && probe.state !== "connected" && probe.stderrTail?.length ? (
            <div className="note mono">{probe.stderrTail.join("\n")}</div>
          ) : null}
          {tools ? (
            tools.length ? (
              <>
                <div className="lbl">工具（{tools.length}）</div>
                <div className="group-card settings-card">
                  {tools.map((tool) => {
                    const off = hiddenTools.includes(tool.name);
                    return (
                      <div className={`list-row setting-row${off ? " gone" : ""}`} key={tool.name}>
                        <div className="rmain">
                          <div className="rname mono">{tool.name}</div>
                          <div className="rprov rclamp">{tool.description || "（没有说明）"}</div>
                        </div>
                        <button className={`tog${off ? " off" : ""}`} aria-label={`${tool.name}启用`} aria-pressed={!off} disabled={busy}
                          onClick={() => {
                            const next = off ? hiddenTools.filter((item) => item !== tool.name) : [...hiddenTools, tool.name];
                            void patchServer({ hiddenTools: next });
                          }} />
                      </div>
                    );
                  })}
                </div>
                <div className="note">关掉的工具不声明给模型；改动对之后新开的任务生效。</div>
              </>
            ) : (
              <div className="note">服务已连接，但没有提供工具。</div>
            )
          ) : (
            <div className="note">先测试连接，取得服务的工具列表后可以单独开关每个工具。</div>
          )}
        </Group>
      ) : null}
      <Group>
        <div className="lbl">{server.valid ? "编辑" : "重新保存"}</div>
        <McpForm initial={mcpDraftFrom(server)} name={server.name} fixedName onSaved={onDone} saveLabel="保存" />
      </Group>
      <Group>
        <button className="hob-btn hob-btn-danger" disabled={busy} onClick={() => void remove()}>删除服务</button>
        {error ? <div className="badline" role="alert">{error}</div> : null}
      </Group>
      <div className="note">环境变量和请求头的值不回显；留空表示沿用已保存的值。删除整行表示删掉这个值。</div>
    </>
  );
}

/** 从本机导入：只读 pi / Claude Code / Cursor 的配置，同名跳过。 */
function McpImport({ onDone }: { onDone: (message: string) => void }) {
  const [view, setView] = useState<McpImportView | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadMcpImports().then((next) => { if (live) setView(next); }).catch((e) => { if (live) setError(errText(e)); });
    return () => { live = false; };
  }, []);
  const commit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await importMcpServers(chosen);
      const skipped = result.skipped.length ? `，跳过 ${result.skipped.length} 个（同名）` : "";
      onDone(`已导入 ${result.imported.length} 个服务${skipped}`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const items = view?.items ?? [];
  return (
    <>
      <SubBack label="MCP" />
      <PageHead title="从本机导入 MCP 服务" desc="读取本机 pi、Claude Code、Cursor 里已配置的 MCP 服务，复制到 Hob；来源只读，同名跳过。" />
      <Group>
        {view?.sources.length ? <div className="note">读取位置：{view.sources.join("；")}</div> : null}
        <div className="group-card settings-card">
          {items.length ? items.map((item) => (
            <label className="list-row setting-row" key={item.id}>
              <input type="checkbox" className="rcheck" checked={chosen.includes(item.id)} disabled={busy || !item.selectable}
                onChange={(e) => setChosen(e.target.checked ? [...chosen, item.id] : chosen.filter((id) => id !== item.id))} />
              <div className="rmain">
                <div className="rname">{item.name}<span className="rtag">{MCP_SOURCE_LABEL[item.source]}</span>{item.exists ? <span className="rtag">同名跳过</span> : null}</div>
                <div className="rprov rclamp">{item.kind === "http" ? "远程地址" : "本地命令"}{item.note ? ` · ${item.note}` : ""}</div>
              </div>
            </label>
          )) : <Empty>没有找到可导入的 MCP 服务</Empty>}
        </div>
        <SaveRow saved={false} error={error}>
          <button className="hob-btn" onClick={closeSub} disabled={busy}>取消</button>
          <button className="hob-btn hob-btn-primary" disabled={busy || !chosen.length} onClick={() => void commit()}>{busy ? "正在导入…" : chosen.length ? `导入 ${chosen.length} 个` : "导入所选"}</button>
        </SaveRow>
      </Group>
    </>
  );
}

const SEARCH_INFO: Record<SearchProviderName, { label: string; desc: string; url?: boolean; keyOptional?: boolean }> = {
  searxng: { label: "SearXNG", desc: "自建的元搜索服务，填写服务地址即可", url: true, keyOptional: true },
  exa: { label: "Exa", desc: "语义搜索，适合查找技术资料" },
  tavily: { label: "Tavily", desc: "面向 AI 的搜索接口" },
  brave: { label: "Brave Search", desc: "Brave 的独立网页索引" },
  serper: { label: "Serper", desc: "Google 搜索结果" },
  jina: { label: "Jina", desc: "搜索并读取网页正文" },
  firecrawl: { label: "Firecrawl", desc: "搜索并抓取网页正文" },
  perplexity: { label: "Perplexity", desc: "带摘要的搜索结果" },
  youcom: { label: "You.com", desc: "You.com 搜索接口" },
  ollama: { label: "Ollama", desc: "Ollama 的网页搜索", url: true },
};

/** 联网搜索页：上面是已启用的（按顺序使用，可上下移），下面是其余服务商；整行点进详情配置。 */
function SearchSection() {
  const s = useApp();
  const sub = s.sub;
  const providers = s.settings.settings.search;
  const [view, setView] = useState<SearchView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = async () => setView(await loadSearch());
  useEffect(() => { void refresh().catch((e) => setNotice(errText(e))); }, []);
  useEffect(() => { if (sub) setNotice(null); }, [sub]);
  const configured = (name: SearchProviderName) => view?.providers.find((p) => p.name === name)?.keyConfigured ?? false;
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
    if (!provider) return <><SubBack label="联网搜索" /><div className="note">没有这个服务商。</div></>;
    return <SearchProviderDetail provider={provider} configured={configured(provider.name)} busy={busy}
      save={(next, key) => persist(providers.map((p) => (p.name === next.name ? next : p)), key === undefined ? undefined : { [next.name]: key })} />;
  }

  const status = (p: SearchProviderSetting) => (configured(p.name) ? "已配置 Key" : p.baseUrl ? "已填服务地址" : "未配置");
  return (
    <>
      <PageHead title="联网搜索" desc="助手和任务通过这里的服务商搜索网页、读取正文。可以启用多个，按顺序使用，前一个失败时自动换下一个。" />
      <Group>
        <div className="lbl">已启用</div>
        {enabled.length ? (
          <div className="group-card settings-card">
            {enabled.map((p, index) => (
              <div className="list-row setting-row" key={p.name}>
                <span className="rorder">{index + 1}</span>
                <button className="rmain rbtn" onClick={() => openSub({ kind: "searchProvider", name: p.name, title: SEARCH_INFO[p.name].label })}>
                  <div className="rname">{SEARCH_INFO[p.name].label}</div>
                  <div className="rprov">{SEARCH_INFO[p.name].desc}</div>
                </button>
                <button className="hob-icon-btn rmove" title="上移" disabled={busy || index === 0} onClick={() => move(p.name, -1)}><Icon name="down" size={15} className="up" /></button>
                <button className="hob-icon-btn rmove" title="下移" disabled={busy || index === enabled.length - 1} onClick={() => move(p.name, 1)}><Icon name="down" size={15} /></button>
              </div>
            ))}
          </div>
        ) : <div className="note">尚未启用服务商，助手和任务暂时不能联网搜索。</div>}
        {notice ? <div className="badline">{notice}</div> : null}
      </Group>
      <Group>
        <div className="lbl">{enabled.length ? "其他服务商" : "选择服务商"}</div>
        <div className="group-card settings-card">
          {providers.filter((p) => !p.enabled).map((p) => (
            <button className="list-row setting-row" key={p.name} onClick={() => openSub({ kind: "searchProvider", name: p.name, title: SEARCH_INFO[p.name].label })}>
              <div className="rmain">
                <div className="rname">{SEARCH_INFO[p.name].label}</div>
                <div className="rprov">{SEARCH_INFO[p.name].desc}</div>
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
      setTest({ ok: result.ok, text: result.ok ? `搜索成功，返回 ${result.count} 条结果` : result.error ?? "搜索失败" });
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
      <SubBack label="联网搜索" />
      <PageHead title={info.label} desc={info.desc} />
      <Group>
        <div className="ctl">
          <span style={{ fontSize: 14 }}>启用</span>
          <span className="sp" />
          <button className={`tog${provider.enabled ? "" : " off"}`} aria-label={`${info.label}启用`} aria-pressed={provider.enabled}
            disabled={busy || (!provider.enabled && !ready)} onClick={() => void apply({ ...provider, enabled: !provider.enabled })} />
        </div>
        {!provider.enabled && !ready ? <div className="note">{info.url ? "填写服务地址" : "填写 API Key"}并保存后即可启用。</div> : null}
      </Group>
      <Group>
        <div className="formcard">
          {info.url ? (
            <>
              <div className="lbl">服务地址</div>
              <div className="field"><input value={url} onChange={(e) => { setUrl(e.target.value); setTest(null); }} placeholder="http://127.0.0.1:8888" disabled={busy} /></div>
            </>
          ) : null}
          <div className="lbl">API Key{info.keyOptional ? "（可选）" : ""}</div>
          <div className="field">
            <input type="password" value={key} onChange={(e) => { setKey(e.target.value); setTest(null); }} placeholder={configured ? "已保存，留空不变" : "填写 API Key"} disabled={busy} />
          </div>
          <div className="note">API Key 只保存在本机，保存后不再显示。</div>
          <div className="testrow">
            <button className="hob-btn" onClick={() => void runTest()} disabled={busy || testing}>{testing ? "正在搜索…" : "测试搜索"}</button>
            {test ? <span className={test.ok ? "okline" : "badline"}>{test.text}</span> : null}
          </div>
          <SaveRow saved={saved && !dirty} error={error}>
            {configured ? <button className="hob-btn" disabled={busy} onClick={() => void apply(provider, "")}>删除 Key</button> : null}
            <button className="hob-btn hob-btn-primary" disabled={busy || testing || !dirty} onClick={() => void commit()}>保存</button>
          </SaveRow>
        </div>
      </Group>
    </>
  );
}

const REPO_URL = "https://github.com/FFatTiger/hob";

/** 关于页：版本、数据目录，以及仓库入口。 */
export function AboutView({ about }: { about: AboutInfo | null }) {
  if (!about) return <Empty>正在读取版本信息…</Empty>;
  const rows: [string, string][] = [
    ["Hob 版本", about.version],
    ["数据目录", about.home],
  ];
  return (
    <>
      <PageHead title="关于" desc="Hob 的版本与数据目录。" />
      <div className="kvcard">
        {rows.map(([label, value]) => (
          <div className="kvrow" key={label}>
            <span className="k">{label}</span>
            <span className="v">{value}</span>
          </div>
        ))}
        <LinkRow icon="github" label="GitHub" value="FFatTiger/hob" href={REPO_URL} />
      </div>
    </>
  );
}

function AboutSection() {
  const [about, setAbout] = useState<AboutInfo | null>(null);
  useEffect(() => {
    void loadAbout().then(setAbout);
  }, []);
  return <AboutView about={about} />;
}
