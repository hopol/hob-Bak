// 任务过程的纯函数：步骤合并、edit 的 diff 行。
import { plainText } from "../../shared/plain-text.ts";
import type { Job, JobStep } from "../../shared/types.ts";

/** 同一个 id 到了就替换（工具输出流式更新、跑完补结果），否则接在末尾。 */
export function mergeStep(list: JobStep[], step: JobStep): JobStep[] {
  // 补的那句被任务读到了：去掉「等待读取」那行，正式的一行接在读到它的位置
  if (step.from === "user" && !step.queued) {
    const waiting = list.findIndex((item) => item.queued && item.text === step.text);
    if (waiting >= 0) list = list.filter((_, i) => i !== waiting);
  }
  const index = list.findIndex((item) => item.id === step.id);
  if (index < 0) return [...list, step];
  const next = list.slice();
  next[index] = step;
  return next;
}

/** 拉回一整份 transcript 时，把还没落盘的实时步骤接在后面；同一个 id 以落盘的为准。 */
export function mergeSteps(current: JobStep[], incoming: JobStep[]): JobStep[] {
  const seen = new Set(incoming.map((step) => step.id));
  const out = incoming.slice();
  // 还在等待读取的补充，服务端那份里都有；不在里面的就是已经读到了
  for (const step of current) if (!seen.has(step.id) && !step.queued) out.push(step);
  return out;
}

/** 时间线上要显示的一行：思考过程挂在这一行的 thinking 上，不再单独成行。 */
export interface StepRow extends JobStep {
  thinking?: string;
}

export interface StepRows {
  rows: StepRow[];
  /** 最后一段思考后面还没有步骤（模型还在想）：页面单独显示一行「思考中」 */
  thinking: string | null;
}

/**
 * 把思考过程归到紧随其后的那一步：
 * - 后面接工具步骤或助手回复 → 并进那一行（行尾有灯泡，展开时先显示）；
 * - 连着几段思考中间没有步骤 → 拼成一段；
 * - 末尾没有下文 → thinking（任务还在想的时候）。
 * 实时事件和刷新后拉回来的 transcript 都走这里，两种来源看到的一样。
 */
export function groupThinking(list: JobStep[]): StepRows {
  const rows: StepRow[] = [];
  let pending: string[] = [];
  const take = (): string | undefined => {
    if (!pending.length) return undefined;
    const text = pending.join("\n\n");
    pending = [];
    return text;
  };
  for (const step of list) {
    if (step.kind === "thinking") {
      const text = step.text?.trim();
      if (text) pending.push(text);
      continue;
    }
    // 用户补的话不是助手的那一步：思考留给它后面助手自己的步骤
    if (step.kind === "text" && step.from === "user") {
      rows.push(step);
      continue;
    }
    const thinking = take();
    rows.push(thinking ? { ...step, thinking } : step);
  }
  return { rows, thinking: take() ?? null };
}

/** 已结束时折叠合并思考后的步骤；在跑时始终全部显示。 */
export function visibleSteps(rows: StepRow[], ended: boolean, expanded: boolean) {
  const shown = ended && !expanded ? rows.slice(0, 8) : rows;
  return { rows: shown, remaining: rows.length - shown.length };
}

export interface DiffLine {
  sign: "-" | "+" | " ";
  text: string;
}

const MAX_DIFF_LINES = 400;
const MAX_CELLS = 200_000;
const CONTEXT = 3;

