import { useEffect, useRef, useState } from "react";
import type { PluginLoginView } from "../../../shared/types.ts";
import { t } from "../../../shared/i18n.ts";
import { copyText } from "../clipboard.ts";
import { Icon } from "../icons.tsx";
import { deletePluginLogin, loadPluginLoginSecret, savePluginLogin } from "../store.ts";
import { useMenu } from "./use-menu.ts";

export interface LoginData { service: string; logins: PluginLoginView[]; folders: string[] }
interface LoginEdit { id: string; name: string; folder: string; uri: string; username: string; password: string }
interface ImportRow { name: string; uri: string; username: string; password: string; folder?: string }

function host(uri: string): string {
  try { return new URL(uri).host || uri; } catch { return uri; }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some(value => value.trim())) rows.push(row);
      row = [];
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); if (row.some(value => value.trim())) rows.push(row); }
  return rows;
}

export function parseLoginCsv(text: string): ImportRow[] {
  const rows = parseCsv(text);
  const header = rows.shift()?.map(value => value.trim().replace(/^\uFEFF/, "").toLowerCase()) ?? [];
  const index = (...names: string[]) => names.map(name => header.indexOf(name)).find(value => value >= 0) ?? -1;
  const name = index("name", "title");
  const uri = index("login_uri", "url");
  const username = index("login_username", "username");
  const password = index("login_password", "password");
  const folder = index("folder");
  if (name < 0 || uri < 0 || username < 0 || password < 0) return [];
  return rows.flatMap(row => {
    const value = (at: number) => at >= 0 ? String(row[at] ?? "").trim() : "";
    const result = { name: value(name), uri: value(uri), username: value(username), password: value(password), ...(folder >= 0 && value(folder) ? { folder: value(folder) } : {}) };
    return result.name && result.password ? [result] : [];
  });
}

function duplicate(row: ImportRow, logins: PluginLoginView[]): boolean {
  return logins.some(login => login.name === row.name && login.username === row.username && login.uris.includes(row.uri));
}

