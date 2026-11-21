import { describe, expect, it, afterEach } from "vitest";
import { setLocale } from "../../shared/i18n.ts";
import type { Approval } from "../../shared/types.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { activityLabel } from "../src/router-activity.ts";
import { pushApproval, type PushPayload } from "../src/push.ts";
import { createApp } from "../src/http.ts";
import { makeHob, call, text } from "./helpers.ts";

afterEach(() => setLocale("zh-CN"));

describe("server user-facing translations", () => {
  it("translates an HTTP error when the interface language is English", async () => {
    const hob = makeHob({}, { settings: { general: { locale: "en" } } });
    try {
      const response = await createApp(hob.runtime, { home: hob.home }).request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong" }),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Incorrect password." });
    } finally {
      hob.close();
    }
  });

  it("returns a provider error in English", async () => {
    const hob = makeHob({}, { settings: { general: { locale: "en" } } });
    try {
      const app = createApp(hob.runtime, { home: hob.home });
      const login = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "test" }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
      const response = await app.request("/api/providers/my-proxy", {
        method: "PUT",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ kind: "custom", name: "My proxy", api: "openai-completions", baseUrl: "https://proxy.example/v1", models: [] }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "A compatible endpoint needs at least one model." });
    } finally {
      hob.close();
    }
  });

  it("translates an activity label", () => {
    const hob = makeHob({}, { settings: { general: { locale: "en" } } });
    try {
      expect(activityLabel("start_job", { title: "Check" })).toBe("Assigning job: Check");
    } finally {
      hob.close();
    }
  });

  it("writes a translated group note", () => {
    const hob = makeHob({}, { settings: { general: { locale: "en" } } });
    try {
      const group = hob.runtime.groups.create({ name: "Ops", purpose: "Operations", ownerId: "hob", members: ["hob"] });
      expect(hob.runtime.store.groupItems(group.id).at(-1)).toMatchObject({ kind: "note", text: "Created group “Ops”" });
    } finally {
      hob.close();
    }
  });

  it("writes a translated schedule note", async () => {
    const hob = makeHob({}, { settings: { general: { locale: "en" } } });
    try {
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "create_routine")!;
      await tool.execute("call", { name: "Daily check", instruction: "Check status", schedules: ["2099-01-01T09:00"] });
      const note = hob.runtime.router.items("hob").items.find((item) => item.kind === "note" && item.icon === "routine");
      expect(note?.text).toMatch(/^Added schedule · Daily check · /);
    } finally {
      hob.close();
    }
  });

  it("translates the note left for a tool call that did not go through", async () => {
    const hob = makeHob({}, { settings: { general: { locale: "en" } }, memory: "off" });
    try {
      hob.faux.setResponses([call("start_job", { title: "Check disk", note: "" }), text("Let me fix that.")]);
      await hob.runtime.router.send("hob", { text: "Check the disk" });
      await hob.runtime.router.waitIdle("hob");
      const note = hob.runtime.router.items("hob").items.find((item) => item.kind === "note" && item.text.includes("failed"));
      expect(note).toMatchObject({ kind: "note", text: "“创建任务” failed" });
    } finally { hob.close(); }
  });

  it("translates push notification text", async () => {
    const sent: PushPayload[] = [];
    const hob = makeHob({}, { settings: { general: { locale: "en" } } });
    try {
      const approval: Approval = {
        id: "q-en",
        assistantId: "hob",
        title: "Publish it?",
        options: [],
        status: "pending",
        source: "router",
        createdAt: new Date().toISOString(),
      };
      pushApproval({ push: { send: async (payload) => { sent.push(payload); return { sent: 1, removed: 0 }; } }, store: hob.runtime.store }, approval);
      await new Promise((resolve) => setImmediate(resolve));
      expect(sent[0]).toMatchObject({ title: "Publish it?", body: "Hob · Waiting for your answer" });
    } finally {
      hob.close();
    }
  });
});
