import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ApprovalOption } from "../../shared/types.ts";
import { generateImage } from "./image.ts";
import { loginCard, prepareLogin } from "./login.ts";
import { prepareFillNewPassword } from "./new-password.ts";
import type { HobRuntime } from "./runtime.ts";

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

/** Worker 的收尾工具：必须调用一次提交结果。 */
export function registerReportTool(runtime: HobRuntime, jobId: string, sediment = false): ToolDefinition<any, any> {
  return {
    name: "report",
    label: "提交结果",
    description: "提交结果。完成了、无法继续，或者需要用户决定时调用。",
    parameters: Type.Object({
      outcome: Type.Unsafe<"done" | "stuck" | "need_approval">(
        Type.String({ description: "done 要的结果拿到了；stuck 要的结果没拿到（无法继续或未完成），写明做到哪、受阻原因、缺什么；need_approval 需要用户决定才能继续，写明要决定什么。" }),
      ),
      result: Type.String({ description: "完整结果，按这个顺序写：结论；做了什么；验证了什么、怎么验证的；没验证或不确定的；需要用户决定的。带上数据、链接和文件路径，写给分派任务的助手。" }),
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
      // 回顾这一轮：只记录回顾结果，不改变任务状态。
      if (sediment) {
        const outcome = await runtime.jobs.reportSediment(jobId, String(params.result ?? ""));
        if (outcome.ok) return ok(outcome.text);
        return { content: [{ type: "text" as const, text: outcome.text }], details: undefined, isError: true };
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
    execute: async (_id, params: any, signal) => {
      // 沉淀这一轮问不了：答案要现等，先把做法里的判断点写进技能
      if (sediment) return ok("沉淀时无需询问：拿不准的地方，在技能里写成执行前要确认的一步。");
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
      }, ...(signal ? [signal] as const : []));
      // 用户可能没选给出的选项，而是自己写了一段：answer 已经是回给模型的整句
      return ok(answer);
    },
  };
}

/** Worker 的登录工具：Hob 看过页面和密码管理器以后决定出哪张卡，卡片和答复走 ask_user 的路（交给助手，由助手请用户办）。凭据只在 Hob 内存和当前页面之间经过。 */
export function registerLoginTool(runtime: HobRuntime, jobId: string, sediment = false, credentials = false): ToolDefinition<any, any> {
  return {
    name: "login",
    label: "登录",
    description: credentials
      ? "登录云桌面浏览器里当前打开的网站，先打开网站的登录页再调用。用户的密码管理器里存了这个网站的账号时，Hob 核对网址、请用户批准后，把账号和密码直接填进页面；没存的，请用户在卡片上填一次，存进密码管理器再填；页面要扫码、第三方账号或验证码这类只能用户本人完成的，请用户在云桌面里自己登录。密码不经过你。填好以后由你点登录按钮；分两步的登录页（先填用户名、点下一步才出密码框），点完下一步再调一次。site 写网站网址或名称，比如 forum.example.net 或「Example 论坛」；同一个网站存了几个账号时，account 写要用的用户名或邮箱，不确定就不填，用户在卡上选；reason 一句话写为什么要登录，显示在卡上；self 填 true 时不填账号，直接请用户在云桌面里自己登录。"
      : "请用户在云桌面里登录一个网站：会出一张卡，用户登录完会告诉你；登录信息所有助手共用，登一次就行。site 写哪个网站，reason 一句话写为什么要登录。",
    parameters: Type.Object({
      site: Type.String({ description: "网站网址或名称" }),
      reason: Type.String({ description: "为什么要登录，一句话" }),
      ...(credentials ? { account: Type.Optional(Type.String({ description: "用户名或邮箱，不确定就不填" })), self: Type.Optional(Type.Boolean({ description: "用户要自己登录时填 true" })) } : {}),
    }),
    execute: async (_id, params: any, signal) => {
      if (sediment) return ok("沉淀时无需询问：把登录这一步写进技能，交给助手处理。");
      const site = String(params.site ?? "").trim();
      const reason = String(params.reason ?? "").trim();
      const account = typeof params.account === "string" ? params.account.trim() : undefined;
      if (!site || !reason) return { content: [{ type: "text" as const, text: "site 和 reason 都要填写清楚。" }], details: undefined, isError: true };
      try {
        const prepared = await prepareLogin(runtime, runtime.store.job(jobId)?.assistantId ?? "", site, account, params.self === true);
        if (prepared.kind === "message" || prepared.kind === "mismatch") return ok(prepared.text);
        if (prepared.kind === "failed") return { content: [{ type: "text" as const, text: prepared.text }], details: undefined, isError: true };
        const card = loginCard(prepared, site, reason);
        return ok(await runtime.jobs.askQuestion(jobId, { title: card.title, ...(card.detail ? { detail: card.detail } : {}), options: card.options, login: card.login }, signal));
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
    },
  };
}

/** Worker 的生成并填写新密码工具：凭据只在 Hob 内存和当前页面之间经过。 */
export function registerFillNewPasswordTool(runtime: HobRuntime, jobId: string, sediment = false): ToolDefinition<any, any> {
  return {
    name: "fill_new_password",
    label: "生成并填写新密码",
    description: "注册新账号或修改密码时用：让用户的密码管理器按网站的要求生成一个新密码，Hob 先把它存进密码管理器，再填进云桌面浏览器当前页面的密码框（新密码和确认密码都填），密码不经过你。会先请用户批准。username 写注册或登录用的用户名或邮箱；length 和 characters 照页面上写的密码要求填，页面没写就不填（默认 20 位，含小写、大写、数字和符号）；name 是存进密码管理器时的名称，默认用网站名。",
    parameters: Type.Object({
      username: Type.String({ description: "注册或登录用的用户名或邮箱" }),
      length: Type.Optional(Type.Integer({ minimum: 4, maximum: 128, description: "页面要求的密码长度；不填默认 20 位" })),
      characters: Type.Optional(Type.Array(Type.Union([Type.Literal("lowercase"), Type.Literal("uppercase"), Type.Literal("numbers"), Type.Literal("symbols")]), { minItems: 1, maxItems: 4, description: "页面允许的字符种类；不填默认含小写、大写、数字和符号" })),
      name: Type.Optional(Type.String({ description: "存进密码管理器时的名称；不填用网站名" })),
    }),
    execute: async (_id, params: any, signal) => {
      if (sediment) return ok("沉淀时无需询问：把生成新密码这一步写进技能，交给助手处理。");
      const username = String(params.username ?? "").trim();
      if (!username) return { content: [{ type: "text" as const, text: "username 要填写注册或登录用的用户名或邮箱。" }], details: undefined, isError: true };
      try {
        const characters = Array.isArray(params.characters) ? params.characters as ("lowercase" | "uppercase" | "numbers" | "symbols")[] : undefined;
        const prepared = await prepareFillNewPassword(runtime, runtime.store.job(jobId)?.assistantId ?? "", username, params.length === undefined ? undefined : Number(params.length), characters, typeof params.name === "string" ? params.name : undefined);
        if (prepared.kind === "message") return ok(prepared.text);
        const answer = await runtime.jobs.askQuestion(jobId, {
          title: prepared.title,
          detail: prepared.detail,
          options: [{ key: "A", label: "不允许" }, { key: "B", label: "生成并填写" }],
          login: { site: prepared.approval.host, reason: prepared.detail, fillNewPassword: prepared.approval },
        }, signal);
        return ok(answer);
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], details: undefined, isError: true };
      }
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
    execute: async (_id, params: any, signal) => {
      const job = runtime.store.job(jobId);
      if (!job) return { content: [{ type: "text" as const, text: "任务不存在。" }], details: undefined, isError: true };
      try {
        const path = await generateImage(
          {
            home: runtime.home,
            dir: job.cwd ?? runtime.store.workDir(jobId),
            config: runtime.settings.settings.image,
            signal,
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