/** browse：登录存在 Hob 自己这里（自带密码库），这页就是管理它们的地方，直接列出；存在外部密码管理器里的，用户在那边管理，这里只按搜索显示。 */
export function PluginLogins({ id, data, canSave, canDelete, browse, reload }: { id: string; data: LoginData; canSave: boolean; canDelete: boolean; browse: boolean; reload: () => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [edit, setEdit] = useState<LoginEdit | null>(null);
  const [secretId, setSecretId] = useState<string | null>(null);
  const [passwords, setPasswords] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [imported, setImported] = useState<ImportRow[] | null>(null);
  const [limit, setLimit] = useState(20);
  const [importing, setImporting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const menu = useMenu();
  const timers = useRef<number[]>([]);

  useEffect(() => () => timers.current.forEach(timer => window.clearTimeout(timer)), []);
  const showNotice = (value: string) => {
    setNotice(value);
    const timer = window.setTimeout(() => setNotice(""), 4000);
    timers.current.push(timer);
  };
  const secret = async (login: PluginLoginView, copy = false) => {
    setSecretId(login.id);
    try {
      const value = await loadPluginLoginSecret(id, login.id, data.service);
      setPasswords(current => ({ ...current, [login.id]: value.password }));
      const displayTimer = window.setTimeout(() => setPasswords(current => { const next = { ...current }; delete next[login.id]; return next; }), 10_000);
      timers.current.push(displayTimer);
      if (copy) {
        if (await copyText(value.password)) {
          showNotice(t("已复制，30 秒后清空"));
          const timer = window.setTimeout(async () => {
            try {
              if (navigator.clipboard?.readText && await navigator.clipboard.readText() === value.password) await navigator.clipboard.writeText("");
            } catch { /* 浏览器不允许读剪贴板时不覆盖用户后来复制的内容。 */ }
          }, 30_000);
          timers.current.push(timer);
        } else showNotice(t("复制失败，请检查浏览器的剪贴板权限。"));
      }
    } catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
    finally { setSecretId(null); }
  };
  const beginEdit = async (login: PluginLoginView) => {
    menu.close();
    setEdit({ id: login.id, name: login.name, folder: login.folder ?? "", uri: login.uris[0] ?? "", username: login.username, password: "" });
    try {
      const value = await loadPluginLoginSecret(id, login.id, data.service);
      setEdit(current => current?.id === login.id ? { ...current, password: value.password } : current);
    } catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
  };
  const saveEdit = async () => {
    if (!edit) return;
    try {
      await savePluginLogin(id, { id: edit.id, service: data.service, name: edit.name, uris: edit.uri ? [edit.uri] : [], username: edit.username, password: edit.password, folder: edit.folder });
      setEdit(null); await reload(); showNotice(t("已保存"));
    } catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
  };
  const remove = async (login: PluginLoginView) => {
    menu.close();
    if (!window.confirm(t("删除登录「{name}」？", { name: login.name }))) return;
    try { await deletePluginLogin(id, login.id, data.service); await reload(); showNotice(t("已删除")); }
    catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
  };
  const readFile = async (selected: File) => {
    const rows = parseLoginCsv(await selected.text());
    const existing = rows.filter(row => duplicate(row, data.logins)).length;
    setImported(rows);
    showNotice(t("认出 {n} 条，{m} 条已存在会跳过", { n: rows.length, m: existing }));
  };
  const doImport = async () => {
    if (!imported?.length) return;
    setImporting(true);
    try {
      let saved = 0;
      for (const row of imported) {
        if (duplicate(row, data.logins)) continue;
        await savePluginLogin(id, { service: data.service, name: row.name, uris: row.uri ? [row.uri] : [], username: row.username, password: row.password, ...(row.folder ? { folder: row.folder } : {}) });
        saved++;
      }
      setImported(null); await reload(); showNotice(t("导入了 {n} 条", { n: saved }));
    } catch (error) { showNotice(error instanceof Error ? error.message : String(error)); }
    finally { setImporting(false); }
  };
  const filtered = data.logins.filter(login => [login.name, login.username, ...login.uris].some(value => value.toLowerCase().includes(query.trim().toLowerCase())));
  const row = (login: PluginLoginView) => {
    const shownPassword = passwords[login.id];
    return <div className="plugin-login-wrap" key={login.id}>
      <div className="plugin-login-row">
        <span className="plugin-login-avatar">{login.name.slice(0, 1).toUpperCase() || "?"}</span>
        <div className="plugin-login-info"><div className="plugin-login-name">{login.name}</div><div className={`plugin-login-meta${shownPassword ? " secret" : ""}`}>{shownPassword ?? `${login.username || t("无用户名")} · ${login.uris[0] ? host(login.uris[0]) : t("无网址")}`}</div></div>
        {login.folder ? <span className="plugin-login-folder">{login.folder}</span> : null}
        <button className="hob-icon-btn" type="button" title={t("更多")} aria-label={t("更多")} onClick={event => menu.toggle(login.id, event.currentTarget)}><Icon name="more" size={16} /></button>
      </div>
      {edit?.id === login.id ? <div className="plugin-login-edit">
        <label className="lbl">{t("名称")}<input className="field" value={edit.name} onChange={event => setEdit({ ...edit, name: event.target.value })} /></label>
        <label className="lbl">{t("文件夹")}<input className="field" value={edit.folder} onChange={event => setEdit({ ...edit, folder: event.target.value })} /></label>
        <label className="lbl">{t("网址")}<input className="field" value={edit.uri} onChange={event => setEdit({ ...edit, uri: event.target.value })} /></label>
        <label className="lbl">{t("用户名")}<input className="field" value={edit.username} onChange={event => setEdit({ ...edit, username: event.target.value })} /></label>
        <label className="lbl">{t("密码")}<input className="field" type="password" value={edit.password} onChange={event => setEdit({ ...edit, password: event.target.value })} /></label>
        <div className="plugin-actions"><button className="hob-btn hob-btn-primary" type="button" onClick={() => void saveEdit()}>{t("保存")}</button><button className="hob-btn" type="button" onClick={() => setEdit(null)}>{t("取消")}</button></div>
      </div> : null}
    </div>;
  };
  const menuLogin = menu.menu ? data.logins.find(login => login.id === menu.menu?.id) : undefined;
  return <section className="plugin-section plugin-logins">
    <div className="plugin-login-status"><span className="plugin-login-status-text"><span className="plugin-login-status-dot" />{t("已开启")} <span className="plugin-login-count">· {t("{n} 个登录", { n: data.logins.length })}</span></span>{canSave ? <><input ref={file} className="plugin-file-input" type="file" accept=".csv,text/csv" onChange={event => { const selected = event.target.files?.[0]; event.target.value = ""; if (selected) void readFile(selected); }} /><button className="hob-btn plugin-login-import" type="button" onClick={() => file.current?.click()}>{t("从别处导入")}</button></> : null}</div>
    <div className="plugin-login-heading"><h2>{t("已保存的登录 {n} 个", { n: filtered.length })}</h2><label className="plugin-login-search"><Icon name="search" size={15} /><input value={query} onChange={event => { setQuery(event.target.value); setLimit(20); }} placeholder={t("搜索名称、用户名或网址")} /></label></div>
    {imported ? <div className="plugin-import-preview"><div>{t("认出 {n} 条，{m} 条已存在会跳过", { n: imported.length, m: imported.filter(row => duplicate(row, data.logins)).length })}</div><div className="plugin-actions"><button className="hob-btn hob-btn-primary" type="button" disabled={importing} onClick={() => void doImport()}>{t("确认导入")}</button><button className="hob-btn" type="button" disabled={importing} onClick={() => setImported(null)}>{t("取消")}</button></div></div> : null}
    {!browse && !query.trim() ? (data.logins.length ? <div className="plugin-empty-login">{t("输入名称、用户名或网址，查找要看的登录。")}</div> : <div className="plugin-empty-login">{t("还没有保存的登录")}</div>)
      : filtered.length ? <><div className="plugin-login-list">{filtered.slice(0, limit).map(row)}</div>{filtered.length > limit ? <button className="hob-btn plugin-login-more" type="button" onClick={() => setLimit(value => value + 20)}>{t("再显示 {n} 个", { n: Math.min(20, filtered.length - limit) })}</button> : null}</> : <div className="plugin-empty-login">{query ? t("没有匹配的登录") : t("还没有保存的登录")}</div>}
    {notice ? <div className="plugin-login-notice" role="status">{notice}</div> : null}
    {menuLogin && <div className="plugin-login-menu plugin-menu" ref={menu.box}><button type="button" onClick={() => { menu.close(); void secret(menuLogin); }}>{t("显示密码")}</button><button type="button" onClick={() => { menu.close(); void secret(menuLogin, true); }}>{t("复制密码")}</button><button type="button" onClick={() => { menu.close(); void copyText(menuLogin.username).then(ok => showNotice(ok ? t("已复制用户名") : t("复制失败，请检查浏览器的剪贴板权限。"))); }}>{t("复制用户名")}</button>{canSave ? <button type="button" onClick={() => void beginEdit(menuLogin)}>{t("编辑")}</button> : null}{canDelete ? <button type="button" className="danger" onClick={() => void remove(menuLogin)}>{t("删除")}</button> : null}</div>}
    {secretId ? <span className="plugin-login-loading" aria-live="polite">{t("正在读取密码…")}</span> : null}
  </section>;
}
