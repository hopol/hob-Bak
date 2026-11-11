import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Approval, Job, PushSubscriptionJson } from "../../shared/types.ts";
import { createApp } from "../src/http.ts";
import { pushApproval, pushJobEnd, PushService, type PushSender } from "../src/push.ts";
import type { HobRuntime } from "../src/runtime.ts";
import { makeHob } from "./helpers.ts";

/** 假的推送发送器：记下发了什么，可以按 endpoint 让某台设备返回 410/404，或带原因的错误（Apple 的写法）。 */
function fakeSender() {
  const sent: { endpoint: string; payload: { title: string; body: string; url: string }; subject: string }[] = [];
  const gone = new Map<string, number>();
  const reject = new Map<string, { status: number; reason: string }>();
  const sender: PushSender = async (target, payload, vapid) => {
    const status = gone.get(target.endpoint);
    const rejected = reject.get(target.endpoint);
    if (status || rejected) {
      const error = new Error(`push service ${status ?? rejected?.status}`) as Error & { statusCode: number; body?: string };
      error.statusCode = status ?? rejected!.status;
      if (rejected) error.body = JSON.stringify({ reason: rejected.reason });
      throw error;
    }
    sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload), subject: vapid.subject });
  };
  return { sent, gone, reject, sender };
}

function subscription(id: string): PushSubscriptionJson {
  return { endpoint: `https://push.example/${id}`, keys: { p256dh: `p256dh-${id}`, auth: `auth-${id}` } };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

function approvalOf(assistantId: string, title = "发到公众号吗？"): Approval {
  return {
    id: "q-1",
    assistantId,
    title,
    options: [
      { key: "A", label: "发" },
      { key: "B", label: "先别发" },
    ],
    status: "pending",
    source: "router",
    createdAt: new Date().toISOString(),
  };
}

function jobOf(assistantId: string, patch: Partial<Job> = {}): Job {
  return {
    id: "t-0001",
    assistantId,
    title: "查页面卡顿",
    instruction: "查一下",
    status: "stuck",
    createdAt: new Date().toISOString(),
    stats: { reads: 0, commands: 0, edits: 0 },
    activity: [],
    ...patch,
  };
}

async function appWithCookie(runtime: HobRuntime, home: string) {
  const app = createApp(runtime, { home });
  const response = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  return { app, cookie: response.headers.get("set-cookie")?.split(";")[0] ?? "" };
}

describe("推送存储", () => {
  it("首次读就生成 VAPID，push.json 0600，订阅和退订都落盘", () => {
    const hob = makeHob();
    try {
      const view = hob.runtime.push.view();
      expect(view.publicKey.length).toBeGreaterThan(20);
      expect(view.devices).toEqual([]);
      const file = join(hob.home, "system", "push.json");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const stored = JSON.parse(readFileSync(file, "utf8")) as { vapid: { privateKey: string } };
      expect(stored.vapid.privateKey.length).toBeGreaterThan(20);
      // 密钥是存下来的，不是每次生成
      expect(hob.runtime.push.view().publicKey).toBe(view.publicKey);

      hob.runtime.push.subscribe(subscription("a"), "iPhone");
      hob.runtime.push.subscribe(subscription("b"), "Mac");
      expect(hob.runtime.push.view().devices.map((device) => device.label)).toEqual(["Mac", "iPhone"]);
      // 同一台重新订阅：只剩一条，时间还是第一次的
      const first = hob.runtime.push.view().devices.find((device) => device.label === "iPhone")!;
      hob.runtime.push.subscribe(subscription("a"), "iPhone 15");
      const devices = hob.runtime.push.view().devices;
      expect(devices.filter((device) => device.endpoint === subscription("a").endpoint)).toHaveLength(1);
      expect(devices.find((device) => device.endpoint === subscription("a").endpoint)?.createdAt).toBe(first.createdAt);

      hob.runtime.push.unsubscribe(subscription("b").endpoint);
      expect(hob.runtime.push.view().devices.map((device) => device.label)).toEqual(["iPhone 15"]);
    } finally {
      hob.close();
    }
  });

  it("订阅信息不全直接报错，不写半条", () => {
    const hob = makeHob();
    try {
      expect(() => hob.runtime.push.subscribe({ endpoint: "", keys: { p256dh: "x", auth: "y" } }, "x")).toThrow(
        /订阅信息不完整/,
      );
      expect(hob.runtime.push.view().devices).toHaveLength(0);
    } finally {
      hob.close();
    }
  });

  it("VAPID subject 用设置里的邮箱，没填就用项目主页（Apple 不认 localhost）", async () => {
    const fake = fakeSender();
    const hob = makeHob({}, { pushSender: fake.sender });
    try {
      hob.runtime.push.subscribe(subscription("a"), "iPhone");
      await hob.runtime.push.test();
      expect(fake.sent[0]?.subject).toBe("https://github.com/FFatTiger/hob");

      const current = hob.runtime.settings.get();
      hob.runtime.settings.patch(current.revision, { push: { email: "me@example.com" } });
      await hob.runtime.push.test();
      expect(fake.sent[1]?.subject).toBe("mailto:me@example.com");
    } finally {
      hob.close();
    }
  });
});

describe("推送触发规则", () => {
  it("助手开了通知才推审批；页面在看着的时候不推", async () => {
    const fake = fakeSender();
    const hob = makeHob({}, { pushSender: fake.sender });
    try {
      hob.runtime.push.subscribe(subscription("a"), "iPhone");
      const deps = { push: hob.runtime.push, store: hob.runtime.store };

      pushApproval(deps, approvalOf("hob", "发到公众号吗？"));
      await flush();
      expect(fake.sent).toHaveLength(1);
      expect(fake.sent[0]?.payload).toMatchObject({ title: "发到公众号吗？", body: "Hob · 等待你的回答", url: "/?a=hob" });

      // 页面在前台：一个可见客户端就够了
      hob.runtime.push.setVisibility("c1", true);
      pushApproval(deps, approvalOf("hob", "换个标题"));
      await flush();
      expect(fake.sent).toHaveLength(1);

      // 关掉可见性（页面切到后台）就继续推
      hob.runtime.push.setVisibility("c1", false);
      pushApproval(deps, approvalOf("hob", "再来一次"));
      await flush();
      expect(fake.sent).toHaveLength(2);

      // 群里提的问题：点开去群聊页
      pushApproval(deps, { ...approvalOf("hob", "群里问"), groupId: "g-1" });
      await flush();
      expect(fake.sent[2]?.payload).toMatchObject({ title: "群里问", body: "Hob · 等待你的回答", url: "/#/group/g-1" });

      // 助手关了「需要我拍板时通知我」
      const hobAssistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...hobAssistant, notify: false });
      pushApproval(deps, approvalOf("hob", "不该推"));
      await flush();
      expect(fake.sent).toHaveLength(3);
    } finally {
      hob.close();
    }
  });

  it("任务受阻或失败推给所属助手，已完成不推", async () => {
    const fake = fakeSender();
    const hob = makeHob({}, { pushSender: fake.sender });
    try {
      hob.runtime.push.subscribe(subscription("a"), "iPhone");
      const deps = { push: hob.runtime.push, store: hob.runtime.store };

      pushJobEnd(deps, jobOf("hob", { status: "stuck", statusReason: "15 分钟无响应" }));
      await flush();
      expect(fake.sent[0]?.payload.body).toBe("任务「查页面卡顿」受阻：15 分钟无响应");

      pushJobEnd(deps, jobOf("hob", { status: "failed", statusReason: "Hob 重启，任务中断" }));
      await flush();
      expect(fake.sent[1]?.payload.body).toBe("任务「查页面卡顿」失败：Hob 重启，任务中断");

      pushJobEnd(deps, jobOf("hob", { status: "done" }));
      await flush();
      expect(fake.sent).toHaveLength(2);

      // 群里的任务：点开去它所在的群
      pushJobEnd(deps, jobOf("hob", { status: "stuck", statusReason: "卡住了", groupId: "g-1" }));
      await flush();
      expect(fake.sent[2]?.payload).toMatchObject({ url: "/#/group/g-1" });
    } finally {
      hob.close();
    }
  });

  it("SSE 断开就当作看不见：重连计数归零才清掉可见性", async () => {
    const hob = makeHob();
    try {
      hob.runtime.push.setVisibility("c1", true);
      const detachFirst = hob.runtime.push.attachClient("c1");
      const detachSecond = hob.runtime.push.attachClient("c1");
      expect(hob.runtime.push.hasVisible()).toBe(true);
      detachFirst();
      expect(hob.runtime.push.hasVisible()).toBe(true);
      detachSecond();
      expect(hob.runtime.push.hasVisible()).toBe(false);
    } finally {
      hob.close();
    }
  });

  it("推送服务回 410/404 的订阅自动删掉", async () => {
    const fake = fakeSender();
    const hob = makeHob({}, { pushSender: fake.sender });
    try {
      hob.runtime.push.subscribe(subscription("alive"), "Mac");
      hob.runtime.push.subscribe(subscription("dead"), "iPhone");
      fake.gone.set(subscription("dead").endpoint, 410);
      const result = await hob.runtime.push.send({ title: "Hob", body: "x", url: "/" });
      expect(result.sent).toBe(1);
      expect(result.removed).toBe(1);
      expect(hob.runtime.push.view().devices.map((device) => device.label)).toEqual(["Mac"]);
    } finally {
      hob.close();
    }
  });

  it("旧密钥订的（Apple 回 400 VapidPkHashMismatch）也删掉；其他拒绝如实带回原因、设备留着", async () => {
    const fake = fakeSender();
    const hob = makeHob({}, { pushSender: fake.sender });
    try {
      hob.runtime.push.subscribe(subscription("stale"), "iPhone");
      hob.runtime.push.subscribe(subscription("jwt"), "iPad");
      fake.reject.set(subscription("stale").endpoint, { status: 400, reason: "VapidPkHashMismatch" });
      fake.reject.set(subscription("jwt").endpoint, { status: 403, reason: "BadJwtToken" });
      const result = await hob.runtime.push.send({ title: "Hob", body: "x", url: "/" });
      expect(result).toEqual({ sent: 0, removed: 1, error: "推送服务拒绝（403 BadJwtToken）" });
      expect(hob.runtime.push.view().devices.map((device) => device.label)).toEqual(["iPad"]);
    } finally {
      hob.close();
    }
  });
});

