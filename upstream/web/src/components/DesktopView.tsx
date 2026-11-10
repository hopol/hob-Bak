import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import RFB from "@novnc/novnc";
import { Icon } from "../icons.tsx";
import { desktopMockScene } from "../mock.ts";
import { MOCK, useApp } from "../store.ts";
import { characterKeysym, compositionInput, isPasteShortcut, keyboardKeysym, textInputMethod } from "../desktop-input.ts";
import { startDesktopScreen, useDesktopScreens } from "../desktop-screens.ts";

type Control = { taken: boolean; mine: boolean };
/** 连接状态：连接中 / 已连上 / 断开或失败（可以重试） */
type Phase = "connecting" | "ready" | "lost";

const MOCK_SHOT = "/mock/desktop.jpg";
const MAC = /Mac|iPhone|iPad/.test(navigator.platform);

function vncUrl(id: string, screen: string) {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/api/desktop/vnc?screen=${encodeURIComponent(screen)}&client=${encodeURIComponent(id)}`;
}

function clientId() {
  const key = "hob-desktop-client";
  const stored = sessionStorage.getItem(key);
  if (stored) return stored;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  sessionStorage.setItem(key, id);
  return id;
}

/** 右栏里的桌面小屏：只看，画质调低；断线 5 秒后自动重连 */
export function DesktopMini({ screen }: { screen: string }) {
  const target = useRef<HTMLDivElement>(null);
  const [id] = useState(clientId);
  const [phase, setPhase] = useState<Phase>(MOCK ? "ready" : "connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (MOCK) return;
    setPhase("connecting");
    const client = new RFB(target.current!, vncUrl(id, screen));
    client.viewOnly = true;
    client.scaleViewport = true;
    client.resizeSession = false;
    client.qualityLevel = 3;
    client.compressionLevel = 9;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    client.addEventListener("connect", () => { if (active) setPhase("ready"); });
    client.addEventListener("disconnect", () => {
      if (!active) return;
      setPhase("lost");
      timer = setTimeout(() => setAttempt((n) => n + 1), 5000);
    });
    return () => {
      active = false;
      clearTimeout(timer);
      client.disconnect();
    };
  }, [id, screen, attempt]);

  return (
    <>
      <div className="desktop-canvas" ref={target} />
      {MOCK ? <img className="desktop-shot" src={MOCK_SHOT} alt="" /> : null}
      {phase === "ready" ? null : <div className="now-msg">{phase === "connecting" ? "正在连接云桌面…" : "云桌面连接已断开，正在重连…"}</div>}
    </>
  );
}

export function DesktopView({ onClose, takeOver = false, initialScreen = "hob" }: { onClose: () => void; takeOver?: boolean; initialScreen?: string }) {
  const target = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const mine = useRef(false);
  const composing = useRef(false);
  const committed = useRef("");
  const pressed = useRef(new Map<string, { keysym: number; code: string }>());
  const sentPressed = useRef(new Map<string, { keysym: number; code: string | null }>());
  const inputQueue = useRef(Promise.resolve());
  const keyGeneration = useRef(0);
  const clipboardSequence = useRef(0);
  /** 自己刚提交的文字：远端剪贴板会把它原样发回来，不再写进本机剪贴板 */
  const sentText = useRef("");
  const [clipboard, setClipboard] = useState("");
  const [id] = useState(clientId);
  const [control, setControl] = useState<Control>(MOCK && takeOver ? { taken: true, mine: true } : { taken: false, mine: false });
  const [phase, setPhase] = useState<Phase>("connecting");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [tip, setTip] = useState(false);
  const assistants = useApp().assistants;
  const desktop = useDesktopScreens();
  const [screen, setScreen] = useState(initialScreen);
  const currentScreen = useRef(screen);
  const viewActive = useRef(false);
  currentScreen.current = screen;
  // 触摸屏在接管时提示一次手势；鼠标操作不需要
  const [touch] = useState(() => window.matchMedia("(hover: none)").matches);

  useEffect(() => {
    if (!control.mine || !touch) return;
    setTip(true);
    const timer = setTimeout(() => setTip(false), 6000);
    return () => clearTimeout(timer);
  }, [control.mine, touch]);

  useEffect(() => {
    if (!control.mine) releaseKeys();
    mine.current = control.mine;
    if (rfb.current) rfb.current.viewOnly = !control.mine;
    if (!control.mine) {
      clipboardSequence.current++;
      setClipboard("");
      input.current?.blur();
    }
  }, [control.mine]);

  useEffect(() => {
    const onVisibility = () => { if (document.hidden) releaseKeys(); };
    window.addEventListener("blur", releaseKeys);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", releaseKeys);
      document.removeEventListener("visibilitychange", onVisibility);
      releaseKeys();
    };
  }, []);

  useEffect(() => {
    if (!clipboard) return;
    const timer = setTimeout(() => setClipboard(""), 8000);
    return () => clearTimeout(timer);
  }, [clipboard]);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const beforeInput = (event: InputEvent) => {
      if (!mine.current || composing.current || event.isComposing) return;
      const key = event.inputType === "deleteContentBackward" ? [0xff08, "Backspace"] as const
        : event.inputType === "insertLineBreak" || event.inputType === "insertParagraph" ? [0xff0d, "Enter"] as const : null;
      if (!key) return;
      event.preventDefault();
      sendKey(key[0], key[1], true);
      sendKey(key[0], key[1], false);
    };
    element.addEventListener("beforeinput", beforeInput);
    return () => element.removeEventListener("beforeinput", beforeInput);
  }, [control.mine]);

  useEffect(() => {
    let active = true;
    viewActive.current = true;
    let client: RFB | undefined;
    let owned = false;
    setPhase("connecting");
    setError("");
    setControl({ taken: false, mine: false });
    mine.current = false;
    if (MOCK) {
      if (desktopMockScene() === "failed") {
        setPhase("lost");
        setError("无法连接云桌面，请确认云桌面已部署并启动。");
      } else { setPhase("ready"); if (takeOver) setControl({ taken: true, mine: true }); }
      return;
    }
    const release = () => fetch("/api/desktop/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: id, screen, action: "release" }) }).catch(() => undefined);
    const refresh = async () => {
      const res = await fetch(`/api/desktop/control?client=${encodeURIComponent(id)}&screen=${encodeURIComponent(screen)}`);
      if (!res.ok) throw new Error("无法读取接管状态。");
      const next = (await res.json()) as Control;
      owned = next.mine;
      if (active) setControl(next);
      return next;
    };
    const events = new EventSource("/api/events");
    events.onmessage = (event) => {
      try {
        const value = JSON.parse(event.data);
        if (value.type === "desktop-control" && value.screen === screen) void refresh().catch((e: Error) => { if (active) setError(e.message); });
      } catch { /* 忽略无效事件 */ }
    };
    void (async () => {
      try {
        await startDesktopScreen(screen);
        if (!active) return;
        client = new RFB(target.current!, vncUrl(id, screen));
        rfb.current = client;
        client.viewOnly = true;
        client.scaleViewport = true;
        client.resizeSession = false;
        client.addEventListener("connect", () => {
          if (!active) return;
          setPhase("ready");
          setError("");
          void refresh().then(async (next) => {
            if (active && takeOver && !next.taken) {
              await send("take", screen);
              owned = true;
              if (!active) void release();
            }
          }).catch((e: Error) => { if (active) setError(e.message); });
        });
        client.addEventListener("disconnect", () => {
          if (!active) return;
          setPhase("lost");
          setError("云桌面连接已断开，请重试；仍无法连接时请确认云桌面已启动。");
        });
        client.addEventListener("clipboard", (event: Event) => {
          if (!mine.current) return;
          const text = (event as CustomEvent<{ text: string }>).detail.text;
          if (text === sentText.current) return;
          const sequence = ++clipboardSequence.current;
          setClipboard("");
          void navigator.clipboard?.writeText(text).then(() => {
            if (clipboardSequence.current === sequence) setClipboard("");
          }).catch(() => {
            if (mine.current && clipboardSequence.current === sequence) setClipboard(text);
          });
          if (!navigator.clipboard) setClipboard(text);
        });
      } catch (error) {
        if (active) { setPhase("lost"); setError(error instanceof Error ? error.message : String(error)); }
      }
    })();
    return () => {
      active = false;
      viewActive.current = false;
      events.close();
      if (owned || mine.current) void release();
      mine.current = false;
      if (rfb.current === client) rfb.current = null;
      client?.disconnect();
    };
  }, [id, screen, attempt, takeOver]);

  async function send(action: "take" | "release", targetScreen = screen) {
    const res = await fetch("/api/desktop/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: id, screen: targetScreen, action }),
    });
    const data = (await res.json()) as Control & { error?: string };
    if (!res.ok) throw new Error(data.error ?? "操作失败。");
    if (viewActive.current && currentScreen.current === targetScreen) {
      mine.current = data.mine;
      setControl(data);
    } else if (action === "take" && data.mine) {
      void fetch("/api/desktop/control", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client: id, screen: targetScreen, action: "release" }) });
    }
  }

  async function toggle() {
    if (MOCK) {
      setControl(control.mine ? { taken: false, mine: false } : { taken: true, mine: true });
      return;
    }
    try {
      await send(control.mine ? "release" : "take");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  function releaseKeys() {
    keyGeneration.current++;
    for (const { keysym, code } of sentPressed.current.values()) rfb.current?.sendKey(keysym, code, false);
    sentPressed.current.clear();
    pressed.current.clear();
  }

  function enqueueInput(action: () => void | Promise<void>) {
    const client = rfb.current;
    const targetScreen = currentScreen.current;
    inputQueue.current = inputQueue.current.then(async () => {
      if (mine.current && rfb.current === client && currentScreen.current === targetScreen) await action();
    }).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }

  function sendKey(keysym: number, code: string | null, down: boolean) {
    const generation = keyGeneration.current;
    enqueueInput(() => {
      if (generation !== keyGeneration.current) return;
      rfb.current?.sendKey(keysym, code, down);
      const key = code ?? String(keysym);
      if (down) sentPressed.current.set(key, { keysym, code });
      else sentPressed.current.delete(key);
    });
  }

  function pasteText(text: string) {
    if (!text || !rfb.current || !mine.current) return;
    sentText.current = text;
    for (const { keysym, code } of pressed.current.values()) sendKey(keysym, code, false);
    pressed.current.clear();
    const targetScreen = currentScreen.current;
    enqueueInput(async () => {
      const res = await fetch("/api/desktop/paste", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ client: id, screen: targetScreen, text }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "云桌面粘贴失败。");
      }
    });
  }

  function sendText(text: string) {
    if (!text || !mine.current) return;
    if (/[^\x20-\x7e]/.test(text) || textInputMethod(text) === "paste") return pasteText(text);
    for (const character of text) {
      const keysym = characterKeysym(character);
      sendKey(keysym, null, true);
      sendKey(keysym, null, false);
    }
  }

  function keyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (!mine.current || composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    committed.current = "";
    if (MAC && event.metaKey && ["KeyW", "KeyT", "KeyN", "KeyQ"].includes(event.code)) { releaseKeys(); return; }
    if (isPasteShortcut(event.nativeEvent)) return;
    const isText = Array.from(event.key).length === 1;
    if (isText && !event.ctrlKey && !event.metaKey && !event.altKey) return;
    const keysym = keyboardKeysym(event.nativeEvent, MAC);
    if (keysym === null) return;
    event.preventDefault();
    const code = event.code || event.key;
    if (MAC && event.metaKey && event.key !== "Meta" && event.key !== "Shift" && event.key !== "Control" && event.key !== "Alt") {
      if (!event.repeat) {
        sendKey(keysym, code, true);
        sendKey(keysym, code, false);
      }
      return;
    }
    pressed.current.set(code, { keysym, code });
    sendKey(keysym, code, true);
  }

  function keyUp(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    const code = event.code || event.key;
    const key = pressed.current.get(code);
    if (!key) return;
    event.preventDefault();
    sendKey(key.keysym, key.code, false);
    pressed.current.delete(code);
  }

  const takenByOther = control.taken && !control.mine;
  const canToggle = control.mine || (MOCK ? !takenByOther : phase === "ready" && !takenByOther);

  return createPortal(
    <div className="desktop-overlay" role="dialog" aria-label="云桌面">
      <div className="desktop-bar">
        <span className="desktop-title">云桌面</span>
        <span className={`desktop-tag${control.mine ? " live" : ""}`}>{control.mine ? "你在操作" : "只看"}</span>
        {takenByOther ? <span className="desktop-note">其他人正在接管</span> : null}
        {control.mine && clipboard ? <span className="desktop-clipboard">云桌面复制了文字 <button className="hob-btn" onClick={() => {
          if (!navigator.clipboard) return setError("复制失败，请使用支持剪贴板的安全连接。");
          void navigator.clipboard.writeText(clipboard).then(() => setClipboard("")).catch(() => setError("复制失败，请检查浏览器的剪贴板权限。"));
        }}>复制到本机</button></span> : null}
        {phase === "ready" && error ? <span className="desktop-note bad" role="alert">{error}</span> : null}
        <span className="sp" />
        <select className="pick desktop-open" aria-label="屏幕" value={screen} onChange={(event) => setScreen(event.target.value)}>
          {!Object.values(desktop.profiles).includes(screen) && screen !== "public" ? <option value={screen}>{screen}</option> : null}
          {assistants.filter((assistant) => desktop.profiles[assistant.id]).map((assistant) => {
            const id = desktop.profiles[assistant.id];
            const running = desktop.screens.some((entry) => entry.id === id && entry.running);
            return <option key={assistant.id} value={id}>{assistant.name} · {running ? "运行中" : "未启动"}</option>;
          })}
          <option value="public">公共屏幕 · {desktop.screens.some((entry) => entry.id === "public" && entry.running) ? "运行中" : "未启动"}</option>
        </select>
        {control.mine && touch ? <button className="hob-btn" onClick={() => input.current?.focus()}>键盘</button> : null}
        <button
          className="hob-btn hob-btn-primary"
          disabled={!canToggle}
          title={takenByOther ? "其他人正在接管" : undefined}
          onClick={() => void toggle()}
        >
          {control.mine ? "交还" : "接管"}
        </button>
        <button className="hob-icon-btn" title="关闭" aria-label="关闭云桌面" onClick={onClose}>
          <Icon name="close" size={18} />
        </button>
      </div>
      <div className="desktop-stage">
        <div className="desktop-frame">
          <div className="desktop-canvas" ref={target} onPointerDownCapture={(event) => {
            if (mine.current && !touch && input.current) {
              const bounds = event.currentTarget.getBoundingClientRect();
              input.current.style.left = `${Math.max(0, Math.min(bounds.width - 1, event.clientX - bounds.left))}px`;
              input.current.style.top = `${Math.max(0, Math.min(bounds.height - 1, event.clientY - bounds.top))}px`;
              input.current.focus({ preventScroll: true });
            }
          }} onFocus={() => {
            // noVNC 点击时会把焦点抢到它的画布上：画布唤不起输入法，按键也走它自己那套（⌘ 当 Alt）
            if (mine.current && !touch) input.current?.focus({ preventScroll: true });
          }} />
          {control.mine ? <textarea
            ref={input}
            className="desktop-input"
            aria-label="云桌面输入"
            autoCapitalize="off"
            autoComplete="off"
            spellCheck={false}
            onBlur={releaseKeys}
            onKeyDown={keyDown}
            onKeyUp={keyUp}
            onPaste={(event) => {
              event.preventDefault();
              pasteText(event.clipboardData.getData("text/plain"));
              event.currentTarget.value = "";
            }}
            onCompositionStart={() => { composing.current = true; committed.current = ""; }}
            onCompositionEnd={(event) => {
              composing.current = false;
              committed.current = event.data;
              if (event.data) pasteText(event.data);
              event.currentTarget.value = "";
            }}
            onInput={(event) => {
              const native = event.nativeEvent as InputEvent;
              if (composing.current || native.isComposing) return;
              if (native.inputType === "deleteContentBackward") {
                sendKey(0xff08, "Backspace", true);
                sendKey(0xff08, "Backspace", false);
              } else if (native.inputType === "insertLineBreak" || native.inputType === "insertParagraph") {
                sendKey(0xff0d, "Enter", true);
                sendKey(0xff0d, "Enter", false);
              } else if (native.inputType === "insertText" || native.inputType === "insertFromComposition") {
                const text = native.data ?? event.currentTarget.value;
                sendText(compositionInput(committed.current, text));
              }
              committed.current = "";
              event.currentTarget.value = "";
            }}
          /> : null}
          {MOCK && phase === "ready" ? <img className="desktop-shot" src={MOCK_SHOT} alt="" /> : null}
          {phase === "ready" ? null : (
            <div className="desktop-msg">
              {phase === "connecting" ? (
                <>
                  <Icon name="spin" size={20} className="spin" />
                  <span>正在连接云桌面…</span>
                </>
              ) : (
                <>
                  <div className="badline" role="alert">{error}</div>
                  <button className="hob-btn" onClick={() => setAttempt((n) => n + 1)}>重试</button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {tip ? <div className="desktop-tip">双指缩放，单指拖动画面</div> : null}
    </div>,
    document.body,
  );
}
