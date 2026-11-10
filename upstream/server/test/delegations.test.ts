import { describe, expect, it, vi } from "vitest";
import type { Delegation, Job } from "../../shared/types.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { answerApproval } from "../src/actions.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

function setup() {
  const hob = makeHob();
  const primary = hob.runtime.store.assistant("hob")!;
  hob.runtime.store.saveAssistant({ ...primary, id: "ops", name: "服务器", primary: false });
  return hob;
}

function record(): Delegation {
  return { id: "dg-test", from: "hob", to: "ops", text: "检查", status: "running", createdAt: new Date().toISOString(), jobIds: [] };
}

function job(id: string, status: Job["status"]): Job {
  return { id, assistantId: "ops", title: id, instruction: "检查", status, createdAt: new Date().toISOString(), stats: { reads: 0, commands: 0, edits: 0 }, activity: [], delegationId: "dg-test" };
}

describe("交回 Hob", () => {
  it("只有非主助手有工具；普通回合写入双向定位条目并触发 Hob", async () => {
    const hob = setup();
    try {
      expect(buildRouterTools(hob.runtime, "hob").some((tool) => tool.name === "hand_back_to_hob")).toBe(false);
      const tool = buildRouterTools(hob.runtime, "ops").find((item) => item.name === "hand_back_to_hob")!;
      expect(tool).toBeDefined();
      hob.faux.setResponses([text("我来处理代理问题")]);
      const result = await tool.execute("call", { text: "检查代理", reason: "不负责代理" }) as { terminate?: boolean };
      expect(result.terminate).toBe(true);
      const forwarded = hob.runtime.router.items("hob").items.find((item) => item.kind === "user" && item.from?.assistantId === "ops");
      expect(forwarded).toMatchObject({ text: "检查代理", from: { assistantId: "ops", name: "服务器" } });
      const id = forwarded?.kind === "user" ? forwarded.from!.delegationId : "";
      expect(hob.runtime.router.items("ops").items).toContainEqual(expect.objectContaining({ kind: "note", text: "已交回 Hob：不负责代理", handbackId: id }));
      await waitFor(() => hob.faux.state.callCount > 0);
      await hob.runtime.router.waitIdle("hob");
    } finally { hob.close(); }
  });

  it("转交回合退回只回流一次，不额外创建转来消息", async () => {
    const hob = setup();
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("hand_back_to_hob", { text: "检查代理", reason: "不负责代理" })]);
      const delegation = await hob.runtime.delegations.start("ops", "检查代理");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      await hob.runtime.router.waitIdle("ops");
      expect(hob.runtime.store.delegation(delegation.id)).toMatchObject({ status: "returned", reply: "退回：不负责代理" });
      expect(event).toHaveBeenCalledTimes(1);
      expect(event.mock.calls[0][1]).toContain("「服务器」已退回过一次。");
      expect(event.mock.calls[0][1]).not.toContain("别再转给它");
      expect(hob.runtime.router.items("hob").items.filter((item) => item.kind === "user")).toHaveLength(0);
      hob.runtime.delegations.update(delegation.id);
      expect(event).toHaveBeenCalledTimes(1);
    } finally { hob.close(); }
  });
});

