import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalOption } from "../../shared/types.ts";
import { generateImage } from "./image.ts";
import type { HobRuntime } from "./runtime.ts";

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/** Worker 的收尾工具：必须调用一次提交结果。验收子任务的任务另有逐条验收结果（checks）。 */
export function registerReportTool(runtime: HobRuntime, jobId: string, sediment = false): ToolDefinition<any, any> {
  // 验收子任务的任务才逐条交结果：别处给了这个参数也没用（不对照验收标准）
  const job = runtime.store.job(jobId);
  const project = job?.project && job.groupId ? runtime.store.project(job.groupId, job.project.id) : undefined;
  const acceptance = Boolean(project?.subtasks.find((subtask) => subtask.n === job?.project?.n)?.check);
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
      ...(acceptance
        ? {
            checks: Type.Optional(
              Type.Array(
                Type.Object({
                  index: Type.Number({ description: "验收标准的序号，从 1 开始。" }),
                  passed: Type.Boolean({ description: "这条通过没有。" }),
                  evidence: Type.String({ description: "证据：命令和输出、截图、文件；不通过时写清通过不了的是什么、应该是什么。" }),
                  files: Type.Optional(Type.Array(Type.String(), { description: "可选，证据里的文件（绝对路径）。" })),
                }),
                { description: "逐条验收结果，每条写验收标准的序号、是否通过、证据（说明和文件路径）。" },
              ),
            ),
          }
        : {}),
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
      // 沉淀这一轮：不收尾任务，拿技能目录和底稿对账；校验不过就退回，这一轮接着做
      if (sediment) {
        const outcome = await runtime.jobs.reportSediment(jobId, String(params.result ?? ""));
        if (outcome.ok) return ok(outcome.text);
        return { content: [{ type: "text" as const, text: outcome.text }], details: undefined, isError: true };
      }
      // 验收结果先存进事项：序号、通过没通过、证据不对就退回，不把半份结果当成验完了
      if (acceptance && (params.checks !== undefined || params.outcome === "done")) {
        try {
          runtime.projects.recordChecks(jobId, params.outcome, params.checks ?? []);
        } catch (error) {
          return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
        }
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

const ORDINAL = /^\s*(?:[①-⑩]|[（(]\s*(?:\d{1,2}|[A-Ca-c])\s*[)）]|(?:\d{1,2}|[A-Ca-c])[.．、:：)）](?!\d))\s*/;
const RECOMMENDED = /^\s*[（(【[]\s*(?:推荐|recommended)\s*[)）】\]]\s*|\s*[（(【[]\s*(?:推荐|recommended)\s*[)）】\]]\s*$/i;

/** 卡片自己编号：每条都带序号才去掉，免得误删正文开头的「1.」。 */
export function unnumber(texts: string[]): string[] {
  const numbered = texts.every((text) => ORDINAL.test(text) && text.replace(ORDINAL, "").trim());
  return texts.map((text) => (numbered ? text.replace(ORDINAL, "") : text).trim());
}

/** 卡片自己标 A、B、C 和「推荐」：去掉模型写进选项文字的序号和「（推荐）」，推荐记成第一个带它的选项。 */
export function askOptions(labels: string[]): { options: ApprovalOption[]; recommended?: ApprovalOption["key"] } {
  let recommended: ApprovalOption["key"] | undefined;
  const options = unnumber(labels).map((text, index) => {
    const key = (["A", "B", "C"] as const)[index];
    let label = text;
    const bare = label.replace(RECOMMENDED, "").trim();
    if (bare && bare !== label) { label = bare; recommended ??= key; }
    return { key, label };
  });
  return { options, ...(recommended ? { recommended } : {}) };
}

/** 填的 recommended 也按选项的规则去掉序号和「（推荐）」，好和清理后的选项文字对上。 */
export function cleanRecommended(text: string): string {
  const trimmed = text.trim();
  const unnumbered = ORDINAL.test(trimmed) && trimmed.replace(ORDINAL, "").trim() ? trimmed.replace(ORDINAL, "") : trimmed;
  return unnumbered.replace(RECOMMENDED, "").trim() || trimmed;
}

/** Worker 的询问工具：阻塞等待用户选择一个选项。 */
export function registerAskTool(runtime: HobRuntime, jobId: string, sediment = false): ToolDefinition<any, any> {
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
      // 沉淀这一轮问不了：答案要现等，先把做法里的判断点写进技能
      if (sediment) return ok("沉淀时不用问：拿不准的地方，在技能里写成执行前要确认的一步。");
      const labels: { label: string }[] = Array.isArray(params.options) ? params.options : [];
      if (labels.length < 2 || labels.length > 3) {
        return { content: [{ type: "text" as const, text: "选项要 2 到 3 个。" }], details: undefined, isError: true };
      }
      const { options, recommended } = askOptions(labels.map((option) => String(option.label)));
      const answer = await runtime.jobs.askQuestion(jobId, {
        title: String(params.title),
        ...(params.detail ? { detail: String(params.detail) } : {}),
        options,
        ...(recommended ? { recommended } : {}),
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
