import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalOption } from "../../shared/types.ts";
import { generateImage } from "./image.ts";
import type { HobRuntime } from "./runtime.ts";

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/** Worker 的收尾工具：必须调用一次提交结果。 */
export function registerReportTool(runtime: HobRuntime, jobId: string): ToolDefinition<any, any> {
  return {
    name: "report",
    label: "提交结果",
    description: "交结果。做完了、做不下去了，或者要用户拍板时调用。",
    parameters: Type.Object({
      outcome: Type.Unsafe<"done" | "stuck" | "need_approval">(
        Type.String({ description: "done 要的结果拿到了；stuck 要的结果没拿到（做不下去或没做完），写明做到哪、缺什么；need_approval 要用户拍板才能往下做，写明要定什么。" }),
      ),
      result: Type.String({ description: "完整结果，按这个顺序写：结论；做了什么；验证了什么、怎么验证的；没验证或不确定的；需要用户决定的。带上数据、链接和文件路径，写给派活的助手。" }),
      files: Type.Optional(Type.Array(Type.String(), { description: "交给助手的文件（绝对路径），比如要给用户看的图。" })),
    }),
    execute: async (_id, params: any) => {
      // 不认识的结果不能当成已完成：退回让模型重新调用
      if (params.outcome !== "done" && params.outcome !== "stuck" && params.outcome !== "need_approval") {
        return {
          content: [{ type: "text" as const, text: "outcome 只能是 done、stuck 或 need_approval，请重新调用 report。" }],
          details: undefined,
          isError: true,
        };
      }
      runtime.jobs.reportFromTool(jobId, {
        outcome: params.outcome,
        result: String(params.result ?? ""),
        ...(Array.isArray(params.files) && params.files.length ? { files: params.files as string[] } : {}),
      });
      return ok("结果已记录。");
    },
  };
}

/** Worker 的询问工具：阻塞等待用户选择一个选项。 */
export function registerAskTool(runtime: HobRuntime, jobId: string): ToolDefinition<any, any> {
  return {
    name: "ask_user",
    label: "询问用户",
    description: "问你的助手，等它回复。它能答的会直接答，要用户定的会去问用户。",
    parameters: Type.Object({
      title: Type.String({ description: "问题，一句话" }),
      detail: Type.Optional(Type.String({ description: "补充说明，写清后果。" })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "选项文字" }),
        }),
        { description: "2 到 3 个选项", minItems: 2, maxItems: 3 },
      ),
    }),
    execute: async (_id, params: any) => {
      const labels: { label: string }[] = Array.isArray(params.options) ? params.options : [];
      if (labels.length < 2 || labels.length > 3) {
        return { content: [{ type: "text" as const, text: "选项要 2 到 3 个。" }], details: undefined, isError: true };
      }
      const options: ApprovalOption[] = labels.map((option, index) => ({
        key: (["A", "B", "C"] as const)[index],
        label: String(option.label),
      }));
      const answer = await runtime.jobs.askQuestion(jobId, {
        title: String(params.title),
        ...(params.detail ? { detail: String(params.detail) } : {}),
        options,
      });
      // 用户可能没选给出的选项，而是自己写了一段：answer 已经是回给模型的整句
      return ok(answer);
    },
  };
}

/** Worker 的图像生成工具：只在配了图像生成、且这个助手开着这项能力时才注册。 */
export function registerImageTool(runtime: HobRuntime, jobId: string): ToolDefinition<any, any> {
  return {
    name: "generate_image",
    label: "生成图片",
    description:
      "按文字描述生成一张图片，返回图片的绝对路径（存在任务工作目录）。要给用户看，就把路径放进 report 的 files。",
    parameters: Type.Object({
      prompt: Type.String({ description: "要画什么，越具体越好" }),
      size: Type.Optional(
        Type.String({ description: "尺寸，如 1024x1024；不填用设置里的默认（有的模型不支持，会忽略）" }),
      ),
      refs: Type.Optional(
        Type.Array(Type.String(), { description: "参考图的绝对路径（改图、按图生成的时候给）" }),
      ),
    }),
    execute: async (_id, params: any) => {
      const job = runtime.store.job(jobId);
      if (!job) return { content: [{ type: "text" as const, text: "任务不存在。" }], details: undefined, isError: true };
      try {
        const path = await generateImage(
          {
            home: runtime.home,
            dir: job.cwd ?? runtime.store.workDir(jobId),
            config: runtime.settings.settings.image,
          },
          {
            prompt: String(params.prompt ?? ""),
            ...(params.size ? { size: String(params.size) } : {}),
            ...(Array.isArray(params.refs) && params.refs.length ? { refs: params.refs.map(String) } : {}),
          },
        );
        return ok(`图片已生成：${path}`);
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
          details: undefined,
          isError: true,
        };
      }
    },
  };
}