/** 改文件的前后对照：不变的当上下文（前后各三行），删的行标 -，加的行标 +。 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === "" ? [] : before.split("\n");
  const b = after === "" ? [] : after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const head = Math.min(start, CONTEXT);
  const tail = Math.min(a.length - endA, CONTEXT);
  const lines: DiffLine[] = a
    .slice(start - head, start)
    .map((text) => ({ sign: " " as const, text }));
  lines.push(...middle(a.slice(start, endA), b.slice(start, endB)));
  lines.push(...a.slice(endA, endA + tail).map((text) => ({ sign: " " as const, text })));

  if (lines.length <= MAX_DIFF_LINES) return lines;
  return [...lines.slice(0, MAX_DIFF_LINES), { sign: " ", text: "…" }];
}

function middle(a: string[], b: string[]): DiffLine[] {
  if (!a.length) return b.map((text) => ({ sign: "+" as const, text }));
  if (!b.length) return a.map((text) => ({ sign: "-" as const, text }));
  if (a.length * b.length > MAX_CELLS) {
    // 改动大到不适合逐行对比：两边各给开头一段，中间省略
    const half = 190;
    return [
      ...a.slice(0, half).map((text) => ({ sign: "-" as const, text })),
      ...(a.length > half || b.length > half ? [{ sign: " " as const, text: "…" }] : []),
      ...b.slice(0, half).map((text) => ({ sign: "+" as const, text })),
    ];
  }

  // dp[i][j] = a[i..] 和 b[j..] 的最长公共子序列长度
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ sign: " ", text: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ sign: "-", text: a[i] });
      i += 1;
    } else {
      out.push({ sign: "+", text: b[j] });
      j += 1;
    }
  }
  while (i < a.length) out.push({ sign: "-", text: a[i++] });
  while (j < b.length) out.push({ sign: "+", text: b[j++] });
  return out;
}

export function jobDetailRounds(job: Job, steps: JobStep[] | undefined) {
  const history = job.rounds ?? [];
  return [...history, job].map((round, index) => {
    const last = index === history.length;
    const start = round.startedAt ?? (index === 0 ? job.createdAt : history[index - 1].endedAt);
    const end = last ? undefined : round.endedAt;
    const nextStart = !last ? (history[index + 1]?.startedAt ?? (index + 1 === history.length ? job.startedAt : undefined)) : undefined;
    return {
      // 前几轮没写原因就是没有原因，不能沿用整个任务最后的原因
      job: { ...job, ...round, statusReason: round.statusReason, summary: last && ["running", "queued", "waiting"].includes(job.status) ? undefined : round.summary, files: last && ["running", "queued", "waiting"].includes(job.status) ? undefined : round.files },
      instruction: index === 0 ? job.instruction : history[index - 1].followUp,
      steps: steps?.filter((step) => (!start || step.at >= start) && (!end || step.at <= end) && (!nextStart || step.at < nextStart)),
    };
  });
}

/** 状态词：右上角的状态标签已经写过，原因行不能再重复它们。 */
const STATUS_WORDS = new Set(["排队中", "进行中", "待确认", "等你确认", "已完成", "受阻", "失败", "已停止"]);

/**
 * 任务卡和详情里的原因文字：只在真有原因时给。
 * 以前的版本把 outcome 存成了「受阻」「待确认」，那不是原因，不能往卡片上再写一遍。
 */
/**
 * 对话里第 round 张任务卡显示的样子：任务续做过的话，前面几张停在那一轮结束时；
 * 最后一轮（以及没续做过的）就是任务本身，跟着实时变。
 */
export function jobRoundView(job: Job, round = 0): Job {
  const past = job.rounds?.[round];
  if (!past) return job;
  return { ...job, status: past.status, statusReason: past.statusReason, startedAt: past.startedAt, endedAt: past.endedAt, durationMs: past.durationMs };
}

export function jobReason(job: { statusReason?: string }): string | undefined {
  const reason = job.statusReason ? plainText(job.statusReason) : "";
  if (!reason || STATUS_WORDS.has(reason)) return undefined;
  return reason;
}

/** 步骤说明里的 `命令`／`路径` 用等宽字体：按反引号切成小段。 */
export function titleParts(title: string): { text: string; mono: boolean }[] {
  return title
    .split(/`/)
    .map((text, index) => ({ text, mono: index % 2 === 1 }))
    .filter((part) => part.text.length > 0);
}
