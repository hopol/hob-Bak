import { describe, expect, it, vi } from "vitest";
import { buildRouterTools } from "../src/router-tools.ts";
import { call, makeHob, text, waitFor } from "./helpers.ts";

const pick = (id: string) => ({ ref: `hob-faux/${id}`, thinking: "off" });
const setup = (tokensPerSecond = 200_000) => {
  const models = [{ id: "fast", input: ["text"] as ("text" | "image")[] }, { id: "smart", input: ["text"] as ("text" | "image")[] }, { id: "eyes", input: ["text", "image"] as ("text" | "image")[] }];
  const hob = makeHob({}, { memory: "off", tokensPerSecond, models, settings: { models: { roster: models.map(({ id }) => ({ ref: `hob-faux/${id}`, note: "" })) }, work: { maxJobs: 1 } } });
  const group = hob.runtime.groups.create({ name: "甲", purpose: "测试", ownerId: "hob", members: ["hob"], workflow: "software" });
  return { hob, group };
};

const response = (content: string, seen: string[]) => (_context: unknown, _options: unknown, _state: unknown, model: { id: string }) => {
  seen.push(model.id);
  return { role: "assistant", content: [{ type: "text", text: content }], stopReason: "stop" } as never;
};

describe("群成员模型回归", () => {
  it("正在回复时改模型不打断，下一轮使用新模型", async () => {
    const { hob, group } = setup(40);
    try {
      const seen: string[] = [];
      const first = "正在完成原来的回复。".repeat(6);
      hob.faux.setResponses([response(first, seen), response("第二轮完成", seen)]);
      await hob.runtime.groups.send(group.id, { text: "开始" });
      await waitFor(() => seen.length === 1 && hob.runtime.router.isBusy("hob", group.id));
      await hob.runtime.groups.updateMemberModels(group.id, "hob", { conversation: pick("smart") });
      expect(hob.runtime.router.isBusy("hob", group.id)).toBe(true);
      await waitFor(() => hob.runtime.groups.items(group.id).items.some((item) => item.kind === "assistant" && !item.streaming && item.text === first));
      await hob.runtime.router.waitIdle("hob", 15_000, group.id);
      await hob.runtime.groups.send(group.id, { text: "下一轮" });
      await waitFor(() => hob.runtime.groups.items(group.id).items.some((item) => item.kind === "assistant" && !item.streaming && item.text === "第二轮完成"));
      expect(seen).toEqual(["fast", "smart"]);
    } finally { hob.close(); }
  }, 20_000);

  it("事项子任务按所属群的任务默认模型自动创建", async () => {
    const { hob, group } = setup();
    try {
      vi.spyOn(hob.runtime.jobs, "pump").mockImplementation(() => {});
      await hob.runtime.groups.updateMemberModels(group.id, "hob", { work: pick("smart") });
      const project = hob.runtime.projects.open({ group, ownerId: "hob", title: "测试事项" });
      hob.runtime.projects.writeRequirements(group.id, project.id, { content: "实现", acceptance: ["通过"] });
      hob.runtime.projects.plan(group.id, project.id, [{ title: "执行", assignee: "hob", brief: "做" }]);
      hob.runtime.projects.start(group.id, project.id);
      await waitFor(() => Boolean(hob.runtime.store.jobs().find((entry) => entry.project?.id === project.id)));
      const job = hob.runtime.store.jobs().find((entry) => entry.project?.id === project.id)!;
      expect(job).toMatchObject({ assistantId: "hob", groupId: group.id, project: { id: project.id, n: 1 }, model: "hob-faux/smart" });
    } finally { hob.close(); }
  });

  it("排队、运行和续做保留开任务时的模型", async () => {
    const { hob, group } = setup(80);
    try {
      vi.spyOn(hob.runtime.groups, "deliverEvent").mockResolvedValue();
      const workerModels: string[] = [];
      const open = hob.runtime.pi.open.bind(hob.runtime.pi);
      vi.spyOn(hob.runtime.pi, "open").mockImplementation(async (options) => {
        if (options.file.endsWith("worker.jsonl")) workerModels.push(options.model);
        return open(options);
      });
      const seen: string[] = [];
      hob.faux.setResponses([response("正在执行".repeat(20), seen), call("report", { outcome: "done", result: "完成" }), text("完成"), call("report", { outcome: "done", result: "完成" }), text("完成")]);
      await hob.runtime.groups.updateMemberModels(group.id, "hob", { work: pick("smart") });
      const running = await hob.runtime.jobs.start("hob", { title: "运行", instruction: "测试", groupId: group.id });
      await waitFor(() => seen.length > 0 && hob.runtime.store.job(running.id)?.status === "running");
      const queued = await hob.runtime.jobs.start("hob", { title: "排队", instruction: "测试", groupId: group.id });
      expect(hob.runtime.store.job(queued.id)?.status).toBe("queued");
      await hob.runtime.groups.updateMemberModels(group.id, "hob", { work: pick("eyes") });
      expect(hob.runtime.store.job(running.id)?.model).toBe("hob-faux/smart");
      expect(hob.runtime.store.job(queued.id)?.model).toBe("hob-faux/smart");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(running.id)?.status).toBe("done");
      expect(hob.runtime.store.job(queued.id)?.model).toBe("hob-faux/smart");
      hob.faux.setResponses([response("续做中", seen), call("report", { outcome: "done", result: "续做完成" }), text("完成")]);
      await hob.runtime.jobs.reply(running.id, "接着做", "router");
      await hob.runtime.jobs.waitIdle();
      expect(hob.runtime.store.job(running.id)?.model).toBe("hob-faux/smart");
      expect(seen).toEqual(["smart", "smart"]);
      expect(workerModels).toEqual(["hob-faux/smart", "hob-faux/smart", "hob-faux/smart"]);
    } finally { hob.close(); }
  }, 30_000);

  it("start_job 的模型说明和实际开出的任务用同一个默认模型，并随本群设置更新", async () => {
    const { hob, group } = setup();
    try {
      vi.spyOn(hob.runtime.jobs, "pump").mockImplementation(() => {});
      const opened: { customTools: any[] }[] = [];
      const open = hob.runtime.pi.open.bind(hob.runtime.pi);
      vi.spyOn(hob.runtime.pi, "open").mockImplementation(async (options) => { opened.push(options as any); return open(options); });
      for (const model of ["smart", "eyes"]) {
        await hob.runtime.groups.updateMemberModels(group.id, "hob", { work: pick(model) });
        await hob.runtime.router.ensure("hob", group.id);
        const start = opened.at(-1)!.customTools.find((tool) => tool.name === "start_job")!;
        expect(start.parameters.properties.model.description).toContain(`hob-faux/${model}（默认）`);
        const result = await start.execute("test", { title: `任务${model}` });
        expect(result.isError).not.toBe(true);
        expect(hob.runtime.store.jobs().find((job) => job.title === `任务${model}`)?.model).toBe(`hob-faux/${model}`);
      }
      expect(opened).toHaveLength(2);
    } finally { hob.close(); }
  });

  it("不同群共享桌面但截图按各自会话的模型判断", async () => {
    const { hob, group } = setup();
    try {
      const second = hob.runtime.groups.create({ name: "乙", purpose: "测试", ownerId: "hob", members: ["hob"] });
      await hob.runtime.groups.updateMemberModels(group.id, "hob", { conversation: pick("eyes") });
      await hob.runtime.groups.updateMemberModels(second.id, "hob", { conversation: pick("fast") });
      const opened: { customTools: any[] }[] = [];
      const open = hob.runtime.pi.open.bind(hob.runtime.pi);
      vi.spyOn(hob.runtime.pi, "open").mockImplementation(async (options) => { opened.push(options as any); return open(options); });
      const a = await hob.runtime.router.ensure("hob", group.id);
      const b = await hob.runtime.router.ensure("hob", second.id);
      expect(a.desktop).toBe(b.desktop);
      vi.spyOn(a.desktop as any, "getPage").mockResolvedValue({ screenshot: async () => Buffer.from("image") });
      const screenshot = (index: number) => opened[index]!.customTools.find((tool) => tool.name === "browser_screenshot")!.execute("test", {});
      expect((await screenshot(0)).content.map((item: { type: string }) => item.type)).toEqual(["image", "text"]);
      expect((await screenshot(1)).content.map((item: { type: string }) => item.type)).toEqual(["text"]);
    } finally { hob.close(); }
  });
});
