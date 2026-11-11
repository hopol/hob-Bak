import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { Item } from "../../shared/types.ts";
import { answerApproval } from "../src/actions.ts";
import { createRuntime } from "../src/runtime.ts";
import { createApp } from "../src/http.ts";
import { PiHost } from "../src/pi.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { applyDelta, mergeItems } from "../../web/src/merge.ts";
import { call, makeHob, memoryDir, text, waitFor } from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { briefModelError } from "../src/router.ts";
import { join } from "node:path";

/** 模型这一轮收到的系统提示词：pi 把它存成 system 消息的 sections，改了的话再加一条只带 diff 的 system 消息。 */
function systemText(context: {
  messages: ReadonlyArray<{ role: string; content?: unknown; sections?: Record<string, string | null> }>;
}): string {
  const parts: string[] = [];
  for (const message of context.messages) {
    if (message.role !== "system") continue;
    if (message.sections) parts.push(...Object.values(message.sections).filter((part): part is string => !!part));
    else if (typeof message.content === "string") parts.push(message.content);
  }
  return parts.join("\n");
}

describe("Router", () => {
  it("现在块只进模型消息，不进用户气泡或事件展示", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.faux.setResponses([text("收到"), text("知道了")]);
      await hob.runtime.router.send("hob", { text: "你好" });
      await hob.runtime.router.waitIdle("hob");
      await hob.runtime.router.event("hob", "任务完成");
      await waitFor(() => readFileSync(hob.runtime.store.routerFile("hob"), "utf8").includes("[hob-event] 任务完成"));
      await hob.runtime.router.waitIdle("hob");
      const entries = readFileSync(hob.runtime.store.routerFile("hob"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const user = entries.find((entry) => entry.type === "message" && entry.message?.role === "user");
      expect(JSON.stringify(user.message.content)).toContain("【现在】");
      expect(JSON.stringify(user.message.content)).toContain("你好");
      expect(entries.find((entry) => entry.customType === "hob.user").data.text).toBe("你好");
      const event = entries.find((entry) => entry.type === "custom_message" && entry.customType === "hob.event");
      expect(event.content).toMatch(/^【现在】[\s\S]*\n\n\[hob-event\] 任务完成$/);
      expect(event.display).toBe(false);
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "user")).toMatchObject([{ text: "你好" }]);
      expect(JSON.stringify(hob.runtime.router.items("hob"))).not.toContain("【现在】");
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "test" }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const response = await app.request("/api/assistants/hob/items", { headers: { cookie } });
      expect(response.status).toBe(200);
      const page = await response.json();
      expect(page.items.filter((item: Item) => item.kind === "user")).toMatchObject([{ text: "你好" }]);
      expect(JSON.stringify(page)).not.toContain("【现在】");
    } finally { hob.close(); }
  });
  it("记忆插件写成功就出一行「记忆已更新」", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("memory_write", { target: "long_term", content: "我不看融资新闻" }),
        text("记下了。"),
      ]);
      await hob.runtime.router.send("hob", { text: "记住：我不看融资新闻" });
      await hob.runtime.router.waitIdle("hob");

      const page = hob.runtime.router.items("hob");
      expect(page.items.map((item) => item.kind)).toEqual(["user", "note", "assistant"]);
      expect(page.items[1]).toMatchObject({ kind: "note", icon: "memory", text: "记忆已更新 · 我不看融资新闻" });
      expect(page.items[2]).toMatchObject({ kind: "assistant", text: "记下了。" });
      // 写进了本地记忆文件（pi-memory 的默认目录，测试里指向临时目录）
      expect(readFileSync(join(memoryDir(), "MEMORY.md"), "utf8")).toContain("我不看融资新闻");
    } finally {
      hob.close();
    }
  });

  it("set_rule 写规则并出 note 条目", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("set_rule", { text: "发公众号", mode: "ask" }), text("好。")]);
      await hob.runtime.router.send("hob", { text: "发公众号之前要问我" });
      await hob.runtime.router.waitIdle("hob");

      expect(hob.runtime.store.rules("hob")).toMatchObject([{ text: "发公众号", mode: "ask" }]);
      const note = hob.runtime.router.items("hob").items.find((item) => item.kind === "note");
      expect(note).toMatchObject({ icon: "rule", text: "已记入Hob的规则 · 发公众号" });
    } finally {
      hob.close();
    }
  });

  it("别的助手的审批只出现在它自己的对话里，不转述到主助手；旧数据里的转述卡也不显示", async () => {
    const hob = makeHob();
    try {
      hob.runtime.store.saveAssistant({
        id: "ops",
        name: "运维",
        duty: "线上和机器",
        sprite: "server",
        primary: false,
        pinned: true,
        hidden: false,
        notify: true,
        createdAt: new Date().toISOString(),
      });
      hob.faux.setResponses([call("ask_user", { title: "加一个 Mac 巡检吗？", options: [{ label: "加" }, { label: "先不加" }] })]);
      await hob.runtime.router.send("ops", { text: "我 mac 的呢" });
      await hob.runtime.router.waitIdle("ops");

      const approval = hob.runtime.store.approvals()[0];
      expect(hob.runtime.router.items("ops").items.some((item) => item.kind === "question" && item.approvalId === approval.id)).toBe(true);
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "question")).toBe(false);

      // 旧版本写进主助手对话的转述卡
      await hob.runtime.router.addItem("hob", { kind: "question", approvalId: approval.id, relay: true } as never);
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "question")).toBe(false);
    } finally {
      hob.close();
    }
  });

  it("ask_user 出审批卡，选 always 选项写 allow 规则", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("ask_user", {
          title: "发到公众号吗？",
          detail: "发出去就撤不回了",
          options: [{ label: "发" }, { label: "不发" }],
          remember: "发公众号",
        }),
        text("等你定。"),
      ]);
      await hob.runtime.router.send("hob", { text: "帮我发一篇" });
      await hob.runtime.router.waitIdle("hob");

      const approval = hob.runtime.store.approvals()[0];
      expect(approval).toMatchObject({ status: "pending", source: "router", title: "发到公众号吗？" });
      expect(approval.options.map((option) => option.key)).toEqual(["A", "B", "C"]);

      const question = hob.runtime.router.items("hob").items.find((item) => item.kind === "question");
      expect(question).toMatchObject({ kind: "question", approvalId: approval.id });

      hob.faux.setResponses([text("好，以后直接发。")]);
      const result = await answerApproval(hob.runtime, approval.id, { key: "C" });
      expect(result.status).toBe(200);
      await hob.runtime.router.waitIdle("hob");

      expect(hob.runtime.store.rules("hob")).toMatchObject([{ text: "发公众号", mode: "allow" }]);
      const items = hob.runtime.router.items("hob").items;
      expect(items.some((item) => item.kind === "note" && item.text === "已记入Hob的规则 · 发公众号")).toBe(true);
      expect(hob.runtime.store.approval(approval.id)).toMatchObject({ status: "answered", chosen: "C" });

      // 再答一次 409
      const again = await answerApproval(hob.runtime, approval.id, { key: "A" });
      expect(again.status).toBe(409);
    } finally {
      hob.close();
    }
  });

  it("对话回复结束本助手的 Router 提问，不影响任务提问，即使没有模型", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("ask_user", { title: "发吗", options: [{ label: "发" }, { label: "不发" }] })]);
      await hob.runtime.router.send("hob", { text: "帮我发" });
      await hob.runtime.router.waitIdle("hob");
      const approval = hob.runtime.store.approvals()[0];
      const jobApproval = { ...approval, id: "job-question", source: "job" as const, jobId: "job-1" };
      hob.runtime.store.saveApproval(jobApproval);
      const emitted: string[] = [];
      hob.runtime.bus.subscribe((entry) => { if (entry.type === "approval") emitted.push(entry.approval.id); });
      vi.spyOn(hob.runtime.router as unknown as { modelGap: () => Promise<string | undefined> }, "modelGap").mockResolvedValue("没有模型");
      await hob.runtime.router.send("hob", { text: "先别发" });
      expect(hob.runtime.store.approval(approval.id)?.status).toBe("expired");
      expect(hob.runtime.store.approval(jobApproval.id)?.status).toBe("pending");
      expect(emitted).toEqual([approval.id]);
    } finally { hob.close(); }
  });

  it("自己写的一段话作为答案：事件里写清是用户写的，照样进 Router 上下文", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("ask_user", { title: "发到公众号吗？", options: [{ label: "发" }, { label: "不发" }] }),
        text("等你定。"),
      ]);
      await hob.runtime.router.send("hob", { text: "帮我发一篇" });
      await hob.runtime.router.waitIdle("hob");
      const approval = hob.runtime.store.approvals()[0];

      hob.faux.setResponses([text("明白，等你写完再发。")]);
      expect((await answerApproval(hob.runtime, approval.id, { text: "先别发，等我写完摘要" })).status).toBe(200);
      await hob.runtime.router.waitIdle("hob");

      expect(hob.runtime.store.approval(approval.id)).toMatchObject({
        status: "answered",
        answerText: "先别发，等我写完摘要",
      });
      const session = readFileSync(join(hob.home, "assistants", "hob", "router.jsonl"), "utf8");
      expect(session).toContain("[hob-event] 用户没有选给出的选项，而是回复：先别发，等我写完摘要");
    } finally {
      hob.close();
    }
  });

  it("选了 always 选项之后模型又记了一遍同一条规则，「已记入…的规则」只出一行", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("ask_user", {
          title: "升级完要重启吗？",
          options: [{ label: "只重启 hapi-hub" }, { label: "暂不重启" }],
          remember: "升级 hapi 后重启 hapi-hub / hapi-runner",
        }),
      ]);
      await hob.runtime.router.send("hob", { text: "刚升级了 hapi" });
      await hob.runtime.router.waitIdle("hob");
      const approval = hob.runtime.store.approvals()[0];
      expect(approval).toMatchObject({ status: "pending" });

      // 答 always 时规则已经写好了；Router 收到答案事件后按模型的实际做法又调了一次 set_rule
      hob.faux.setResponses([
        call("set_rule", { text: "升级 hapi 后重启 hapi-hub / hapi-runner", mode: "allow" }),
        text("好，以后两个都重启。"),
      ]);
      expect((await answerApproval(hob.runtime, approval.id, { key: "C" })).status).toBe(200);
      await hob.runtime.router.waitIdle("hob");

      const notes = hob.runtime
        .router.items("hob")
        .items.filter((item) => item.kind === "note" && item.text === "已记入Hob的规则 · 升级 hapi 后重启 hapi-hub / hapi-runner");
      expect(notes).toHaveLength(1);
      expect(hob.runtime.store.rules("hob")).toMatchObject([
        { text: "升级 hapi 后重启 hapi-hub / hapi-runner", mode: "allow" },
      ]);
    } finally {
      hob.close();
    }
  });

  it("create_assistant 直接建好助手，草稿卡是已创建的样子", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("create_assistant", {
          name: "写作",
          duty: "周报和文章",
          dutyLong: "每周写周报，写公众号文章。",
          sprite: "page",
          routines: [{ name: "周报", instruction: "写本周周报", schedule: "0 17 * * 5" }],
          askFirst: ["发公众号"],
          facts: ["标题不超过 20 字"],
        }),
        text("建好了。"),
      ]);
      await hob.runtime.router.send("hob", { text: "以后写作的事单独开个助手" });
      await hob.runtime.router.waitIdle("hob");

      const draft = hob.runtime.store.drafts()[0];
      expect(draft).toMatchObject({
        status: "created",
        name: "写作",
        duty: "周报和文章",
        sprite: "page",
        routinesText: "周报 · 每周五 17:00",
        instructions: ["标题不超过 20 字"],
      });
      expect(draft).not.toHaveProperty("carry");
      expect(hob.runtime.store.assistant(draft.createdAssistantId!)?.splitFrom).not.toHaveProperty("conversations");
      expect(hob.runtime.store.assistant(draft.createdAssistantId!)).toMatchObject({ name: "写作", instructions: "标题不超过 20 字" });
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "draft" && item.draftId === draft.id)).toBe(true);
      // 不结束这一轮：建好之后模型还能接着说话
      expect(hob.runtime.router.items("hob").items.some((item) => item.kind === "assistant" && item.text === "建好了。")).toBe(true);
    } finally {
      hob.close();
    }
  });

  it("不刷新时的实时事件和刷新后的条目完全一致（连发三条）", async () => {
    const hob = makeHob();
    try {
      // 前端那套合并逻辑：item 按 id 合并、delta 追加
      let live: Item[] = [];
      hob.runtime.bus.subscribe((event) => {
        if (event.assistantId !== "hob") return;
        if (event.type === "item") live = mergeItems(live, event.item);
        else if (event.type === "delta") live = applyDelta(live, event.itemId, event.text);
      });

      const slow = async () => {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return text("记住了");
      };
      hob.faux.setResponses([slow]);
      await hob.runtime.router.send("hob", { text: "记住：以后说短句" });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 第二条在上一轮还没出结果时发出去（走 steer），事件顺序会和会话文件顺序不一致
      hob.faux.appendResponses([call("memory_write", { target: "daily", content: "说话用短句" }), text("记好了。")]);
      await hob.runtime.router.send("hob", { text: "以后说话用短句" });
      hob.faux.appendResponses([text("加好了。")]);
      await hob.runtime.router.send("hob", { text: "再说一遍" });
      await hob.runtime.router.waitIdle("hob", 20_000);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const refreshed = hob.runtime.router.items("hob").items;
      expect(live.map((item) => `${item.kind}:${item.id}:${item.at}`)).toEqual(
        refreshed.map((item) => `${item.kind}:${item.id}:${item.at}`),
      );
      expect(live.map((item) => (item.kind === "assistant" ? item.text : ""))).toEqual(
        refreshed.map((item) => (item.kind === "assistant" ? item.text : "")),
      );
    } finally {
      hob.close();
    }
  });

  it("分组：事件触发的回复标 lead，流式占位就带着，和刷新后一致；任务图片先开组时回复接着图片", async () => {
    const hob = makeHob();
    try {
      let live: Item[] = [];
      const placeholders: Item[] = [];
      hob.runtime.bus.subscribe((event) => {
        if (event.assistantId !== "hob") return;
        if (event.type === "item") {
          if (event.item.kind === "assistant" && event.item.streaming) placeholders.push(event.item);
          live = mergeItems(live, event.item);
        } else if (event.type === "delta") live = applyDelta(live, event.itemId, event.text);
      });

      hob.faux.setResponses([text("交给后台了。")]);
      await hob.runtime.router.send("hob", { text: "查一下磁盘" });
      await hob.runtime.router.waitIdle("hob");
      hob.faux.appendResponses([text("查完了：磁盘用了 40%。")]);
      await hob.runtime.router.event("hob", "任务「查磁盘」已完成");
      await hob.runtime.router.waitIdle("hob");
      await hob.runtime.router.addItem("hob", { kind: "file", path: "/tmp/cat.png", name: "cat.png", lead: true });
      hob.faux.appendResponses([text("画好了，就是上面这张。")]);
      await hob.runtime.router.event("hob", "任务「画猫」已完成", { cont: true });
      await hob.runtime.router.waitIdle("hob");
      await new Promise((resolve) => setTimeout(resolve, 50));

      const lead = (item: Item) => `${item.kind}:${item.lead ?? false}`;
      const refreshed = hob.runtime.router.items("hob").items;
      expect(refreshed.map(lead)).toEqual(["user:false", "assistant:false", "assistant:true", "file:true", "assistant:false"]);
      expect(live.map(lead)).toEqual(refreshed.map(lead));
      expect(placeholders.map((item) => item.lead ?? false)).toEqual([false, true, false]);
    } finally {
      hob.close();
    }
  });

  it("Router 憋着不出字：6 分钟没事件就叫停并明说", async () => {
    // 真的等 6 分钟不行，把 Router 的看门狗调短
    const hob = makeHob();
    hob.runtime.router.stallOverrideMs = 60;
    try {
      hob.faux.setResponses([() => new Promise<never>(() => undefined)]);
      await hob.runtime.router.send("hob", { text: "在吗" });
      await waitFor(() =>
        hob.runtime.router.items("hob").items.some((item) => item.kind === "note" && item.icon === "info"),
      );
      const note = hob.runtime.router
        .items("hob")
        .items.find((item) => item.kind === "note" && item.icon === "info");
      expect(note).toMatchObject({ kind: "note", text: "Hob 无响应，已停止，可重新发送" });
      // 只写这一行，不要再多一条“发生错误”
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "note")).toHaveLength(1);
    } finally {
      hob.close();
    }
  });

  it("新建助手：先写“由 Hob 创建”，再来一条它自己的开场白", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("create_assistant", {
          name: "写作",
          duty: "周报和文章",
          dutyLong: "每周写周报。",
          sprite: "page",
          routines: [{ name: "周报", instruction: "写周报", schedule: "0 17 * * 5" }],
          facts: ["负责周报"],
        }),
        text("建好了。"),
      ]);
      await hob.runtime.router.send("hob", { text: "写作的事单独开个助手" });
      await hob.runtime.router.waitIdle("hob");

      const id = hob.runtime.store.drafts()[0]!.createdAssistantId!;
      const items = hob.runtime.router.items(id).items;
      expect(items.map((item) => item.kind)).toEqual(["note", "assistant"]);
      expect(items[0]).toMatchObject({ kind: "note", icon: "split" });
      expect(items[0].kind === "note" ? items[0].text : "").toContain("由 Hob 创建");
      expect(items[1]).toMatchObject({
        kind: "assistant",
        text: "我是写作，负责周报和文章。\n定时任务：周报 · 每周五 17:00",
      });
    } finally {
      hob.close();
    }
  });

  it("卡片类工具返回“本轮到此结束”，草稿 duty 裁到 8 个字", async () => {
    const hob = makeHob();
    try {
      const tools = buildRouterTools(hob.runtime, "hob");
      const run = async (name: string, args: Record<string, unknown>): Promise<string> => {
        const tool = tools.find((item) => item.name === name)!;
        const result = (await tool.execute("tool-call", args)) as {
          content: { type: string; text: string }[];
          terminate?: boolean;
        };
        // 三个卡片工具都带 terminate：出了卡就不再请求模型
        expect(result.terminate).toBe(true);
        return result.content[0].text;
      };
      hob.faux.setResponses([call("report", { outcome: "done", result: "好了" }), text("好")]);
      hob.faux.appendResponses([text("好")]);

      expect(await run("start_job", { title: "查磁盘", instruction: "看看磁盘" })).toMatch(/^任务「查磁盘」.*已开始，预计 10 分钟（默认）。$/);
      expect(await run("ask_user", { title: "发吗", options: [{ label: "发" }, { label: "别发" }] })).toContain(
        "问题卡已显示给用户。",
      );
      await hob.runtime.jobs.waitIdle();
    } finally {
      hob.close();
    }
  });

  it("新建助手的 duty 裁到 8 个字，头像只认内置的，建好不结束本轮", async () => {
    const hob = makeHob();
    try {
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "create_assistant")!;
      const created = (await tool.execute("tool-call", {
        name: "动态",
        duty: "盯着模型发布和 agent 产品的最新动态",
        dutyLong: "盯模型发布、agent 产品和开源项目，每天挑 6 条。",
        sprite: "bird",
        facts: ["负责模型动态"],
      })) as { terminate?: boolean };
      // 不结束这一轮：建好以后还能接着说话
      expect(created.terminate).toBeUndefined();
      expect(hob.runtime.store.drafts()[0]?.duty).toBe("盯着模型发布和");
      // 模型给的头像只认内置的，不能指到生成的头像文件上
      await tool.execute("tool-call", { name: "旁门", duty: "试试", dutyLong: "试试。", sprite: "img:img-abc123.png", facts: ["负责测试"] });
      expect(hob.runtime.store.drafts().find((draft) => draft.name === "旁门")?.sprite).toBe("page");
    } finally {
      hob.close();
    }
  });

  it("卡片工具之后结构上结束本轮：模型准备的那句话不会被请求", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("ask_user", { title: "发吗", options: [{ label: "发" }, { label: "别发" }] }),
        text("问题卡在上面，点一下就好。"),
      ]);
      await hob.runtime.router.send("hob", { text: "帮我发一篇" });
      await hob.runtime.router.waitIdle("hob");
      await new Promise((resolve) => setTimeout(resolve, 50));

      // 只请求了一次：卡片之后没有再问模型
      expect(hob.faux.state.callCount).toBe(1);
      expect(hob.faux.getPendingResponseCount()).toBe(1);
      const items = hob.runtime.router.items("hob").items;
      expect(items.map((item) => item.kind)).toEqual(["user", "question"]);
    } finally {
      hob.close();
    }
  });

  it("改了规则/补充说明，下一轮的系统提示词里就有", async () => {
    const hob = makeHob();
    try {
      const seen: string[] = [];
      hob.faux.setResponses([
        call("set_rule", { text: "发公众号", mode: "ask" }),
        text("记下了。"),
        (context) => {
          seen.push(systemText(context));
          return text("好的。");
        },
        text("好的。"),
      ]);
      const assistant = hob.runtime.store.assistant("hob")!;
      hob.runtime.store.saveAssistant({ ...assistant, instructions: "标题不超过 20 字" });
      await hob.runtime.router.send("hob", { text: "发公众号之前要问我" });
      await hob.runtime.router.waitIdle("hob");
      await hob.runtime.router.send("hob", { text: "在吗" });
      await hob.runtime.router.waitIdle("hob");

      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("## 补充说明");
      expect(seen[0]).toContain("标题不超过 20 字");
      expect(seen[0]).toContain("执行前确认：发公众号");
    } finally {
      hob.close();
    }
  });

  it("新建助手之后，下一轮的系统提示词里就有它", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("create_assistant", {
          name: "写作",
          duty: "周报和文章",
          dutyLong: "每周写周报。",
          sprite: "page",
          routines: [],
          facts: ["负责周报"],
        }),
        text("建好了。"),
      ]);
      await hob.runtime.router.send("hob", { text: "写作的事单独开个助手" });
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.store.drafts()[0]).toMatchObject({ status: "created" });

      const seen: string[] = [];
      hob.faux.setResponses([
        (context) => {
          seen.push(systemText(context));
          return text("好。");
        },
        text("好。"),
      ]);
      await hob.runtime.router.send("hob", { text: "写作在吗" });
      await hob.runtime.router.waitIdle("hob");

      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain("## 助手");
      expect(seen[0]).toContain("写作");
    } finally {
      hob.close();
    }
  });

  it("事件消息不出用户气泡", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([text("磁盘用了 40%。")]);
      await hob.runtime.router.event("hob", "任务「查磁盘」完成：用了 40%");
      await hob.runtime.router.waitIdle("hob");

      const items = hob.runtime.router.items("hob").items;
      expect(items.map((item) => item.kind)).toEqual(["assistant"]);
      expect(items[0]).toMatchObject({ text: "磁盘用了 40%。" });
    } finally {
      hob.close();
    }
  });

  it("重启后条目推导一致", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([call("memory_write", { target: "long_term", content: "标题不超过 20 字" }), text("好。")]);
      await hob.runtime.router.send("hob", { text: "记住：标题不超过 20 字" });
      await hob.runtime.router.waitIdle("hob");
      const before = hob.runtime.router.items("hob").items;

      hob.runtime.router.disposeAll();
      const config = hob.runtime.config;
      const pi = new PiHost({ engineDir: join(hob.home, "system", "engine"), modelsPath: null, nativeProviders: [hob.faux.provider] });
      const restarted = createRuntime({ home: hob.home, config, pi });
      try {
        const after = restarted.router.items("hob").items;
        expect(after).toEqual(before);
        expect(after.map((item) => item.id)).toEqual(before.map((item) => item.id));
        expect(join(hob.home, "assistants", "hob", "router.jsonl")).toContain("router.jsonl");
      } finally {
        restarted.router.disposeAll();
      }
    } finally {
      hob.close();
    }
  });

  it("从没标过已读的助手，新回复也算未读", async () => {
    const hob = makeHob();
    try {
      expect(hob.runtime.router.unread("hob")).toBe(0);
      hob.faux.setResponses([text("做完了。")]);
      await hob.runtime.router.event("hob", "任务「查资料」已完成：结果在这里");
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.router.unread("hob")).toBe(1);
    } finally {
      hob.close();
    }
  });

  it("未读数是最后 read 之后的助手条目数", async () => {
    const hob = makeHob();
    try {
      hob.runtime.router.read("hob");
      hob.faux.setResponses([text("第一句。")]);
      await hob.runtime.router.send("hob", { text: "在吗" });
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.router.unread("hob")).toBe(1);
      hob.runtime.router.read("hob");
      expect(hob.runtime.router.unread("hob")).toBe(0);
    } finally {
      hob.close();
    }
  });

  it("手动停止后这一轮报错不算回复失败（Claude 订阅桥把停止报成 error）", async () => {
    const hob = makeHob();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hob.faux.setResponses([async () => { await gate; return fauxAssistantMessage([], { stopReason: "error", errorMessage: "This operation was aborted" }); }]);
      const turn = hob.runtime.router.event("hob", "任务「查资料」已停止。\n你叫停了");
      await waitFor(() => hob.runtime.router.bootstrap().assistants[0].activity?.state === "thinking");
      // 假模型收到停止会自己报 aborted；这里让停止不传到模型，模拟订阅桥停下后回一条 error
      (hob.runtime.router as never as { routers: Map<string, { session: { abort: () => Promise<void> } }> }).routers.get("hob")!.session.abort = async () => {};
      await hob.runtime.router.stop("hob");
      release();
      await turn;
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "note")).toEqual([]);
    } finally {
      hob.close();
    }
  });

  it("模型出错（限流等）不再悄无声息：对话里补一行回复失败", async () => {
    const hob = makeHob();
    try {
      const session = (await hob.runtime.router.ensure("hob")).session!;
      session.setAutoRetryEnabled(false);
      hob.faux.setResponses([
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: 'my-proxy API error (400): {"message":"request exceeds client API key limits","type":"rate_limit_error"}',
        }),
      ]);
      await hob.runtime.router.event("hob", "任务「查资料」已完成：结果在这里");
      await hob.runtime.router.waitIdle("hob");
      const notes = hob.runtime.router.items("hob").items.filter((item) => item.kind === "note");
      expect(notes.at(-1)).toMatchObject({ kind: "note", text: expect.stringMatching(/^回复失败：.+。发送任意消息即可重试。$/) });
    } finally {
      hob.close();
    }
  });

  it("单聊模型错误只显示失败说明，清除流式错误气泡", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage([fauxText("API Error: ECONNRESET")], { stopReason: "error", errorMessage: "ECONNRESET" })));
      const events: Item[] = [];
      const off = hob.runtime.bus.subscribe((event) => { if (event.type === "item" && event.assistantId === "hob") events.push(event.item); });
      await hob.runtime.router.event("hob", "任务结束");
      await hob.runtime.router.waitIdle("hob");
      off();
      const items = hob.runtime.router.items("hob").items;
      expect(items.some((item) => item.kind === "note" && item.text.includes("回复失败"))).toBe(true);
      expect(items.some((item) => item.kind === "assistant" && item.text.includes("ECONNRESET"))).toBe(false);
      expect(mergeItems([], events).some((item) => item.kind === "assistant" && item.text.includes("ECONNRESET"))).toBe(false);
    } finally { hob.close(); }
  });

  it("断流前已经写出来的正文照常留着，下面补一行回复失败", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([fauxAssistantMessage([fauxText("我先查一下订阅列表")], { stopReason: "aborted", errorMessage: "stream ended before a terminal response event" })]);
      await hob.runtime.router.event("hob", "任务结束");
      await hob.runtime.router.waitIdle("hob");
      const items = hob.runtime.router.items("hob").items;
      expect(items.some((item) => item.kind === "assistant" && item.text === "我先查一下订阅列表")).toBe(true);
      expect(items.some((item) => item.kind === "note" && item.text.includes("回复失败"))).toBe(true);
    } finally { hob.close(); }
  });

  it("briefModelError 压成一句", () => {
    expect(briefModelError(undefined)).toBe("模型服务出错");
    expect(briefModelError("socket hang up")).toBe("socket hang up");
    expect(briefModelError('my-proxy API error (429): {"message":"request exceeds client API key limits","type":"rate_limit_error"}')).toBe(
      "模型服务返回 429：request exceeds client API key limits",
    );
  });
});
