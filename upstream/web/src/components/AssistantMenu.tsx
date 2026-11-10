// 助手行的右键 / 长按菜单：放在顶部、收起、助手设置。桌面右键，手机长按约 500ms。
import { useEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import type { AssistantSummary } from "../../../shared/types.ts";
import { closeAssistantMenu, openAssistantMenu, openAssistantPanel, patchAssistant, select, useApp } from "../store.ts";

/** 长按多久算“长按”。 */
const HOLD_MS = 500;
/** 按住之后移动超过这么多像素就算在滚动，不弹菜单。 */
const MOVE_MAX = 10;

export interface AssistantMenuHandlers {
  onContextMenu: (e: ReactMouseEvent) => void;
  onPointerDown: (e: ReactPointerEvent) => void;
  onPointerMove: (e: ReactPointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
}

/**
 * 挂在助手头像 / 助手行上：右键或长按弹菜单。
 * 长按弹出后还会跟一次 click，takeHeld 让那个 click 不算数（不然会顺手把对话打开）。
 */
export function useAssistantMenu(a: AssistantSummary): {
  handlers: AssistantMenuHandlers;
  takeHeld: () => boolean;
} {
  const timer = useRef<number | null>(null);
  const from = useRef<{ x: number; y: number } | null>(null);
  const held = useRef(false);

  const stop = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    from.current = null;
  };

  useEffect(() => stop, []);

  const handlers: AssistantMenuHandlers = {
    onContextMenu(e) {
      e.preventDefault();
      stop();
      openAssistantMenu(a.id, e.clientX, e.clientY);
    },
    onPointerDown(e) {
      if (e.pointerType !== "touch") return;
      stop();
      held.current = false;
      from.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        const p = from.current;
        if (!p) return;
        held.current = true;
        // 有的浏览器长按不补 click，过了这段时间就别再拦点击了
        window.setTimeout(() => (held.current = false), 1000);
        openAssistantMenu(a.id, p.x, p.y);
      }, HOLD_MS);
    },
    onPointerMove(e) {
      const p = from.current;
      if (!p) return;
      if (Math.abs(e.clientX - p.x) > MOVE_MAX || Math.abs(e.clientY - p.y) > MOVE_MAX) stop();
    },
    onPointerUp: stop,
    onPointerCancel: stop,
  };

  return {
    handlers,
    takeHeld() {
      if (!held.current) return false;
      held.current = false;
      return true;
    },
  };
}

/** 菜单本体（挂在 App 上，两种布局共用）。 */
export function AssistantMenu() {
  const s = useApp();
  const menu = s.menu;
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) closeAssistantMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeAssistantMenu();
    };
    // 捕获阶段：点在其他控件上也先关菜单
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (!menu) return null;
  const a = s.assistants.find((x) => x.id === menu.id);
  if (!a) return null;

  const run = (fn: () => void) => {
    closeAssistantMenu();
    fn();
  };
  // 贴着窗口边弹的时候往里收，菜单不出界
  const items = a.primary ? 1 : 3;
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 172));
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - (items * 34 + 16)));

  return (
    <div className="amenu" ref={box} style={{ left, top, transformOrigin: `${menu.x - left}px ${menu.y - top}px` }} onContextMenu={(e) => e.preventDefault()}>
      {a.primary ? null : (
        <button onClick={() => run(() => void patchAssistant(a.id, { pinned: !a.pinned }))}>
          {a.pinned ? "取消置顶" : "放在顶部"}
        </button>
      )}
      {a.primary ? null : (
        <button onClick={() => run(() => void patchAssistant(a.id, { hidden: !a.hidden }))}>
          {a.hidden ? "放回列表" : "收起这个助手"}
        </button>
      )}
      <button
        onClick={() =>
          run(() => {
            void select(a.id, false);
            openAssistantPanel();
          })
        }
      >
        助手设置
      </button>
    </div>
  );
}
