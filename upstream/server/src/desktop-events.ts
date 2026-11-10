import { WebSocket } from "ws";
import type { DesktopScreen } from "../../shared/types.ts";
import type { HobRuntime } from "./runtime.ts";

/** 监听 desktopd 的屏幕快照，连接中断时清空并退避重连。 */
export class DesktopEvents {
  private socket?: WebSocket;
  private timer?: NodeJS.Timeout;
  private generation = 0;
  private delay = 1000;
  screens: DesktopScreen[] = [];
  constructor(private runtime: HobRuntime) {}

  restart() {
    this.stop();
    this.delay = 1000;
    this.connect(this.generation);
  }

  stop() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.socket?.terminate();
    this.socket = undefined;
    this.publish([]);
  }

  private publish(screens: DesktopScreen[]) {
    this.screens = screens;
    this.runtime.bus.emit({ type: "desktop-screens", screens });
  }

  private connect(generation: number) {
    let connection: { url: string; token: string };
    try { connection = this.runtime.desktop.connection(); } catch { this.retry(generation); return; }
    const url = new URL("/api/events", connection.url);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${connection.token}` } });
    this.socket = socket;
    socket.on("message", (data) => {
      if (generation !== this.generation) return;
      try {
        const value = JSON.parse(data.toString()) as { type?: string; screens?: DesktopScreen[] };
        if (value.type === "screens" && Array.isArray(value.screens)) { this.delay = 1000; this.publish(value.screens); }
      } catch { /* 忽略无效事件，保留上次快照 */ }
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (generation !== this.generation) return;
      this.socket = undefined;
      this.publish([]);
      this.retry(generation);
    });
  }

  private retry(generation: number) {
    if (generation !== this.generation) return;
    this.timer = setTimeout(() => this.connect(generation), this.delay);
    this.timer.unref();
    this.delay = Math.min(this.delay * 2, 30_000);
  }
}
