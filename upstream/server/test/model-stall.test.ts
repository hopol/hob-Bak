import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { retryStalledModel } from "../src/model-stall.ts";

const context = { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "你好" }], timestamp: Date.now() }] };

describe("模型请求停滞", () => {
  it("第一次挂住后沿用上下文重试并正常回复", async () => {
    const faux = fauxProvider();
    faux.setResponses([() => new Promise(() => {}), fauxAssistantMessage("继续完成。")]);
    let retries = 0;
    const stream = retryStalledModel(faux.provider.streamSimple.bind(faux.provider), () => 80, () => { retries++; });
    const response = await stream(faux.getModel(), context, {});
    const events = []; for await (const event of response) events.push(event);
    expect(retries).toBe(1);
    expect(faux.state.callCount).toBe(2);
    expect((await response.result()).content).toEqual([{ type: "text", text: "继续完成。" }]);
    expect(events.filter(event => event.type === "start")).toHaveLength(1);
  }, 5000);

  it("连续两次挂住后给出模型无响应错误", async () => {
    const faux = fauxProvider();
    faux.setResponses([() => new Promise(() => {}), () => new Promise(() => {})]);
    let retries = 0;
    const stream = retryStalledModel(faux.provider.streamSimple.bind(faux.provider), () => 40, () => { retries++; });
    const response = await stream(faux.getModel(), context, {});
    for await (const _event of response) { /* 消费流 */ }
    expect(retries).toBe(1);
    expect(await response.result()).toMatchObject({ stopReason: "error", errorMessage: "模型没有响应" });
  }, 5000);

  it("用户中止挂住的请求时不重试", async () => {
    const faux = fauxProvider();
    faux.setResponses([() => new Promise(() => {})]);
    let retries = 0;
    const controller = new AbortController();
    const stream = retryStalledModel(faux.provider.streamSimple.bind(faux.provider), () => 1000, () => { retries++; });
    const response = await stream(faux.getModel(), context, { signal: controller.signal });
    controller.abort();
    for await (const _event of response) { /* 消费流 */ }
    expect(retries).toBe(0);
    expect(await response.result()).toMatchObject({ stopReason: "aborted" });
  }, 5000);
});
