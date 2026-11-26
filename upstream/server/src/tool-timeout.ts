import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

const userWaits = new WeakMap<AbortSignal, () => () => void>();

/** 工具开始等人时暂停自己的计时；返回的函数在收到答复或取消等待时调用。 */
export function pauseToolTimeoutForUser(signal?: AbortSignal): () => void {
  return (signal && userWaits.get(signal)?.()) ?? (() => {});
}

/** 每次调用独立中止，保留工具最后一次输出供模型判断。 */
export function limitToolCalls(tools: ToolDefinition<any, any>[], milliseconds: () => number): ToolDefinition<any, any>[] {
  return tools.map(tool => ({
    ...tool,
    ...(tool.name === "bash" ? {
      parameters: {
        ...tool.parameters,
        properties: {
          ...tool.parameters.properties,
          timeout: { ...tool.parameters.properties.timeout, get description() { return `命令最多跑多少秒。不填是 ${milliseconds() / 60_000} 分钟。构建、下载这类久的命令，填够时间。`; } },
        },
      },
    } : {}),
    execute: async (id, args, signal, onUpdate, context) => {
      const ms = milliseconds();
      if (tool.name === "bash" && args && typeof args === "object" && "timeout" in args && typeof args.timeout === "number") return tool.execute(id, args, signal, onUpdate, context);
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, { once: true });
      let partial: Awaited<ReturnType<typeof tool.execute>> | undefined;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let cancel: (() => void) | undefined;
      let remaining = ms;
      let started = 0;
      let pauses = 0;
      let finished = false;
      let expire!: () => void;
      const startTimer = () => {
        started = performance.now();
        timer = setTimeout(expire, remaining);
        timer.unref?.();
      };
      try {
        const execution = Promise.resolve().then(() => tool.execute(id, args, controller.signal, update => {
          partial = update;
          if (!timedOut) onUpdate?.(update);
        }, context));
        const timeout = new Promise<"timeout">(resolve => {
          expire = () => { timedOut = true; controller.abort(); resolve("timeout"); };
        });
        userWaits.set(controller.signal, () => {
          if (finished || timedOut) return () => {};
          if (pauses++ === 0) {
            if (timer) clearTimeout(timer);
            remaining = Math.max(0, remaining - (performance.now() - started));
            if (remaining === 0) { expire(); return () => {}; }
          }
          let resumed = false;
          return () => {
            if (resumed) return;
            resumed = true;
            if (--pauses === 0 && !finished && !timedOut) startTimer();
          };
        });
        startTimer();
        const cancelled = new Promise<"cancelled">(resolve => {
          cancel = () => resolve("cancelled");
          if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
        });
        const outcome = await Promise.race([execution, timeout, cancelled]);
        if (outcome === "cancelled") {
          if (tool.name === "bash") await Promise.race([execution.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 1000))]);
          throw new Error("aborted");
        }
        if (outcome !== "timeout") return outcome;
        // bash 结束时会补发最后一段输出；其他工具可能无视中止，不能让它挡住本轮。
        if (tool.name === "bash") await Promise.race([execution.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 1000))]);
        const content = partial?.content ?? [];
        const hasOutput = content.some(block => block.type !== "text" || block.text.trim());
        const reason = `「${tool.name}」${ms / 60_000} 分钟没有结束，Hob 停掉了这次调用。${hasOutput ? "到停下时的输出在上面。" : ""}${tool.name === "bash" ? "要跑得更久，调用时把 timeout 设成需要的秒数；不用等结果的，放到后台跑，把输出写进文件，之后再读。" : ""}`;
        return { content: [...(hasOutput ? content : []), { type: "text" as const, text: reason }], details: undefined, isError: true };
      } finally {
        finished = true;
        userWaits.delete(controller.signal);
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (cancel) signal?.removeEventListener("abort", cancel);
      }
    },
  }));
}
