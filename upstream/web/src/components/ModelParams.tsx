// 模型参数的编辑：设置 → 服务商（兼容接口）和插件页（供应商插件）共用同一套行，改法一样。
import { useEffect, useState } from "react";
import { t } from "../../../shared/i18n.ts";
import { thinkingText } from "../../../shared/thinking.ts";
import type { ModelThinkingView, SettingsFile, ThinkingLevel, ThinkingLevelMapSetting } from "../../../shared/types.ts";
import { Icon } from "../icons.tsx";
import { THINKING_ORDER } from "../model-list.ts";
import { saveThinking } from "../store.ts";
import { Disclosure } from "./Disclosure.tsx";
import { Select } from "./Select.tsx";

/** 服务商没给时的默认值，和服务端一致（server/src/providers.ts）。 */
export const DEFAULT_CONTEXT = 128_000;
export const DEFAULT_MAX_TOKENS = 8_192;

export interface ModelParams {
  input?: ("text" | "image")[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}

/** 能看图、会推理两个开关，上下文窗口、单次最多输出两个数字；每改一项调一次 onEdit，只带改的那项。 */
export function ModelParamsEditor({ id, params, busy, onEdit }: { id: string; params: ModelParams; busy: boolean; onEdit: (patch: ModelParams) => void }) {
  const image = Boolean(params.input?.includes("image"));
  const number = (label: string, key: "contextWindow" | "maxTokens", fallback: number) => {
    const value = params[key] ?? fallback;
    return (
      <div className="mline">
        <span>{label}</span>
        <span className="field provider-model-ctx">
          <input
            type="number"
            min={1}
            defaultValue={value}
            key={`${id}:${key}:${value}`}
            aria-label={label}
            onBlur={(event) => {
              const next = Math.round(Number(event.target.value));
              if (next > 0 && next !== value) onEdit({ [key]: next });
              else event.target.value = String(value);
            }}
            onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
            disabled={busy}
          />
        </span>
      </div>
    );
  };
  return (
    <>
      <div className="mline"><span>{t("能看图")}</span><button className={`tog${image ? "" : " off"}`} aria-label={t("能看图")} aria-pressed={image} disabled={busy} onClick={() => onEdit({ input: image ? ["text"] : ["text", "image"] })} /></div>
      <div className="mline"><span>{t("会推理")}</span><button className={`tog${params.reasoning ? "" : " off"}`} aria-label={t("会推理")} aria-pressed={Boolean(params.reasoning)} disabled={busy} onClick={() => onEdit({ reasoning: !params.reasoning })} /></div>
      {number(t("上下文窗口（token）"), "contextWindow", DEFAULT_CONTEXT)}
      {number(t("单次最多输出（token）"), "maxTokens", DEFAULT_MAX_TOKENS)}
    </>
  );
}

/**
 * 一个模型的思考档：一行一个档（中文档名 + 发给服务商的字符 + 删除），底部添加档和恢复默认。
 * 存进 Hob 设置里这个模型的自定义档位，存完立即生效（下一轮对话 / 下一个任务就用新的字符）。
 */
export function ThinkingLevels({
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
    <Disclosure
      className="think-levels"
      label={t("思考档")}
      count={t("{n} 档{custom}", { n: rows.length, custom: info.custom ? t(" · 有自定义") : t(" · 默认") })}
      open={open}
      onToggle={() => setOpen((value) => !value)}
      disabled={busy}
    >
      <div className="thinkrows">
            {rows.map((row) => (
              <div className="thinkrow" key={row.level}>
                <span className="tname">{thinkingText(row.level)}</span>
                <input
                  className="ttext"
                  value={row.text}
                  placeholder={t("默认")}
                  title={t("留空则按服务商协议的默认值发送")}
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
                  <span className="rremove still" title={t("「关闭」这一档不能删除")} aria-hidden />
                ) : (
                  <button
                    className="rremove"
                    title={t("删除「{level}」", { level: thinkingText(row.level) })}
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
            <Select value={pick} onChange={(value) => setPick(value as ThinkingLevel | "")} disabled={busy || disabled || !rest.length} aria-label={t("添加思考档")} options={[{ value: "", label: rest.length ? t("选择档位") : t("七个档位均已使用") }, ...rest.map((level) => ({ value: level, label: thinkingText(level) }))]} />
            <button
              className="hob-btn"
              onClick={() => {
                if (!pick) return;
                save([...rows, { level: pick, text: "" }]);
                setPick("");
              }}
              disabled={busy || disabled || !pick}
            >
              {t("添加思考档")}
            </button>
            <span className="sp" />
            {info.custom ? (
              <button className="hob-btn" onClick={() => void commit(null)} disabled={busy || disabled}>
                {t("恢复默认")}
              </button>
            ) : null}
          </div>
          <div className="note">
            {t("留空则按服务商协议的默认值发送；填写后按所填的值发送（例如 DeepSeek 的「中」填 high）。「关闭」这一档不能删除，其余档删除后不再出现在思考强度中。")}
          </div>
          {error ? <div className="badline">{error}</div> : null}
      {saved ? <div className="okline">{t("已保存思考档")}</div> : null}
    </Disclosure>
  );
}
