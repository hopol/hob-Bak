import { useEffect, useState } from "react";
import type { DesktopScreen } from "../../shared/types.ts";
import { desktopMockScene } from "./mock.ts";
import { realApi as api } from "./api.ts";
import { MOCK } from "./store.ts";

interface Snapshot { screens: DesktopScreen[]; profiles: Record<string, string>; error?: string }

/** 首次和 SSE 重连拉快照，其余变化由服务端推送。 */
export function useDesktopScreens(): Snapshot {
  const [snapshot, setSnapshot] = useState<Snapshot>({ screens: [], profiles: {} });
  useEffect(() => {
    if (MOCK) {
      if (desktopMockScene() === "ready" || desktopMockScene() === "deployed") {
        setSnapshot({ screens: [{ id: "hob", running: true, browserRunning: true, viewers: 0, lastActiveAt: null }], profiles: { hob: "hob" } });
      }
      return;
    }
    let alive = true;
    let version = 0;
    const refresh = async () => {
      const current = version;
      try {
        const result = await api.desktopScreens();
        if (alive) setSnapshot((old) => ({ profiles: result.profiles, screens: version === current ? result.screens : old.screens }));
      } catch (error) { if (alive) setSnapshot((old) => ({ ...old, error: error instanceof Error ? error.message : String(error) })); }
    };
    const events = new EventSource("/api/events");
    events.onopen = () => { void refresh(); };
    events.onerror = () => { if (alive) setSnapshot((old) => ({ ...old, screens: [] })); };
    events.onmessage = (event) => {
      try {
        const value = JSON.parse(event.data);
        if (value.type === "desktop-screens" && Array.isArray(value.screens)) {
          version++;
          setSnapshot((old) => ({ ...old, screens: value.screens }));
        } else if (value.type === "assistant" || value.type === "assistant_removed") void refresh();
      } catch { /* 忽略无效事件 */ }
    };
    return () => { alive = false; events.close(); };
  }, []);
  return snapshot;
}

export async function startDesktopScreen(id: string): Promise<void> {
  const response = await fetch(`/api/desktop/screens/${encodeURIComponent(id)}/start`, { method: "POST" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? "无法启动屏幕。");
  }
}
