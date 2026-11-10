import { describe, expect, it } from "vitest";
import { createMock } from "../src/mock.ts";

describe("委派演示", () => {
  it("退回演示包含原因和互相定位的转来消息", async () => {
    const api = createMock("h-hob");
    const boot = await api.bootstrap();
    expect(boot.delegations).toContainEqual(expect.objectContaining({ status: "returned", reply: expect.stringContaining("代理配置") }));
    expect((await api.items("hob")).items).toContainEqual(expect.objectContaining({ kind: "user", from: expect.objectContaining({ assistantId: "server", delegationId: "hb-demo" }) }));
    expect((await api.items("server")).items).toContainEqual(expect.objectContaining({ kind: "note", handbackId: "hb-demo" }));
  });
  it("卡片和目标对话共用审批；答复后状态同步", async () => {
    const api = createMock("d-waiting");
    const boot = await api.bootstrap();
    expect(boot.delegations?.[0]).toMatchObject({ status: "waiting", to: "server" });
    const hob = await api.items("hob");
    const target = await api.items("server");
    expect(hob.items).toContainEqual(expect.objectContaining({ kind: "delegation", delegationId: "dg-demo" }));
    expect(target.items).toContainEqual(expect.objectContaining({ kind: "user", from: expect.objectContaining({ delegationId: "dg-demo" }) }));
    await api.answerApproval("ap-delegation", { key: "A" });
    expect((await api.items("hob")).approvals.find((approval) => approval.id === "ap-delegation")).toMatchObject({ status: "answered", chosen: "A" });
    expect((await api.items("server")).approvals.find((approval) => approval.id === "ap-delegation")).toMatchObject({ status: "answered", chosen: "A" });
    expect((await api.bootstrap()).delegations?.[0].status).toBe("running");
  });
});
