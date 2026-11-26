import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

/** 模型请求超时只重发这一请求，沿用原上下文；外层会话的中止仍立即生效。 */
export function retryStalledModel(stream: StreamFn, milliseconds: () => number, onRetry: () => void): StreamFn {
  return (model, context, options) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      let lastPartial: AssistantMessage | undefined;
      let sentStart = false;
      const zeroUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
      const finish = (reason: "aborted" | "error", message: string) => {
        const result: AssistantMessage = { ...(lastPartial ?? { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage, timestamp: Date.now() }), stopReason: reason, errorMessage: message };
        output.push({ type: "error", reason, error: result });
        output.end(result);
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        const parent = options?.signal;
        if (parent?.aborted) abort(); else parent?.addEventListener("abort", abort, { once: true });
        const timeout = Symbol("timeout"), cancelled = Symbol("cancelled");
        const wait = async <T>(promise: Promise<T>): Promise<T | typeof timeout | typeof cancelled> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          let cancel: (() => void) | undefined;
          const timerPromise = new Promise<typeof timeout>(resolve => { timer = setTimeout(() => resolve(timeout), milliseconds()); timer.unref?.(); });
          const cancelPromise = new Promise<typeof cancelled>(resolve => {
            cancel = () => resolve(cancelled);
            if (parent?.aborted) cancel(); else parent?.addEventListener("abort", cancel, { once: true });
          });
          try { return await Promise.race([promise, timerPromise, cancelPromise]); }
          finally { if (timer) clearTimeout(timer); if (cancel) parent?.removeEventListener("abort", cancel); }
        };
        try {
          const response = await wait(Promise.resolve().then(() => stream(model, context, { ...options, signal: controller.signal })));
          if (response === cancelled) { finish("aborted", "Request was aborted"); return; }
          if (response === timeout) { controller.abort(); if (attempt === 0) { onRetry(); continue; } finish("error", "模型没有响应"); return; }
          const iterator = response[Symbol.asyncIterator]();
          while (true) {
            const next = await wait(iterator.next());
            if (next === cancelled) { finish("aborted", "Request was aborted"); return; }
            if (next === timeout) { controller.abort(); break; }
            if (next.done) {
              const result = await wait(response.result());
              if (result === cancelled) { finish("aborted", "Request was aborted"); return; }
              if (result === timeout) { controller.abort(); break; }
              output.end(result); return;
            }
            const event: AssistantMessageEvent = next.value;
            if (event.type === "start") {
              lastPartial = event.partial;
              if (sentStart) continue;
              sentStart = true;
            } else if ("partial" in event) lastPartial = event.partial;
            if (event.type === "done" || event.type === "error") {
              const result = await wait(response.result());
              if (result === cancelled) { finish("aborted", "Request was aborted"); return; }
              if (result === timeout) { controller.abort(); break; }
              output.push(event); output.end(result); return;
            }
            output.push(event);
          }
          if (attempt === 0) onRetry(); else { finish("error", "模型没有响应"); return; }
        } catch (error) {
          finish("error", error instanceof Error ? error.message : String(error)); return;
        } finally {
          parent?.removeEventListener("abort", abort);
        }
      }
    })();
    return output;
  };
}
