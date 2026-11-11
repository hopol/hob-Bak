// HOB_HOME/system/push.json：VAPID 密钥 + 订阅设备（0600、原子写）。推送走 web-push。
import { plainText } from "../../shared/plain-text.ts";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Approval, Job, PushDevice, PushSubscriptionJson, PushView } from "../../shared/types.ts";
import { systemDir } from "./config.ts";
import type { Store } from "./store.ts";

const requirePush = createRequire(import.meta.url);
const webpush = requirePush("web-push") as typeof import("web-push");

const FILE = "push.json";

/** 一条订阅在磁盘上的样子（密钥只在这里）。 */
interface DeviceRecord extends PushDevice {
  p256dh: string;
  auth: string;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface PushFile {
  vapid: VapidKeys;
  devices: DeviceRecord[];
}

/** 发给浏览器的那条通知（sw.js 的 push 事件照这个解）。 */
export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** 真正发出去的一步；测试注入假的，不碰网络。 */
export type PushSender = (
  target: PushTarget,
  payload: string,
  vapid: VapidKeys & { subject: string },
) => Promise<void>;

const webPushSender: PushSender = async (target, payload, vapid) => {
  await webpush.sendNotification(
    { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
    payload,
    { vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey } },
  );
};

export interface PushResult {
  sent: number;
  removed: number; // 订阅已失效（404/410、密钥对不上）被删掉的条数
  skipped?: "visible" | "no-devices"; // 没发的原因
  error?: string; // 发送失败的原因（几台都失败时取第一台）
}

/** 没填邮箱时的 VAPID subject：Apple 不认 mailto:…@localhost（回 403 BadJwtToken） */
const DEFAULT_SUBJECT = "https://github.com/FFatTiger/hob";

export interface PushServiceOptions {
  home: string;
  /** 设置 → 通知里填的邮箱（VAPID subject 用） */
  email: () => string;
  sender?: PushSender;
}

function isVapid(value: unknown): value is VapidKeys {
  const keys = value as Partial<VapidKeys> | undefined;
  return typeof keys?.publicKey === "string" && !!keys.publicKey && typeof keys.privateKey === "string" && !!keys.privateKey;
}

function isDevice(value: unknown): value is DeviceRecord {
  const device = value as Partial<DeviceRecord> | undefined;
  return (
    typeof device?.endpoint === "string" &&
    !!device.endpoint &&
    typeof device.p256dh === "string" &&
    typeof device.auth === "string" &&
    typeof device.label === "string" &&
    typeof device.createdAt === "string"
  );
}

function statusOf(error: unknown): number | undefined {
  const status = (error as { statusCode?: unknown })?.statusCode;
  return typeof status === "number" ? status : undefined;
}

/** 推送服务回的原因：Apple 是 {"reason":"…"}，其他服务给一段文字 */
function reasonOf(error: unknown): string {
  const body = (error as { body?: unknown })?.body;
  if (typeof body !== "string" || !body.trim()) return "";
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    if (typeof reason === "string") return reason;
  } catch {
    // 不是 JSON 就用原文
  }
  return body.trim().slice(0, 120);
}

/** 订阅已经用不了：没了（404/410），或是用旧的 VAPID 密钥订的（HOB_HOME 重置过） */
function isGone(status: number | undefined, reason: string): boolean {
  return status === 404 || status === 410 || (status === 400 && reason === "VapidPkHashMismatch");
}

function describeFailure(error: unknown, status: number | undefined, reason: string): string {
  if (status) return `推送服务拒绝（${status}${reason ? ` ${reason}` : ""}）`;
  return `连不上推送服务（${error instanceof Error ? error.message : String(error)}）`;
}

/** 推送服务（可见性只在内存里：进程重启后没有前台客户端）。 */
export class PushService {
  private data?: PushFile;
  private readonly sender: PushSender;
  /** 每个页面客户端的可见性；SSE 连接断了就删掉这一项 */
  private readonly visible = new Map<string, boolean>();
  /** clientId → 还连着几条 SSE（重连时旧的断开不会把新的状态清掉） */
  private readonly clients = new Map<string, number>();

