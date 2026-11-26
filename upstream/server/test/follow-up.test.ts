import { describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import type { GroupItem } from "../../shared/types.ts";
import { makeHob } from "./helpers.ts";
import { createApp } from "../src/http.ts";
async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
  const response = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test" }),
  });
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

import {
  FOLLOW_UP_SYSTEM_PROMPT,
  followUpContext,
  generateFollowUpSuggestions,
  groupHistory,
  groupLine,
  historyText,
  parseSuggestions,
  routerHistory,
  trimHistory,
} from "../src/follow-up.ts";

describe("follow-up suggestion history", () => {
  it("keeps router history stable and omits duplicate engine user messages and tool results", () => {
    const entries = [
      { type: "custom", customType: "hob.user", data: { text: "整理这份报告", files: ["u-a1b2c3-chart.png", "u-a1b2c3-notes.txt"] } },
      { type: "message", message: { role: "user", content: "整理这份报告" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "我先看一下。" }, { type: "toolCall", name: "read" }] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "不应出现" }] } },
    ] as const;
    const first = routerHistory(entries);
    const second = routerHistory(entries);
    expect(first).toEqual(second);
    expect(historyText(first)).toBe("用户：整理这份报告\n（图片）\n（文件：notes.txt）\n助手：我先看一下。\n（调用了 read）");
  });

  it("puts speaker names and file markers into group history", () => {
    const item = { kind: "assistant", id: "g-1", at: "", speaker: "ops", text: "清单已经列好。" } as GroupItem;
    const file = { kind: "file", id: "g-2", at: "", speaker: "ops", path: "/tmp/list.md", name: "list.md" } as GroupItem;
    expect(groupLine(item, (speaker) => speaker === "ops" ? "服务器" : "用户")).toBe("服务器：清单已经列好。");
    expect(groupHistory([item, file], (speaker) => speaker === "ops" ? "服务器" : "用户")).toEqual([
      { role: "user", text: "服务器：清单已经列好。" },
      { role: "user", text: "服务器：（调用了 send_file）" },
    ]);
  });

  it("drops the oldest half when the history is over half the model window", () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({ role: "user" as const, text: `${i}`.repeat(80) }));
    expect(trimHistory(turns, 40).map((turn) => turn.text[0])).toEqual(["3", "4", "5"]);
    expect(trimHistory(turns, 1).map((turn) => turn.text[0])).toEqual(["3", "4", "5"]);
  });
});

describe("follow-up suggestion output", () => {
  it("takes the first JSON array and applies the shared filters", () => {
    expect(parseSuggestions('说明 ["  看看结果 ", "看看结果", "", 3, "这是一段超过四十个字的推荐提问，它应该被代码过滤掉而不是显示给用户"]')).toEqual([]);
    // 按显示宽度限长：12 个汉字刚好能过，13 个不行；英文按字母算，五个词左右
    expect(parseSuggestions('["十二个汉字刚好能够放得下", "十三个汉字就已经是放不下了", "Send me the file", "Make a version I can send to my colleagues"]')).toEqual(["十二个汉字刚好能够放得下", "Send me the file"]);
    expect(parseSuggestions("没有数组")).toEqual([]);
    expect(parseSuggestions('["保留"] 之后还有文字')).toEqual(["保留"]);
  });

  it("calls the model without thinking and parses its response", async () => {
    const model = { api: "openai-completions", provider: "fake", id: "mini", contextWindow: 1000 } as Model<any>;
    const completeSimple = vi.fn(async (_model: Model<any>, context: { systemPrompt?: string }, options?: Record<string, unknown>) => {
      expect(context.systemPrompt).toBe(FOLLOW_UP_SYSTEM_PROMPT);
      expect(options?.reasoning).toBe("off");
      expect(options?.maxTokens).toBe(256);
      return fauxAssistantMessage([fauxText('["继续整理", "继续整理"]')]);
    });
    const stableContext = followUpContext(FOLLOW_UP_SYSTEM_PROMPT, [{ role: "user", text: "完成一份旅行计划" }], model);
    expect(stableContext.messages.at(-1)).toMatchObject({ role: "user", content: "上面是到目前为止的对话。给出用户接下来可能说的话，用用户最后那句话的语言写。用户最后说的是：「完成一份旅行计划」" });
    await expect(generateFollowUpSuggestions({ completeSimple }, model, [{ role: "user", text: "完成一份旅行计划" }])).resolves.toEqual(["继续整理"]);
    expect(completeSimple).toHaveBeenCalledOnce();
  });

  it("supports the three setting values", () => {
    const follow = makeHob({}, { followUpSuggestions: true });
    const off = makeHob();
    const explicit = makeHob({}, { settings: { models: { suggest: { ref: "hob-faux/faux-1", thinking: "high" } } } });
    try {
      expect(follow.runtime.settings.settings.models.suggest).toBeUndefined();
      expect(off.runtime.settings.settings.models.suggest).toBeNull();
      expect(explicit.runtime.settings.settings.models.suggest).toEqual({ ref: "hob-faux/faux-1", thinking: "high" });
    } finally {
      follow.close();
      off.close();
      explicit.close();
    }
  });

  it("rejects an unavailable selected model", async () => {
    const hob = makeHob();
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const cookie = await signIn(app);
      const response = await app.request("/api/settings", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          revision: hob.runtime.settings.get().revision,
          patch: { models: { suggest: { ref: "gone/model", thinking: "off" } } },
        }),
      });
      expect(response.status).toBe(400);
    } finally {
      hob.close();
    }
  });
});
