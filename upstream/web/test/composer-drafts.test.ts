import { afterEach, beforeEach, expect, it, vi } from "vitest";

let store: typeof import("../src/store.ts");
let api: typeof import("../src/api.ts").realApi;

beforeEach(async () => {
  vi.stubGlobal("location", { search: "", hash: "" });
  vi.stubGlobal("localStorage", { getItem: () => null });
  vi.stubGlobal("window", { innerWidth: 1440, matchMedia: () => ({ matches: false, addEventListener() {} }), setTimeout, clearTimeout });
  api = (await import("../src/api.ts")).realApi;
  const mock = (await import("../src/mock.ts")).createMock("s1");
  vi.spyOn(api, "items").mockImplementation(mock.items);
  vi.spyOn(api, "profile").mockImplementation(mock.profile);
  vi.spyOn(api, "groupItems").mockImplementation(mock.groupItems);
  const item = { kind: "user" as const, id: "m", at: "2026-01-01T00:00:00Z", text: "已发送" };
  vi.spyOn(api, "sendMessage").mockResolvedValue({ item });
  vi.spyOn(api, "sendGroupMessage").mockResolvedValue({ item: { ...item, speaker: "user" } });
  store = await import("../src/store.ts");
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.resetModules(); });

it("助手、同 id 的群和话题分别保留草稿和引用，发送只清当前草稿", async () => {
  const quote = { itemId: "quoted", text: "原话" };
  await store.select("hob");
  store.setText("给助手");
  store.setQuote(quote);
  await store.selectGroup("hob");
  await store.send();
  expect(api.sendGroupMessage).not.toHaveBeenCalled();
  store.setText("给群");
  await store.selectGroup("topic");
  store.setText("给话题");
  store.goHome();

  await store.selectGroup("hob");
  await store.send();
  expect(api.sendGroupMessage).toHaveBeenCalledWith("hob", { text: "给群" });
  await store.select("hob");
  await store.send();
  expect(api.sendMessage).toHaveBeenCalledWith("hob", { text: "给助手", quote });
  await store.selectGroup("topic");
  await store.send();
  expect(api.sendGroupMessage).toHaveBeenCalledWith("topic", { text: "给话题" });
  await store.selectGroup("hob");
  await store.send();
  expect(api.sendGroupMessage).toHaveBeenCalledTimes(2);
});

it("切走后才完成的上传留在原话题，另一对话只发送自己输入的文字", async () => {
  const upload = Promise.withResolvers<string>();
  vi.spyOn(api, "upload").mockReturnValue(upload.promise);
  const file = new File(["demo"], "notes.txt");
  await store.selectGroup("topic");
  store.attach([file]);
  await store.select("hob");
  store.setText("另一件事");
  const sending = store.send();
  upload.resolve("/topic/notes.txt");
  await sending;
  expect(api.sendMessage).toHaveBeenCalledWith("hob", { text: "另一件事" });

  await store.selectGroup("topic");
  expect(store.composerDraft(store.getState()).attachments).toMatchObject([{ status: "done", path: "/topic/notes.txt" }]);
  await store.send();
  expect(api.sendGroupMessage).toHaveBeenCalledWith("topic", { text: "", files: ["/topic/notes.txt"] });
  expect(api.upload).toHaveBeenCalledExactlyOnceWith(file, { groupId: "topic" });
});

it("从首页给主助手发消息时，只发送首页文字并保留主助手原来的草稿", async () => {
  const quote = { itemId: "m1", text: "稍后回复" };
  vi.spyOn(api, "upload").mockResolvedValue("/hob/draft.txt");
  await store.select("hob");
  store.setText("未写完");
  store.setQuote(quote);
  store.attach([new File(["draft"], "draft.txt")]);
  store.goHome();
  await store.select("hob");
  await store.send("来自首页");
  expect(api.sendMessage).toHaveBeenCalledWith("hob", { text: "来自首页" });
  await store.send();
  expect(api.sendMessage).toHaveBeenCalledWith("hob", { text: "未写完", quote, files: ["/hob/draft.txt"] });
});

it("切走后上传失败，回到原对话发送时用原文件重试", async () => {
  const upload = Promise.withResolvers<string>();
  vi.spyOn(api, "upload").mockReturnValueOnce(upload.promise).mockResolvedValueOnce("/hob/notes.txt");
  const file = new File(["notes"], "notes.txt");
  await store.select("hob");
  store.attach([file]);
  await store.select("page");
  upload.reject(new Error("offline"));
  await store.select("hob");
  expect(store.composerDraft(store.getState()).attachments).toMatchObject([{ status: "failed" }]);
  await store.send();
  expect(api.upload).toHaveBeenNthCalledWith(2, file, { assistantId: "hob" });
  expect(api.sendMessage).toHaveBeenCalledWith("hob", { text: "", files: ["/hob/notes.txt"] });
});

it("归档会话移除它的草稿，退出登录清理其余草稿", async () => {
  vi.spyOn(api, "logout").mockResolvedValue();
  await store.selectGroup("team");
  store.setText("群草稿");
  await store.select("hob");
  store.setText("助手草稿");
  store.applyEvent({ type: "group_removed", id: "team" });
  expect(store.composerDraft(store.getState()).text).toBe("助手草稿");
  await store.selectGroup("team");
  expect(store.composerDraft(store.getState()).text).toBe("");
  await store.logout();
  await store.select("hob");
  expect(store.composerDraft(store.getState()).text).toBe("");
});
