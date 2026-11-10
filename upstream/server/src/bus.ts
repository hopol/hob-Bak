import type { HobEvent } from "../../shared/types.ts";

/** 进程内事件广播：SSE 订阅者 + 内部关心状态的模块。 */
export class Bus {
  private listeners = new Set<(event: HobEvent) => void>();

  subscribe(listener: (event: HobEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: HobEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不影响其他订阅者
      }
    }
  }
}