describe("推送接口", () => {
  it("GET 返回 publicKey 和设备，没登录 401", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      expect((await app.request("/api/push")).status).toBe(401);
      const response = await app.request("/api/push", { headers: { cookie } });
      expect(response.status).toBe(200);
      const view = (await response.json()) as { publicKey: string; email: string; devices: unknown[] };
      expect(view.publicKey.length).toBeGreaterThan(20);
      expect(view.email).toBe("");
      expect(view.devices).toEqual([]);
    } finally {
      hob.close();
    }
  });

  it("订阅、测试、删除一条龙；坏订阅 400，没订阅的设备测试 404", async () => {
    const fake = fakeSender();
    const hob = makeHob({}, { pushSender: fake.sender });
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const post = (path: string, body: unknown) =>
        app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        });

      expect((await post("/api/push/subscribe", { subscription: { endpoint: "x" }, label: "x" })).status).toBe(400);

      const added = await post("/api/push/subscribe", { subscription: subscription("a"), label: "iPhone" });
      expect(added.status).toBe(200);
      const view = (await added.json()) as { device: { endpoint: string; label: string }; push: { devices: unknown[] } };
      expect(view.device.label).toBe("iPhone");
      expect(view.push.devices).toHaveLength(1);

      expect((await post("/api/push/test", { endpoint: "https://push.example/other" })).status).toBe(404);
      const tested = await post("/api/push/test", { endpoint: subscription("a").endpoint });
      expect(tested.status).toBe(200);
      expect(await tested.json()).toEqual({ sent: 1, removed: 0 });
      expect(fake.sent[0]?.payload.body).toContain("测试通知");

      // 推送服务拒收：不是「发了 0 条」，是带原因的失败
      fake.reject.set(subscription("a").endpoint, { status: 403, reason: "BadJwtToken" });
      const refused = await post("/api/push/test", { endpoint: subscription("a").endpoint });
      expect(refused.status).toBe(502);
      expect(await refused.json()).toEqual({ error: "发送失败：推送服务拒绝（403 BadJwtToken）" });
      fake.reject.clear();

      const deleted = await app.request("/api/push/subscribe", {
        method: "DELETE",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ endpoint: subscription("a").endpoint }),
      });
      expect(deleted.status).toBe(200);
      expect(((await deleted.json()) as { devices: unknown[] }).devices).toEqual([]);
    } finally {
      hob.close();
    }
  });

  it("可见性上报：缺 clientId 400，可见后发送被跳过", async () => {
    const fake = fakeSender();
    const hob = makeHob({}, { pushSender: fake.sender });
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      hob.runtime.push.subscribe(subscription("a"), "iPhone");
      const post = (body: unknown) =>
        app.request("/api/visibility", {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify(body),
        });
      expect((await post({ visible: true })).status).toBe(400);
      expect((await post({ clientId: "c1", visible: true })).status).toBe(200);
      const result = await hob.runtime.push.send({ title: "Hob", body: "x", url: "/" });
      expect(result).toMatchObject({ sent: 0, skipped: "visible" });
      expect(fake.sent).toHaveLength(0);
    } finally {
      hob.close();
    }
  });

  it("设置里填的邮箱：格式不对 400，改完 subject 跟着变", async () => {
    const hob = makeHob();
    try {
      const { app, cookie } = await appWithCookie(hob.runtime, hob.home);
      const current = hob.runtime.settings.get();
      const put = (email: string) =>
        app.request("/api/settings", {
          method: "PUT",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ revision: current.revision, patch: { push: { email } } }),
        });
      expect((await put("not-an-email")).status).toBe(400);
      const ok = await put("me@example.com");
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { settings: { push: { email: string } } }).settings.push.email).toBe(
        "me@example.com",
      );
    } finally {
      hob.close();
    }
  });
});

describe("PushService 单独用", () => {
  it("没有设备时发送直接跳过，不报错", async () => {
    const home = mkdtempSync(join(tmpdir(), "hob-push-"));
    try {
      const service = new PushService({ home, email: () => "" });
      const result = await service.send({ title: "Hob", body: "x", url: "/" });
      expect(result).toMatchObject({ sent: 0, skipped: "no-devices" });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
