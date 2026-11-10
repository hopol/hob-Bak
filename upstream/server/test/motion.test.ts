import { describe, expect, it } from "vitest";
import { PROP_IDS, spriteArt, spriteEyes } from "../../shared/sprites.ts";
import type { CustomProp, HobEvent } from "../../shared/types.ts";
import { activityLabel, thinkingLine } from "../src/router-activity.ts";
import { fauxAssistantMessage, fauxText, fauxThinking } from "@earendil-works/pi-ai";
import { call, makeHob, text, waitFor } from "./helpers.ts";

const custom: CustomProp = { dx: 2, pal: { p: "#ff00ff" }, art: ["....pppppp......"] };

describe("火苗动画", () => {
  it("每个头像都能把眼睛拆出来单独动，拆完拼回去和静态图一样", () => {
    for (const id of [...PROP_IDS, "custom", "unknown"]) {
      const art = spriteArt(id, id === "custom" ? custom : undefined);
      const { body, eyes } = spriteEyes(art);
      expect(eyes).toHaveLength(4);
      expect(body.join("")).not.toContain("e");
      const back = body.map((row, y) => [...row].map((ch, x) => (eyes.some(([ex, ey]) => ex === x && ey === y) ? "e" : ch)).join(""));
      expect(back).toEqual(art.rows);
    }
  });

  it("工具标签有中文、参数和长度限制", () => {
    const names = ["start_job", "reply_job", "stop_job", "ask_user", "set_rule", "remove_rule", "create_routine", "update_routine", "delete_routine", "send_file", "set_avatar", "propose_assistant", "message_assistant", "hand_back_to_hob", "show_page", "web_search", "web_fetch", "memory_read", "memory_write", "lore_get_node", "lore_create_node", "read_skill", "generate_image", "overview"];
    for (const name of names) expect(activityLabel(name)).not.toBe("调用工具");
    expect(activityLabel("start_job", { title: "检查磁盘" })).toBe("派任务：检查磁盘");
    expect(activityLabel("message_assistant", { assistantId: "ops" }, () => "运维")).toBe("交给「运维」");
    expect([...activityLabel("web_search", { query: "火".repeat(60) })]).toHaveLength(24);
  });

  it("停止回复时清空活动", async () => {
    const hob = makeHob();
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hob.faux.setResponses([async () => { await gate; return text("已停止"); }]);
      await hob.runtime.router.send("hob", { text: "你好" });
      await waitFor(() => hob.runtime.router.bootstrap().assistants[0].activity?.state === "thinking");
      const stopping = hob.runtime.router.stop("hob");
      expect(hob.runtime.router.bootstrap().assistants[0].activity).toBeNull();
      release();
      await stopping;
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.router.bootstrap().assistants[0].activity).toBeNull();
    } finally { hob.close(); }
  });

  it("Worker 执行期间不发 Router 活动", async () => {
    const hob = makeHob();
    const events: HobEvent[] = [];
    hob.runtime.bus.subscribe((event) => events.push(event));
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hob.faux.setResponses([async () => { await gate; return call("report", { outcome: "done", result: "完成" }); }, text("好"), text("完成")]);
      await hob.runtime.jobs.start("hob", { title: "测试", instruction: "报告完成" });
      await waitFor(() => hob.faux.state.callCount > 0);
      expect(events.some((e) => e.type === "router-activity")).toBe(false);
      release();
      await hob.runtime.jobs.waitIdle();
      await hob.runtime.router.waitIdle("hob");
    } finally { hob.close(); }
  });

  it("模型出错时清空活动", async () => {
    const hob = makeHob();
    const events: HobEvent[] = [];
    hob.runtime.bus.subscribe((event) => events.push(event));
    try {
      hob.faux.setResponses([() => { throw new Error("模型不可用"); }]);
      await hob.runtime.router.send("hob", { text: "你好" });
      await hob.runtime.router.waitIdle("hob");
      const activity = events.filter((e) => e.type === "router-activity").map((e) => e.activity);
      expect(activity[0]?.state).toBe("thinking");
      expect(activity.at(-1)).toBeNull();
      expect(hob.runtime.router.bootstrap().assistants[0].activity).toBeNull();
    } finally { hob.close(); }
  });

  it("Router 推送思考、工具、文字清空，并可从概要恢复", async () => {
    const hob = makeHob();
    const events: HobEvent[] = [];
    hob.runtime.bus.subscribe((event) => events.push(event));
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hob.faux.setResponses([async () => { await gate; return call("set_rule", { text: "测试", mode: "ask" }); }, text("完成")]);
      await hob.runtime.router.send("hob", { text: "记下规矩" });
      await waitFor(() => hob.runtime.router.bootstrap().assistants[0].activity?.state === "thinking");
      release();
      await hob.runtime.router.waitIdle("hob");
      const activity = events.filter((e) => e.type === "router-activity").map((e) => e.activity);
      expect(activity[0]).toEqual({ state: "thinking", label: "正在想…" });
      expect(activity).toContainEqual({ state: "tool", label: "改规矩" });
      expect(activity.at(-1)).toBeNull();
      expect(hob.runtime.router.bootstrap().assistants[0].activity).toBeNull();
    } finally { hob.close(); }
  });

  it("思考中显示当前思考的最后一段，压成一行", () => {
    expect(thinkingLine("先看看用户要什么。\n\n**查一下** 最近的 `AI` 新闻")).toBe("查一下 最近的 AI 新闻");
    expect(thinkingLine("先想清楚预算和路线怎么排。\n\n写吧。")).toBe("先想清楚预算和路线怎么排。 写吧。");
    expect(thinkingLine("- 第一步\n- 第二步")).toBe("第一步 第二步");
    expect(thinkingLine("  \n ")).toBeUndefined();
    const long = thinkingLine(`${"前".repeat(150)}最新的想法`)!;
    expect([...long].length).toBe(110);
    expect(long.startsWith("…") && long.endsWith("最新的想法")).toBe(true);
  });

  it("模型流出思考时，状态行换成思考的最后一段，出字后清空", async () => {
    const hob = makeHob();
    const events: HobEvent[] = [];
    hob.runtime.bus.subscribe((event) => events.push(event));
    try {
      hob.faux.setResponses([fauxAssistantMessage([fauxThinking("用户想看天气。\n先确认是哪个城市"), fauxText("你在哪个城市？")])]);
      await hob.runtime.router.send("hob", { text: "今天天气怎么样" });
      await hob.runtime.router.waitIdle("hob");
      const labels = events.filter((e) => e.type === "router-activity").map((e) => e.activity?.label ?? null);
      expect(labels).toContain("用户想看天气。 先确认是哪个城市");
      expect(labels.at(-1)).toBeNull();
    } finally { hob.close(); }
  });

  it("头像底色：旧设置缺省为带圆底，关掉能存下", () => {
    const hob = makeHob();
    try {
      expect(hob.runtime.settings.settings.general.avatarBackground).toBe(true);
      const next = hob.runtime.settings.patch(hob.runtime.settings.get().revision, { general: { avatarBackground: false } });
      expect(next?.settings.general.avatarBackground).toBe(false);
    } finally { hob.close(); }
  });
});
