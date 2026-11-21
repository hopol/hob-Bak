import { describe, expect, it } from "vitest";
import type { DesktopScreen } from "../../shared/types.ts";
import { DesktopWakeTracker } from "../src/desktop-wake.ts";

const screen = (running: boolean, id = "a"): DesktopScreen => ({ id, running, browserRunning: running, viewers: 0, lastActiveAt: null });
/** 用户正开着 a 这个助手的对话，右栏没展开 */
const see = (tracker: DesktopWakeTracker, running: boolean, options: { eligible?: boolean; collapsed?: boolean; nowWide?: boolean } = {}) =>
  tracker.observe([screen(running)], "a", options.eligible ?? true, options.collapsed ?? false, options.nowWide ?? false);

describe("云桌面唤醒时自动展开右栏", () => {
  it("从没在运行变成运行才算唤醒；页面打开时本来就在运行的不算", () => {
    const opened = new DesktopWakeTracker();
    expect(see(opened, true)).toBeUndefined();
    expect(see(opened, true)).toBeUndefined();

    const woken = new DesktopWakeTracker();
    expect(see(woken, false)).toBeUndefined();
    expect(see(woken, true, { collapsed: true })).toBe("expand");
  });

  it("这块屏幕还没建过（列表里没有它）之后第一次启动也算唤醒", () => {
    const tracker = new DesktopWakeTracker();
    expect(tracker.observe([screen(false, "other")], "a", true, false, false)).toBeUndefined();
    expect(tracker.observe([screen(false, "other"), screen(true)], "a", true, false, false)).toBe("expand");
  });

  it("自动展开后用户收起，这一次运行不再弹；回收后再唤醒又弹", () => {
    const tracker = new DesktopWakeTracker();
    see(tracker, false);
    expect(see(tracker, true)).toBe("expand");
    expect(see(tracker, true, { nowWide: true })).toBeUndefined();
    expect(see(tracker, true, { nowWide: false })).toBeUndefined();
    expect(see(tracker, true, { collapsed: true })).toBeUndefined();
    // 用户已经自己收起过，后来又自己展开：屏幕停了不替他改
    expect(see(tracker, false, { nowWide: true })).toBeUndefined();
    expect(see(tracker, true)).toBe("expand");
  });

  it("自动展开的那一次，屏幕停了跟着收回", () => {
    const tracker = new DesktopWakeTracker();
    see(tracker, false);
    expect(see(tracker, true)).toBe("expand");
    expect(see(tracker, true, { nowWide: true })).toBeUndefined();
    expect(see(tracker, false, { nowWide: true })).toBe("restore");
  });

  it("连不上云桌面（空列表）不算停，重连以后也不算唤醒", () => {
    const tracker = new DesktopWakeTracker();
    expect(see(tracker, true)).toBeUndefined();
    expect(tracker.observe([], "a", true, false, false)).toBeUndefined();
    expect(see(tracker, true)).toBeUndefined();
  });

  it("当时在看别的对话、窄屏、右栏卸载期间唤醒的，都不弹，回来也不补弹", () => {
    const elsewhere = new DesktopWakeTracker();
    see(elsewhere, false, { eligible: false });
    expect(see(elsewhere, true, { eligible: false })).toBeUndefined();
    expect(see(elsewhere, true)).toBeUndefined();

    const other = new DesktopWakeTracker();
    other.observe([screen(false)], "b", true, false, false);
    expect(other.observe([screen(true)], "b", true, false, false)).toBeUndefined();
    expect(other.observe([screen(true)], "a", true, false, false)).toBeUndefined();

    const unmounted = new DesktopWakeTracker();
    see(unmounted, false);
    unmounted.unwatch();
    expect(see(unmounted, true)).toBeUndefined();
  });

  it("本来就展开着的不用再展开", () => {
    const tracker = new DesktopWakeTracker();
    see(tracker, false, { nowWide: true });
    expect(see(tracker, true, { nowWide: true })).toBeUndefined();
  });
});