describe("委派", () => {
  it("转交结束发给 Hob 的汇总里没有沉淀提醒，那些任务归转交对象", () => {
    const hob = setup();
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.runtime.store.saveJob({ ...job("t-dg", "done"), summary: "检查完，服务都正常" });
      hob.runtime.store.saveDelegation({ ...record(), turnFinished: true, jobIds: ["t-dg"] });
      hob.runtime.delegations.update("dg-test");
      const text = String(event.mock.calls[0]![1]);
      expect(text).toContain("检查完，服务都正常");
      expect(text).not.toContain("这个任务没带技能");
    } finally { hob.close(); }
  });
  it("目标助手提问后用户直接发消息：先接手，再结束 Router 审批，任务审批不变", async () => {
    const hob = setup();
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("ask_user", { title: "允许吗", options: [{ label: "允许" }, { label: "拒绝" }] })]);
      const delegation = await hob.runtime.delegations.start("ops", "请执行");
      await waitFor(() => hob.runtime.store.delegation(delegation.id)?.status === "waiting");
      const approval = hob.runtime.store.approvals()[0];
      const jobApproval = { ...approval, id: "job-question", source: "job" as const, jobId: "job-1" };
      hob.runtime.store.saveApproval(jobApproval);
      const changes: string[] = [];
      hob.runtime.bus.subscribe((entry) => {
        if (entry.type === "delegation" && entry.delegation.id === delegation.id) changes.push(entry.delegation.status);
        if (entry.type === "approval" && entry.approval.id === approval.id) changes.push(entry.approval.status);
      });
      hob.faux.setResponses([text("收到")]);
      await hob.runtime.router.send("ops", { text: "我自己来" });
      await hob.runtime.router.waitIdle("ops");
      expect(changes.slice(0, 2)).toEqual(["takenOver", "expired"]);
      expect(hob.runtime.store.delegation(delegation.id)).toMatchObject({ status: "takenOver", endedAt: expect.any(String), reportedAt: expect.any(String) });
      expect(hob.runtime.store.approval(approval.id)?.status).toBe("expired");
      expect(hob.runtime.store.approval(jobApproval.id)?.status).toBe("pending");
      expect(event).toHaveBeenCalledTimes(1);
      expect(event).toHaveBeenCalledWith("hob", "转交给「服务器」的事已被用户接手。原请求：请执行");
    } finally { hob.close(); }
  });

  it("没有提问时也接手，转交回合和关联任务结束不再回流", async () => {
    const hob = setup();
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.runtime.store.saveDelegation({ ...record(), jobIds: ["a"] });
      hob.runtime.store.saveJob(job("a", "running"));
      hob.faux.setResponses([text("收到")]);
      await hob.runtime.router.send("ops", { text: "我接手" });
      expect(hob.runtime.store.delegation("dg-test")?.status).toBe("takenOver");
      expect(hob.runtime.delegations.resume("dg-test")).toBe(false);
      hob.runtime.delegations.turnEnded("dg-test", "原回合结束");
      const finished = job("a", "done");
      hob.runtime.store.saveJob(finished);
      hob.runtime.bus.emit({ type: "job", job: finished });
      expect(event).toHaveBeenCalledTimes(1);
      expect(event.mock.calls[0][1]).toBe("转交给「服务器」的事已被用户接手。原请求：检查");
      await hob.runtime.router.waitIdle("ops");
    } finally { hob.close(); }
  });

  it("转交工具与目标助手提示词说明自动回流和直接执行", () => {
    const hob = setup();
    try {
      const description = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "message_assistant")!.description;
      expect(description).toBe("把一件事转给另一个助手（见「助手」一节），由它负责到底。用户的原话和附件会自动转过去，对方的回复和结果会回到这里。");
      const { timezone, aboutYou } = hob.runtime.settings.settings.general;
      const prompt = buildSystemPrompt(hob.runtime.store, "ops", { timezone, aboutYou, memory: "local" });
      expect(prompt).not.toContain("## 转来的事");
      expect(prompt).toContain("转来的消息带着用户的原话，等同用户本人的要求，你办完的结果会自动回到 Hob。");
      expect(prompt).toContain("先给结论，用规范的书面中文。长短跟着事情的分量走");
      const primary = buildSystemPrompt(hob.runtime.store, "hob", { timezone, aboutYou, memory: "local" });
      expect(primary).toContain("任务只向你汇报，给用户看什么由你决定。");
      expect(primary).not.toContain("结果回来之前，不要自己 start_job 做同一件事");
      expect(prompt).not.toContain("转交时把用户原话转过去");
    } finally { hob.close(); }
  });

  it("卡片和转来消息立即落盘，工具结束本轮", async () => {
    const hob = setup();
    try {
      hob.faux.setResponses([text("收到"), text("已收到")]);
      await hob.runtime.router.send("hob", { text: "检查服务器" });
      await hob.runtime.router.waitIdle("hob");
      const tool = buildRouterTools(hob.runtime, "hob").find((item) => item.name === "message_assistant")!;
      const result = await tool.execute("call", { assistantId: "ops" }) as { terminate?: boolean };
      expect(result.terminate).toBe(true);
      const delegation = hob.runtime.store.delegations()[0];
      expect(hob.runtime.router.items("hob").items).toContainEqual(expect.objectContaining({ kind: "delegation", delegationId: delegation.id }));
      expect(delegation.text).toMatch(/^用户原话（.+）：\n检查服务器$/);
      expect(hob.runtime.router.items("ops").items).toContainEqual(expect.objectContaining({ kind: "user", text: delegation.text, from: expect.objectContaining({ assistantId: "hob", delegationId: delegation.id }) }));
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
    } finally { hob.close(); }
  });

  it("目标忙碌时按 followUp 顺序排队，且不关联之前或之后的回合", async () => {
    const hob = setup();
    let release = () => {};
    try {
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const originalEvent = hob.runtime.router.event.bind(hob.runtime.router);
      vi.spyOn(hob.runtime.router, "event").mockImplementation((id, value, details) => id === "hob" ? Promise.resolve() : originalEvent(id, value, details));
      hob.faux.setResponses([async () => { await gate; return text("之前的回复"); }, text("转交的回复"), text("后续的回复")]);
      await hob.runtime.router.send("ops", { text: "之前的工作" });
      await waitFor(() => hob.faux.state.callCount >= 1);
      const delegation = await hob.runtime.delegations.start("ops", "排队请求");
      expect(hob.runtime.router.items("ops").items).toContainEqual(expect.objectContaining({ kind: "user", text: "排队请求" }));
      expect(hob.runtime.router.currentDelegation("ops")).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await hob.runtime.router.event("ops", "后续事件");
      release();
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.turnFinished));
      await hob.runtime.router.waitIdle("ops");
      expect(hob.runtime.store.delegation(delegation.id)?.reply).toBe("转交的回复");
      expect(hob.runtime.router.currentDelegation("ops")).toBeUndefined();
      const replies = hob.runtime.router.items("ops").items.filter((item) => item.kind === "assistant").map((item) => item.kind === "assistant" ? item.text : "");
      expect(replies).toEqual(["之前的回复", "转交的回复", "后续的回复"]);
    } finally { release(); hob.close(); }
  });

  it("转交回合的 Router 审批保持等待并引用同一个问题", async () => {
    const hob = setup();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([call("ask_user", { title: "允许吗", options: [{ label: "允许" }, { label: "拒绝" }] })]);
      const delegation = await hob.runtime.delegations.start("ops", "请执行");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.turnFinished));
      const approval = hob.runtime.store.approvals()[0];
      expect(hob.runtime.store.delegation(delegation.id)).toMatchObject({ status: "waiting", approvalIds: [approval.id] });
      expect(hob.runtime.router.items("hob").approvals.map((item) => item.id)).toContain(approval.id);
      expect(hob.runtime.router.items("ops").items).toContainEqual(expect.objectContaining({ kind: "question", approvalId: approval.id }));
    } finally { hob.close(); }
  });

  it("转交回合创建的任务记住委派", async () => {
    const hob = setup();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([
        call("start_job", { title: "检查磁盘", instruction: "检查磁盘" }),
        call("report", { outcome: "done", result: "磁盘正常" }),
      ]);
      const delegation = await hob.runtime.delegations.start("ops", "检查磁盘");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.jobIds.length));
      const saved = hob.runtime.store.delegation(delegation.id)!;
      expect(hob.runtime.store.job(saved.jobIds[0])?.delegationId).toBe(delegation.id);
      await hob.runtime.jobs.waitIdle(10_000);
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.turnFinished));
    } finally { hob.close(); }
  });

  it("转交中的普通工具不会提前结束关联", async () => {
    const hob = setup();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([
        call("set_rule", { text: "记录操作", mode: "allow" }),
        call("start_job", { title: "检查日志", instruction: "检查日志" }),
        call("report", { outcome: "done", result: "检查完毕" }),
      ]);
      const delegation = await hob.runtime.delegations.start("ops", "先记录规则，再检查日志");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.turnFinished));
      const saved = hob.runtime.store.delegation(delegation.id)!;
      expect(saved.jobIds).toHaveLength(1);
      expect(hob.runtime.store.job(saved.jobIds[0])?.delegationId).toBe(delegation.id);
      await hob.runtime.jobs.waitIdle(10_000);
    } finally { hob.close(); }
  });

  it("任务结束后目标助手接着派的任务也算这次转交，全部办完才回流 Hob 一次", async () => {
    const hob = setup();
    try {
      const originalEvent = hob.runtime.router.event.bind(hob.runtime.router);
      const event = vi.spyOn(hob.runtime.router, "event").mockImplementation((id, value, details) => id === "hob" ? Promise.resolve() : originalEvent(id, value, details));
      hob.faux.setResponses([
        call("start_job", { title: "先查配置", instruction: "查配置" }),
        call("report", { outcome: "stuck", result: "后台入口还能绕过" }),
        text("报告了"),
        // 任务结果回到目标助手：它接着再派一个，这时 Hob 不能收到「已结束」
        () => {
          expect(event.mock.calls.filter(([id]) => id === "hob")).toHaveLength(0);
          return call("start_job", { title: "封后台入口", instruction: "修后台入口" });
        },
        call("report", { outcome: "done", result: "后台入口已封" }),
        text("报告了"),
        text("两处都改好了"),
      ]);
      const delegation = await hob.runtime.delegations.start("ops", "关掉主动语音");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      await hob.runtime.router.waitIdle("ops");
      const saved = hob.runtime.store.delegation(delegation.id)!;
      expect(saved.jobIds).toHaveLength(2);
      expect(saved.jobIds.map((id) => hob.runtime.store.job(id)?.delegationId)).toEqual([delegation.id, delegation.id]);
      expect(saved).toMatchObject({ status: "stuck", reply: "两处都改好了" });
      const toHob = event.mock.calls.filter(([id]) => id === "hob");
      expect(toHob).toHaveLength(1);
      expect(toHob[0][1]).toContain("两处都改好了");
      expect(toHob[0][1]).toContain("后台入口已封");
    } finally { hob.close(); }
  });

  it("用户答了转交里的提问：目标助手接着办完才回流", async () => {
    const hob = setup();
    try {
      const originalEvent = hob.runtime.router.event.bind(hob.runtime.router);
      const event = vi.spyOn(hob.runtime.router, "event").mockImplementation((id, value, details) => id === "hob" ? Promise.resolve() : originalEvent(id, value, details));
      hob.faux.setResponses([
        call("ask_user", { title: "允许重载吗", options: [{ label: "允许" }, { label: "不允许" }] }),
        call("start_job", { title: "重载插件", instruction: "重载" }),
        call("report", { outcome: "done", result: "已重载" }),
        text("报告了"),
        text("重载好了"),
      ]);
      const delegation = await hob.runtime.delegations.start("ops", "改完上线");
      await waitFor(() => hob.runtime.store.delegation(delegation.id)?.status === "waiting");
      const approval = hob.runtime.store.approvals()[0];
      expect((await answerApproval(hob.runtime, approval.id, { key: "A" })).status).toBe(200);
      expect(hob.runtime.store.delegation(delegation.id)?.reportedAt).toBeUndefined();
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.reportedAt));
      await hob.runtime.router.waitIdle("ops");
      expect(hob.runtime.store.delegation(delegation.id)).toMatchObject({ status: "done", jobIds: [expect.any(String)] });
      const toHob = event.mock.calls.filter(([id]) => id === "hob");
      expect(toHob).toHaveLength(1);
      expect(toHob[0][1]).toContain("重载好了");
    } finally { hob.close(); }
  });

  it("目标模型报错时委派受阻而非假报成功", async () => {
    const hob = setup();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.faux.setResponses([() => { throw new Error("模型不可用"); }]);
      const delegation = await hob.runtime.delegations.start("ops", "处理请求");
      await waitFor(() => Boolean(hob.runtime.store.delegation(delegation.id)?.turnFinished));
      expect(hob.runtime.store.delegation(delegation.id)).toMatchObject({ status: "stuck", turnFailed: true, reply: expect.stringContaining("模型不可用") });
    } finally { hob.close(); }
  });

  it.each(["turn-first", "jobs-first"]) ("%s：两个任务均结束后只回流一次", async (order) => {
    const hob = setup();
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.runtime.store.saveDelegation({ ...record(), jobIds: ["a", "b"] });
      hob.runtime.store.saveJob(job("a", "running"));
      hob.runtime.store.saveJob(job("b", "running"));
      if (order === "turn-first") hob.runtime.delegations.turnEnded("dg-test", "正在处理");
      expect(event).not.toHaveBeenCalled();
      for (const id of ["a", "b"]) {
        const reportPath = hob.runtime.store.writeReport(id, `报告 ${id}\n完整报告细节${id === "b" ? "x".repeat(6100) : ""}`);
        const finished = { ...job(id, "done"), summary: `结果 ${id}${id === "b" ? "x".repeat(3100) : ""}`, reportPath };
        hob.runtime.store.saveJob(finished);
        hob.runtime.bus.emit({ type: "job", job: finished });
      }
      if (order === "jobs-first") { expect(event).not.toHaveBeenCalled(); hob.runtime.delegations.turnEnded("dg-test", "收到"); }
      hob.runtime.delegations.update("dg-test");
      expect(event).toHaveBeenCalledTimes(1);
      expect(event.mock.calls[0][1]).toContain("结果：\n结果 a");
      expect(event.mock.calls[0][1]).toContain("共 3104 字，以下是前 3,000 字；全文：");
      expect(event.mock.calls[0][1]).toContain(hob.runtime.store.job("b")!.reportPath!);
      expect(event.mock.calls[0][1]).not.toContain("完整报告细节");
      expect(hob.runtime.store.delegation("dg-test")).toMatchObject({ status: "done", reportedAt: expect.any(String) });
    } finally { hob.close(); }
  });

  it("审批等待和答复共用同一条记录", () => {
    const hob = setup();
    try {
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.runtime.store.saveDelegation({ ...record(), jobIds: ["a"] });
      hob.runtime.store.saveJob(job("a", "waiting"));
      const approval = { id: "q", assistantId: "ops", title: "继续吗", options: [], status: "pending" as const, source: "job" as const, jobId: "a", createdAt: new Date().toISOString() };
      hob.runtime.store.saveApproval(approval);
      hob.runtime.bus.emit({ type: "approval", approval });
      expect(hob.runtime.store.delegation("dg-test")?.status).toBe("waiting");
      hob.runtime.store.saveApproval({ ...approval, status: "answered" });
      hob.runtime.bus.emit({ type: "approval", approval: { ...approval, status: "answered" } });
      expect(hob.runtime.store.delegation("dg-test")?.status).toBe("waiting");
      const resumed = job("a", "running");
      hob.runtime.store.saveJob(resumed);
      hob.runtime.bus.emit({ type: "job", job: resumed });
      expect(hob.runtime.store.delegation("dg-test")?.status).toBe("running");
    } finally { hob.close(); }
  });

  it("转交任务的提问交回目标助手，不生成用户问题卡", async () => {
    const hob = setup();
    let release = () => {};
    try {
      const relay = vi.spyOn(hob.runtime.router, "relay").mockResolvedValue();
      vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      const gate = new Promise<void>((resolve) => { release = resolve; });
      hob.faux.setResponses([async () => { await gate; return call("report", { outcome: "done", result: "完成" }); }, text("完成")]);
      hob.runtime.store.saveDelegation(record());
      const started = await hob.runtime.jobs.start("ops", { title: "检查", instruction: "检查", delegationId: "dg-test" });
      hob.runtime.delegations.addJob("dg-test", started.id);
      await waitFor(() => hob.faux.state.callCount > 0);
      const answer = hob.runtime.jobs.askQuestion(started.id, { title: "继续吗", options: [{ key: "A", label: "继续" }, { key: "B", label: "停止" }] });
      expect(relay).toHaveBeenCalledWith("ops", `任务「检查」（${started.id}）在等你回复：继续吗。选项：A 继续、B 停止。`, "dg-test");
      expect(hob.runtime.store.delegation("dg-test")?.status).toBe("waiting");
      expect(hob.runtime.router.items("ops").items.some((item) => item.kind === "question")).toBe(false);
      await hob.runtime.jobs.reply(started.id, "继续", "router");
      expect(await answer).toBe("「服务器」回复：继续");
    } finally { release(); hob.close(); }
  });

  it("恢复时中断未运行的记录，不中断仍在运行的任务", () => {
    const hob = setup();
    try {
      const event = vi.spyOn(hob.runtime.router, "event").mockResolvedValue();
      hob.runtime.store.saveDelegation(record());
      hob.runtime.store.saveDelegation({ ...record(), id: "dg-active", jobIds: ["active"] });
      hob.runtime.store.saveJob(job("active", "running"));
      // 在等用户选的：审批卡重启后还在，不算中断
      hob.runtime.store.saveApproval({ id: "q-wait", assistantId: "ops", title: "允许吗", options: [], status: "pending", source: "router", createdAt: new Date().toISOString() });
      hob.runtime.store.saveDelegation({ ...record(), id: "dg-asking", status: "waiting", turnFinished: true, approvalIds: ["q-wait"] });
      hob.runtime.delegations.recover();
      expect(hob.runtime.store.delegation("dg-test")?.status).toBe("interrupted");
      expect(hob.runtime.store.delegation("dg-active")?.status).toBe("running");
      expect(hob.runtime.store.delegation("dg-asking")?.status).toBe("waiting");
      expect(event).toHaveBeenCalledTimes(1);
      expect(event.mock.calls[0][1]).toContain("因服务重启中断");
    } finally { hob.close(); }
  });
});
