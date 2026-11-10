interface Waiter {
  owner: object;
  name: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** 公共屏幕由任务持有至结束；其他任务按到达顺序等待。 */
export class DesktopPublicLock {
  private current?: { owner: object; name: string };
  private waiters: Waiter[] = [];
  constructor(private timeoutMs = 10 * 60_000) {}

  acquire(owner: object, name: string): Promise<void> {
    if (this.current?.owner === owner) return Promise.resolve();
    if (!this.current) { this.current = { owner, name }; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { owner, name, resolve, reject, timer: setTimeout(() => {
        this.waiters = this.waiters.filter((entry) => entry !== waiter);
        reject(new Error(`公共屏幕正被『${this.current?.name ?? "其他助手"}』的任务使用`));
      }, this.timeoutMs) };
      waiter.timer.unref();
      this.waiters.push(waiter);
    });
  }

  cancelWait(owner: object) {
    for (const waiter of this.waiters.filter((entry) => entry.owner === owner)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("任务已结束。"));
    }
    this.waiters = this.waiters.filter((entry) => entry.owner !== owner);
  }

  release(owner: object) {
    this.cancelWait(owner);
    if (this.current?.owner !== owner) return;
    this.current = undefined;
    const next = this.waiters.shift();
    if (next) { clearTimeout(next.timer); this.current = { owner: next.owner, name: next.name }; next.resolve(); }
  }
}
