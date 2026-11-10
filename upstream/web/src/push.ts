// 浏览器这边的推送：VAPID 公钥转字节、订阅 / 退订、设备名。纯函数单独拿出来方便测。
import type { PushSubscriptionJson } from "../../shared/types.ts";

/** 设备名：设置页靠它区分几台设备，只看 UA 里的显眼标记，不做指纹。 */
export function deviceLabel(userAgent: string): string {
  if (/iPhone/i.test(userAgent)) return "iPhone";
  if (/iPad/i.test(userAgent)) return "iPad";
  if (/Android/i.test(userAgent)) return "Android";
  if (/Macintosh|Mac OS X/i.test(userAgent)) return "Mac";
  if (/Windows/i.test(userAgent)) return "Windows";
  if (/Linux/i.test(userAgent)) return "Linux";
  return "浏览器";
}

/** VAPID 公钥是 base64url，PushManager 要 Uint8Array。 */
export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** 页面里能不能用推送（iOS 上要先把 Hob 加到主屏幕，从主屏幕打开才有 PushManager）。 */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** 现有订阅用的是不是这把公钥（拿不到就当不是，重订一次没坏处） */
export function sameKey(current: ArrayBuffer | null | undefined, expected: Uint8Array): boolean {
  if (!current || current.byteLength !== expected.length) return false;
  const bytes = new Uint8Array(current);
  return bytes.every((byte, i) => byte === expected[i]);
}

export function subscriptionJson(subscription: PushSubscription): PushSubscriptionJson | null {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh ?? "";
  const auth = json.keys?.auth ?? "";
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, keys: { p256dh, auth } };
}

/** 这台设备现在的订阅（没有就是 null）。 */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** 申请权限并订阅；被拒绝时把原因交给调用方显示。 */
export async function subscribePush(publicKey: string): Promise<{ subscription: PushSubscriptionJson } | { error: string }> {
  if (!pushSupported()) return { error: "这个浏览器不支持推送" };
  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return { error: "浏览器拒绝授予通知权限" };
    }
  }
  if (permission !== "granted") return { error: "浏览器未授予通知权限" };
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return { error: "离线页面尚未就绪，请刷新后重试" };
  const key = base64ToBytes(publicKey);
  let subscription = await registration.pushManager.getSubscription();
  // 浏览器里留着的订阅可能是旧密钥订的（服务端重置过）：推送服务会拒收，退掉重订
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    try {
      await subscription.unsubscribe();
    } catch {
      // 退不掉的话，下面重订会报错
    }
    subscription = null;
  }
  if (!subscription) {
    try {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key.buffer as ArrayBuffer,
      });
    } catch (error) {
      // 无痕窗口、浏览器没连上推送服务都在这里失败
      return { error: `浏览器订阅推送失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const json = subscriptionJson(subscription);
  if (!json) return { error: "浏览器返回的订阅信息不完整" };
  return { subscription: json };
}
