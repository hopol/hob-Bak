import type { DesktopScreen } from "../../shared/types.ts";

interface ScreenState {
  running: boolean;
  /** 上一次看到它时，用户正开着这个助手的对话（电脑端、右栏没被别的页盖住） */
  watched: boolean;
  /** 这一次运行是我们自动展开的，用户还没自己收起：屏幕停了由我们收回 */
  autoExpanded: boolean;
}

/**
 * 云桌面被唤醒（一块屏幕从没在运行变成运行）时，要不要自动把右栏展开。
 * 状态只在当前页面的内存里，按屏幕记。
 */
export class DesktopWakeTracker {
  private readonly states = new Map<string, ScreenState>();

  /** 右栏「正在做」卸载了：这期间发生的唤醒没人在看，回来以后不补弹。 */
  unwatch(): void {
    for (const state of this.states.values()) state.watched = false;
  }

  /** watched：用户此刻看着的屏幕（单聊是这个助手的，群信息页是全体成员的）。 */
  observe(screens: readonly DesktopScreen[], watched: readonly string[], eligible: boolean, collapsed: boolean, nowWide: boolean): "expand" | "restore" | undefined {
    // 空列表是连不上云桌面（断线、Hob 重启），状态未知：什么都不动，不然重连会被当成一次唤醒
    if (!screens.length) return undefined;
    const ids = new Set([...this.states.keys(), ...screens.map((screen) => screen.id), ...watched]);
    let action: "expand" | "restore" | undefined;
    for (const id of ids) {
      // 列表里没有这块屏幕：它还没建过，算没在运行
      const running = screens.some((screen) => screen.id === id && screen.running);
      const watching = watched.includes(id) && eligible;
      const previous = this.states.get(id);
      const next: ScreenState = { running, watched: watching, autoExpanded: false };
      if (previous?.running && running) {
        // 自动展开以后用户自己收起了：这一次运行不再管它
        next.autoExpanded = previous.autoExpanded && !(watching && (collapsed || !nowWide));
      } else if (previous && !previous.running && running) {
        if (watching && previous.watched && (collapsed || !nowWide)) {
          next.autoExpanded = true;
          action = "expand";
        }
      } else if (previous?.running && !running && previous.autoExpanded && nowWide) {
        action = "restore";
      }
      this.states.set(id, next);
    }
    return action;
  }
}