  constructor(private readonly options: PushServiceOptions) {
    this.sender = options.sender ?? webPushSender;
  }

  private file(): string {
    return join(systemDir(this.options.home), FILE);
  }

  /** 读磁盘；文件没有就生成 VAPID 密钥，坏的订阅丢掉。 */
  private load(): PushFile {
    if (this.data) return this.data;
    let stored: Partial<PushFile> = {};
    if (existsSync(this.file())) {
      try {
        stored = JSON.parse(readFileSync(this.file(), "utf8")) as Partial<PushFile>;
      } catch (error) {
        throw new Error(`读取 ${this.file()} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
    }
    const vapid = isVapid(stored.vapid) ? stored.vapid : webpush.generateVAPIDKeys();
    const devices = Array.isArray(stored.devices) ? stored.devices.filter(isDevice) : [];
    this.data = { vapid, devices };
    this.write();
    return this.data;
  }

  private write(): void {
    const path = this.file();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  }

  private subject(): string {
    const email = this.options.email().trim();
    return email ? `mailto:${email}` : DEFAULT_SUBJECT;
  }

  view(): PushView {
    const file = this.load();
    return {
      publicKey: file.vapid.publicKey,
      email: this.options.email().trim(),
      devices: file.devices.map(({ endpoint, label, createdAt }) => ({ endpoint, label, createdAt })).reverse(),
    };
  }

  subscribe(subscription: PushSubscriptionJson, label: string): PushDevice {
    const endpoint = typeof subscription?.endpoint === "string" ? subscription.endpoint.trim() : "";
    const p256dh = typeof subscription?.keys?.p256dh === "string" ? subscription.keys.p256dh : "";
    const auth = typeof subscription?.keys?.auth === "string" ? subscription.keys.auth : "";
    if (!endpoint || !p256dh || !auth) throw new Error("订阅信息不完整：缺 endpoint 或 keys");
    const file = this.load();
    const name = label.trim().slice(0, 40) || "本机";
    const existing = file.devices.find((device) => device.endpoint === endpoint);
    const device: DeviceRecord = {
      endpoint,
      p256dh,
      auth,
      label: name,
      // 同一台重新订阅：保留第一次的时间，只更新名称和密钥
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    file.devices = [...file.devices.filter((item) => item.endpoint !== endpoint), device];
    this.write();
    return { endpoint: device.endpoint, label: device.label, createdAt: device.createdAt };
  }

  unsubscribe(endpoint: string): boolean {
    const file = this.load();
    const before = file.devices.length;
    file.devices = file.devices.filter((device) => device.endpoint !== endpoint);
    if (file.devices.length === before) return false;
    this.write();
    return true;
  }

  /** 有推送权限的页面客户端的可见性（页面自己报，只存内存）。 */
  setVisibility(clientId: string, visible: boolean): void {
    if (!clientId) return;
    this.visible.set(clientId, visible);
  }

  /** SSE 连上：记一条连接，断开时把可见性一起清掉（没法确认还在看就是不在看）。 */
  attachClient(clientId: string): () => void {
    if (!clientId) return () => undefined;
    this.clients.set(clientId, (this.clients.get(clientId) ?? 0) + 1);
    return () => {
      const left = (this.clients.get(clientId) ?? 1) - 1;
      if (left > 0) {
        this.clients.set(clientId, left);
        return;
      }
      this.clients.delete(clientId);
      this.visible.delete(clientId);
    };
  }

  /** 只要有一个页面在看着就不推：通知是给不在电脑前的人看的。 */
  hasVisible(): boolean {
    for (const visible of this.visible.values()) if (visible) return true;
    return false;
  }

  private async deliver(devices: DeviceRecord[], payload: PushPayload): Promise<PushResult> {
    const file = this.load();
    const body = JSON.stringify(payload);
    const vapid = { ...file.vapid, subject: this.subject() };
    const gone: string[] = [];
    const failures: string[] = [];
    let sent = 0;
    await Promise.all(
      devices.map(async (device) => {
        try {
          await this.sender(
            { endpoint: device.endpoint, p256dh: device.p256dh, auth: device.auth },
            body,
            vapid,
          );
          sent += 1;
        } catch (error) {
          // 订阅没了（卸载了 PWA、清过数据）或密钥对不上：删掉，别一直发空；其他失败如实报出去
          const status = statusOf(error);
          const reason = reasonOf(error);
          if (isGone(status, reason)) gone.push(device.endpoint);
          else {
            const failure = describeFailure(error, status, reason);
            console.error(`推送到「${device.label}」失败：${failure}`);
            failures.push(failure);
          }
        }
      }),
    );
    if (gone.length) {
      file.devices = file.devices.filter((device) => !gone.includes(device.endpoint));
      this.write();
    }
    return { sent, removed: gone.length, ...(failures.length ? { error: failures[0] } : {}) };
  }

  /** 该推的时候推：有可见的客户端、或一台设备都没订阅就不发。 */
  async send(payload: PushPayload): Promise<PushResult> {
    if (this.hasVisible()) return { sent: 0, removed: 0, skipped: "visible" };
    const devices = this.load().devices;
    if (!devices.length) return { sent: 0, removed: 0, skipped: "no-devices" };
    return this.deliver(devices, payload);
  }

  /** 设置页的「发一条测试」：不看可见性，只发指定设备（不给就发全部）。 */
  async test(endpoint?: string): Promise<PushResult> {
    const devices = this.load().devices;
    const targets = endpoint ? devices.filter((device) => device.endpoint === endpoint) : devices;
    if (!targets.length) return { sent: 0, removed: 0, skipped: "no-devices" };
    return this.deliver(targets, { title: "Hob", body: "测试通知：收到此消息说明推送功能正常。", url: "/" });
  }
}

/** 该推送的子集：只用到这两个方法（测试可以直接给假对象）。 */
export interface PushSink {
  send(payload: PushPayload): Promise<PushResult>;
}

export interface NotifyDeps {
  push: PushSink;
  store: Store;
}

/** 点开推送去哪：群里提的问题、群里开的任务去群聊页，其余去这个助手的单聊。 */
function openUrl(assistantId: string, groupId?: string): string {
  return groupId ? `/#/group/${encodeURIComponent(groupId)}` : `/?a=${encodeURIComponent(assistantId)}`;
}

/** 出审批：这个助手开了「需要确认时通知我」才推送。 */
export function pushApproval(deps: NotifyDeps, approval: Approval): void {
  const assistant = deps.store.assistant(approval.assistantId);
  if (!assistant?.notify) return;
  // 推送失败不能影响审批本身（也不能变成未处理的 rejection 把进程带走）
  // 推送的标题是卡片标题（一张卡可能问几个问题），正文写谁在等、等什么
  void deps.push
    .send({ title: plainText(approval.title), body: `${assistant.name} · 等待你的回答`, url: openUrl(approval.assistantId, approval.groupId) })
    .catch(() => undefined);
}

/** 任务受阻或失败：所属助手开了通知才推送。 */
export function pushJobEnd(deps: NotifyDeps, job: Job): void {
  if (job.status !== "stuck" && job.status !== "failed") return;
  const assistant = deps.store.assistant(job.assistantId);
  if (!assistant?.notify) return;
  const what = job.status === "stuck" ? "受阻" : "失败";
  const reason = job.statusReason ? `：${plainText(job.statusReason)}` : "";
  void deps.push
    .send({ title: assistant.name, body: `任务「${job.title}」${what}${reason}`, url: openUrl(job.assistantId, job.groupId) })
    .catch(() => undefined);
}
