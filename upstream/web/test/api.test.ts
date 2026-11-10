import { afterEach, describe, expect, it, vi } from "vitest";
import { realApi } from "../src/api.ts";

afterEach(() => vi.unstubAllGlobals());

describe("上传文件", () => {
  it("读取服务端返回的文件路径，并带上当前助手", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      files: ["/tmp/hob/assistants/hob/files/uploads/u-test.txt"],
      file: { path: "/tmp/hob/assistants/hob/files/uploads/u-test.txt", name: "test.txt" },
    })));
    vi.stubGlobal("fetch", fetch);

    await expect(realApi.upload(new File(["test"], "test.txt"), "hob")).resolves.toBe("/tmp/hob/assistants/hob/files/uploads/u-test.txt");
    expect(fetch).toHaveBeenCalledWith("/api/uploads?assistantId=hob", expect.objectContaining({ method: "POST" }));
  });

  it("响应没有路径时报告错误", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")));
    await expect(realApi.upload(new File(["test"], "test.txt"), "hob")).rejects.toThrow("上传响应缺少文件路径");
  });
});

describe("推送订阅", () => {
  it("订阅后取服务端回的 push 视图（曾经整包当视图用，设置页白屏）", async () => {
    const push = { publicKey: "k", email: "", devices: [{ endpoint: "e", label: "iPhone", createdAt: "2026-11-02T00:00:00Z" }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ device: push.devices[0], push }))));
    await expect(realApi.subscribePush({ endpoint: "e", keys: { p256dh: "p", auth: "a" } }, "iPhone")).resolves.toEqual(push);
  });
});
