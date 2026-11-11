// 主助手管理助手、群和话题的工具：只有主助手有，单聊和群里都有。
// 改东西走界面上同一套函数（updateAssistant、groups.create/update、createTopic、createFromDraft），
// 校验和事件推送一样；改成功在对话和群里各落一行提示。
import { Type } from "@earendil-works/pi-ai";
import { propArtSchema } from "./prop-art-schema.ts";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { STAGE_TEXT } from "../../shared/project.ts";
import {
  PROP_IDS,
  PROPS,
  distinctSprite,
  parseSprite,
  validateCustomProp,
} from "../../shared/sprites.ts";
import { THINKING_TEXT } from "../../shared/thinking.ts";
import type { Assistant, Draft, Group, GroupItem } from "../../shared/types.ts";
import type { AssistantPatch } from "./actions.ts";
import { createFromDraft, updateAssistant } from "./actions.ts";
import { listAssistantSkills } from "./assistant-skills.ts";
import { cronToChinese } from "./cron-text.ts";
import { newId } from "./ids.ts";
import type { HobRuntime } from "./runtime.ts";
import type { Store } from "./store.ts";
import { clampDuty } from "./text.ts";
import { monthDayTimeText } from "./time.ts";

type Tool = ToolDefinition<any, any>;

/** 查看工具每页几条：由代码固定，不是参数。 */
const PAGE_SIZE = 20;

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function fail(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined, isError: true };
}

function pageOf(value: unknown): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? page : 1;
}

/** 分页提示：还是最后一页只写共几个。 */
function pageHint(page: number, total: number, pages: number, unit: "个" | "条"): string {
  return page < pages ? `第 ${page}/${pages} 页，共 ${total} ${unit}；看下一页填 page=${page + 1}` : `共 ${total} ${unit}`;
}

/** 可选参数：模型常把没用到的项也填上空串，空串当没填。 */
function filled(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text : undefined;
}

/** 工作方式：software 是软件开发，none 是普通群（null）；没填是 undefined；别的值返回 false。 */
function workflowParam(value: unknown): "software" | null | undefined | false {
  const given = filled(value);
  if (given === undefined) return undefined;
  if (given === "software") return "software";
  if (given === "none" || given === "null") return null;
  return false;
}

/** 内容只留前 200 字。 */
function cut(text: string, max = 200): string {
  const chars = [...text.trim()];
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

/** 时间线里一条条目写成一句事实；系统的提示行不列。 */
function itemText(store: Store, item: GroupItem, gid: string): string | undefined {
  switch (item.kind) {
    case "user":
    case "assistant":
      return item.text.trim() ? item.text : undefined;
    case "job":
      return `派了任务「${store.job(item.jobId)?.title ?? item.jobId}」`;
    case "question":
      return `问了「${store.approval(item.approvalId)?.title ?? "一件事"}」`;
    case "topic":
      return `开了话题「${store.group(item.topicId)?.name ?? item.topicId}」`;
    case "project":
      return `立了事项「${store.project(gid, item.projectId)?.title ?? item.projectId}」`;
    case "file":
      return `发了文件「${item.name}」`;
    case "image":
      return "生成了图片";
    default:
      return undefined;
  }
}

/** 一条消息写成一行：`[11月8日 10:05] 用户：内容`；where 是查消息时带上的位置。 */
function messageLine(store: Store, item: GroupItem, gid: string, timezone: string, where?: string): string | undefined {
  const content = itemText(store, item, gid);
  if (content === undefined) return undefined;
  const who = item.speaker === "user" ? "用户" : (store.assistant(item.speaker)?.name ?? item.speaker);
  const at = monthDayTimeText(timezone, new Date(item.at));
  return `[${at}] ${who}${where ? `（${where}）` : ""}：${cut(content)}`;
}

/** 助手按左栏顺序：置顶的在前，收起的在最后；同一区按位置和创建时间。 */
function byAssistantOrder(a: Assistant, b: Assistant): number {
  const region = (item: Assistant) => (item.pinned && !item.hidden ? 0 : item.hidden ? 2 : 1);
  const order = (item: Assistant) => item.pinOrder ?? Number.MAX_SAFE_INTEGER;
  return region(a) - region(b) || order(a) - order(b) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

/**
 * 主助手的管理工具和两个查看工具。只有主助手会拿到它们（router-tools 里按 primary 加），
 * 群会话里也保留。
 */
export function buildAdminTools(runtime: HobRuntime, assistantId: string, groupId?: string): Tool[] {
  const { store, router } = runtime;
  const nameOf = (id: string) => store.assistant(id)?.name ?? id;
  const timezone = runtime.settings.settings.general.timezone;

  /**
   * 改成功留一行：这次说话所在的对话里一行；改到某个群的，那个群的时间线里也一行。
   * 两处是同一条时间线时只落一行（写群里那句，主语是主助手的名字）。
   */
  const announce = async (note: { conversation: string; group?: { gid: string; text: string }; targetGroupId?: string }) => {
    const targetGroupId = note.targetGroupId ?? note.group?.gid;
    const target = targetGroupId ? { targetGroupId } : {};
    if (note.group && note.group.gid === groupId) {
      await router.addItem(assistantId, { kind: "note", icon: "info", text: note.group.text, ...target }, groupId);
      return;
    }
    await router.addItem(assistantId, { kind: "note", icon: "info", text: note.conversation, ...target }, groupId);
    if (note.group) runtime.groups.appendItem(note.group.gid, assistantId, { kind: "note", icon: "info", text: note.group.text, ...target });
  };

  /** 一个助手的完整资料：改资料、规则、定时之前看它。 */
  const assistantProfile = async (target: Assistant): Promise<string> => {
    const pick = (key: "conversation" | "work") => {
      const chosen = target.models?.[key];
      return chosen ? `${chosen.ref} · 思考 ${THINKING_TEXT[chosen.thinking]}` : "跟随设置";
    };
    const abilities = target.abilities ?? { exec: true, write: true, image: true };
    const able = [abilities.exec && "执行命令", abilities.write && "修改文件", abilities.image && "图像生成"].filter(Boolean);
    const lines = [
      `${target.name}（${target.id}）`,
      `职责：${target.duty || "没有"}`,
      `详细职责：${target.dutyLong?.trim() || "没有"}`,
      `说明：${target.instructions.trim() || "没有"}`,
      `对话模型：${pick("conversation")}`,
      `任务模型：${pick("work")}`,
      `能力：${able.length ? able.join("、") : "无"}`,
    ];
    // 绑定的知识库写名字和 id；名字查不到（库已被删）就只写 id
    const bound = target.knowledge ?? [];
    const collections = bound.length ? (await runtime.knowledge.list()).collections : [];
    lines.push(`知识库：${bound.length ? bound.map((id) => { const found = collections.find((item) => item.id === id); return found ? `${found.name}（${id}）` : id; }).join("、") : "没有"}`);
    const rules = store.rules(target.id);
    lines.push(rules.length ? "规则：" : "规则：没有");
    for (const rule of rules) lines.push(`- ${rule.id} · ${rule.mode === "ask" ? "执行前确认" : "直接执行"} · ${rule.text}`);
    const routines = store.routines().filter((routine) => routine.assistantId === target.id);
    lines.push(routines.length ? "定时任务：" : "定时任务：没有");
    for (const routine of routines) lines.push(`- ${routine.id} · ${routine.name} · ${routine.schedules.map(cronToChinese).join("、")} · ${routine.active ? "启用" : "已暂停"} · ${routine.instruction}`);
    try {
      const skills = listAssistantSkills(runtime.home, target.id);
      lines.push(skills.length ? "技能：" : "技能：没有");
      for (const skill of skills) lines.push(`- ${skill.name}「${skill.title}」· ${skill.enabled ? "已启用" : "已停用"}`);
    } catch (error) {
      lines.push(`技能：读取失败（${error instanceof Error ? error.message : String(error)}）`);
    }
    return lines.join("\n");
  };

  const tools: Tool[] = [
    {
      name: "show_assistant",
      label: "查看助手",
      description:
        "看助手。不填 assistantId，列出全部助手（包括收起的），每个一行：名字、id、职责、在哪些群；填了，看这个助手的完整资料：详细职责、说明、模型、能力、知识库、规则、定时任务和技能。改资料、规则、定时之前先看。",
      parameters: Type.Object({
        assistantId: Type.Optional(Type.String({ description: "可选，助手 id" })),
        query: Type.Optional(Type.String({ description: "可选，按关键词找助手，匹配名字、职责和说明" })),
        page: Type.Optional(Type.Number({ description: "可选，第几页，默认 1" })),
      }),
      execute: async (_id, params: any) => {
        const id = String(params.assistantId ?? "").trim();
        if (id) {
          const target = store.assistant(id);
          if (!target) return fail(`没有这个助手：${id}`);
          return ok(await assistantProfile(target));
        }
        const query = String(params.query ?? "").trim();
        const needle = query.toLowerCase();
        const groups = store.groups().filter((group) => !group.parentId);
        const listed = store
          .assistants()
          .filter((item) => !needle || [item.name, item.id, item.duty, item.dutyLong ?? "", item.instructions].some((field) => field.toLowerCase().includes(needle)))
          .sort(byAssistantOrder);
        if (!listed.length) return ok(query ? `没有找到含「${query}」的助手` : "还没有助手。");
        const pages = Math.ceil(listed.length / PAGE_SIZE);
        const page = Math.min(pageOf(params.page), pages);
        const rows = listed.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((item) => {
          const inGroups = groups.filter((group) => group.members.includes(item.id)).map((group) => group.name);
          const head = item.duty ? `${item.name}（${item.id}）：${item.duty}` : `${item.name}（${item.id}）`;
          return `${head}${inGroups.length ? `；在群：${inGroups.join("、")}` : ""}${item.hidden ? "（收起）" : ""}`;
        });
        return ok([...rows, pageHint(page, listed.length, pages, "个")].join("\n"));
      },
    },
    {
      name: "show_group",
      label: "查看群",
      description:
        "看群。不填 groupId，列出全部群，每个一行：名字、id、群主、成员、工作方式、进行中的话题数；填了，看这个群的详情：负责什么、话题（进行中的和已关闭的）、事项进度和消息。填话题 id 就看这个话题。",
      parameters: Type.Object({
        groupId: Type.Optional(Type.String({ description: "可选，群或话题的 id" })),
        query: Type.Optional(Type.String({ description: "可选，关键词。不填 groupId 时按群名、负责什么、成员和话题名找群；填了 groupId 时在这个群和它的话题的消息里找" })),
        page: Type.Optional(Type.Number({ description: "可选，第几页，默认 1。看消息时第 1 页是最近的 20 条，往后越来越早" })),
      }),
      execute: async (_id, params: any) => {
        const query = String(params.query ?? "").trim();
        const id = String(params.groupId ?? "").trim();
        if (!id) {
          const needle = query.toLowerCase();
          const all = store.groups().filter((group) => !group.parentId);
          const listed = all.filter((group) => {
            if (!needle) return true;
            const topics = runtime.groups.topicsOf(group.id).map((topic) => topic.name);
            return [group.name, group.purpose, ...group.members.map(nameOf), ...topics].some((field) => field.toLowerCase().includes(needle));
          });
          if (!listed.length) return ok(query ? `没有找到含「${query}」的群` : "还没有群。");
          const pages = Math.ceil(listed.length / PAGE_SIZE);
          const page = Math.min(pageOf(params.page), pages);
          const rows = listed.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((group) => {
            const active = runtime.groups.activeTopics(group.id).length;
            return `${group.name}（${group.id}）：群主 ${nameOf(group.ownerId)}；成员 ${group.members.map(nameOf).join("、")}${group.workflow === "software" ? "；工作方式 软件开发" : ""}${active ? `；进行中的话题 ${active} 个` : ""}`;
          });
          return ok([...rows, pageHint(page, listed.length, pages, "个")].join("\n"));
        }
        const group = store.group(id);
        if (!group) return fail(`没有这个群：${id}`);
        const timezoneText = timezone;
        // 给了关键词：在这个群和它的话题的消息里找，新的在前
        if (query) {
          const needle = query.toLowerCase();
          const timelines = group.parentId
            ? [{ gid: group.id, where: group.name }]
            : [{ gid: group.id, where: "综合" }, ...runtime.groups.topicsOf(group.id).map((topic) => ({ gid: topic.id, where: topic.name }))];
          const rows: { line: string; at: string; order: number }[] = [];
          for (const timeline of timelines) {
            for (const [index, item] of runtime.groups.timeline(timeline.gid).entries()) {
              const content = itemText(store, item, timeline.gid);
              if (content === undefined || !content.toLowerCase().includes(needle)) continue;
              const line = messageLine(store, item, timeline.gid, timezoneText, timeline.where);
              if (line) rows.push({ line, at: item.at, order: index });
            }
          }
          // 新的在前；同一条时间线里同一毫秒的，后写的在前
          rows.sort((a, b) => b.at.localeCompare(a.at) || b.order - a.order);
          if (!rows.length) return ok(`没有找到含「${query}」的消息`);
          const pages = Math.ceil(rows.length / PAGE_SIZE);
          const page = Math.min(pageOf(params.page), pages);
          const shown = rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((row) => row.line);
          return ok([...shown, pageHint(page, rows.length, pages, "条")].join("\n"));
        }
        const lines = [`${group.name}（${group.id}）`];
        if (group.parentId) {
          const host = store.group(group.parentId);
          lines.push(`所属的群：${host ? `${host.name}（${host.id}）` : group.parentId}`);
          lines.push(`状态：${group.closedAt ? `已关闭${group.closeNote ? ` · 结论：${group.closeNote}` : ""}` : "进行中"}`);
          const project = runtime.projects.topicOf(group);
          if (project) lines.push(`事项：「${project.title}」· ${STAGE_TEXT[project.stage]} · 子任务 ${project.done}/${project.total}`);
        } else {
          lines.push(`负责什么：${group.purpose}`);
          lines.push(`群主：${nameOf(group.ownerId)}`);
          lines.push(`成员：${group.members.map(nameOf).join("、")}`);
          lines.push(`工作方式：${group.workflow === "software" ? "软件开发" : "无"}`);
          const topics = runtime.groups.topicsOf(group.id);
          lines.push(topics.length ? "话题：" : "话题：还没有");
          for (const topic of topics) {
            const project = runtime.projects.topicOf(topic);
            const state = topic.closedAt ? `已关闭${topic.closeNote ? ` · 结论：${topic.closeNote}` : ""}` : "进行中";
            lines.push(`- ${topic.name}（${topic.id}）· ${state}${project ? ` · 事项「${project.title}」· ${STAGE_TEXT[project.stage]} · 子任务 ${project.done}/${project.total}` : ""}`);
          }
        }
        const all = runtime.groups.timeline(group.id).flatMap((item) => {
          const line = messageLine(store, item, group.id, timezoneText);
          return line ? [line] : [];
        });
        const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
        const page = Math.min(pageOf(params.page), pages);
        // 第 1 页是最近的 20 条，页内按时间先后的顺序写
        const rows = all.slice(Math.max(0, all.length - page * PAGE_SIZE), all.length - (page - 1) * PAGE_SIZE);
        lines.push(rows.length ? "消息：" : "消息：还没有");
        lines.push(...rows);
        lines.push(pageHint(page, all.length, pages, "条"));
        return ok(lines.join("\n"));
      },
    },
    {
      name: "create_assistant",
      label: "新建助手",
      description: "新建一个专属助手，建好后对话里出一张助手卡。做事的方法由所有助手共用的模板和全局规则决定，这里只写这个助手特有的东西。",
      parameters: Type.Object({
        name: Type.String({ description: "助手名字，职责加一个亲切的昵称，四五个字，如「写稿搭子」「记账管家」。" }),
        duty: Type.String({ description: "左栏头像下面那行小字，最多 8 个字，如「周报和文章」「账单和预算」。" }),
        dutyLong: Type.String({ description: "助手卡里的职责说明，两三句话，写完整一些" }),
        sprite: Type.String({
          description: `内置道具：${PROP_IDS.filter((id) => id !== "hob").map((id) => `${id} ${PROPS[id].label}`).join("，")}；或 custom（同时填 prop_art，自己画一件）`,
        }),
        prop_art: propArtSchema,
        routines: Type.Optional(
          Type.Array(
            Type.Object({ name: Type.String(), instruction: Type.String(), schedule: Type.String() }),
            { description: "可选。这个助手要定期做的事，不是每个助手都需要；拿不准就先问用户，问清楚再加。" },
          ),
        ),
        askFirst: Type.Optional(Type.Array(Type.String(), { description: "这个领域特有、做之前要先问用户的事，每项一条；全局规则已经列的不重复。" })),
        // 必填：可选时模型第一次总是漏掉，被打回再补，白走一轮（评测 G5 三次都这样）
        facts: Type.Array(Type.String(), { description: "这个助手特有的事实，每项一行：管什么、不管什么（归谁管）、东西在哪（目录、服务）。只写事实，不写做法和规矩。例：「博客源码在 ~/sites/blog，用 Hugo 构建」「报销归「财务」助手管，这里不碰」" }),
      }),
      execute: async (_id, params: any) => {
        const checked = params.prop_art !== undefined ? validateCustomProp(params.prop_art) : undefined;
        if (checked && !checked.ok) return fail(`prop_art 画得不对：${checked.error}；照着原因改好，再调用一次。`);
        const given = parseSprite(String(params.sprite ?? ""));
        if (given?.prop === "hob") return fail("hob 火苗是主助手专用的。");
        if (checked?.ok && given && given.prop !== "custom") {
          return fail("sprite 填了内置道具就不要传 prop_art；要自画一件就把 sprite 填 custom。");
        }
        if (given?.prop === "custom" && !checked?.ok) {
          return fail("sprite 是 custom 时要同时给 prop_art（art、pal、dx）画一件。");
        }
        const facts = Array.isArray(params.facts) ? params.facts.filter((fact: unknown): fact is string => typeof fact === "string").map((fact: string) => fact.trim()).filter(Boolean) : [];
        if (!facts.length) return fail("facts 至少写一条：这个助手管什么、不管什么。");
        const routinesInput: { name: string; instruction: string; schedule: string }[] = params.routines ?? [];
        const taken = store.assistants().map((item) => item.sprite);
        // 自画的存画法（sprite 记成 custom）；内置道具的照旧，和已有助手撞了就换个颜色
        const sprite = checked?.ok ? distinctSprite("custom", taken) : given ? distinctSprite(String(params.sprite), taken) : "page";
        const prop = checked?.ok ? checked.prop : undefined;
        const draft: Draft = {
          id: newId("d-"),
          assistantId,
          status: "pending",
          name: String(params.name),
          sprite,
          ...(prop ? { prop } : {}),
          duty: clampDuty(String(params.duty ?? "")),
          dutyLong: String(params.dutyLong),
          routines: routinesInput,
          routinesText: routinesInput.map((item) => `${item.name} · ${cronToChinese(item.schedule)}`).join("、"),
          askFirst: (params.askFirst as string[]) ?? [],
          instructions: facts,
          createdAt: new Date().toISOString(),
        };
        store.saveDraft(draft);
        await router.addItem(assistantId, { kind: "draft", draftId: draft.id });
        runtime.bus.emit({ type: "draft", draft });
        // 落完草稿卡直接建好：卡片就是「已创建」的样子；没建成的话草稿还留着，用户可以在卡上点
        const created = await createFromDraft(runtime, draft.id);
        if (created.status !== 200) {
          const reason = (created.body as { error?: string }).error ?? "原因不明";
          return fail(`创建失败：${reason}。草稿卡还在，可以在卡上点「创建」。`);
        }
        const { assistant, routineReport } = created.body as { assistant: { id: string; name: string }; routineReport: string[] };
        if (groupId) await announce({ conversation: `已建好助手「${assistant.name}」` });
        return ok([`已建好助手「${assistant.name}」（${assistant.id}）。`, ...routineReport].join("\n"));
      },
    },
    {
      name: "update_assistant",
      label: "修改助手",
      description: "改一个助手的资料，只改填了的项，改完立即生效。",
      parameters: Type.Object({
        assistantId: Type.String({ description: "助手 id" }),
        name: Type.Optional(Type.String({ description: "名字" })),
        duty: Type.Optional(Type.String({ description: "左栏头像下面那行小字，最多 8 个字" })),
        dutyLong: Type.Optional(Type.String({ description: "详细职责" })),
        instructions: Type.Optional(Type.String({ description: "补充说明，整段替换：先用 show_assistant 看现在的内容，在它的基础上改" })),
        conversationModel: Type.Optional(Type.String({ description: "对话模型，填模型 ref；填 default 跟随全局设置" })),
        workModel: Type.Optional(Type.String({ description: "任务模型，填模型 ref；填 default 跟随全局设置" })),
        abilities: Type.Optional(
          Type.Object(
            {
              exec: Type.Boolean({ description: "跑命令" }),
              write: Type.Boolean({ description: "改文件" }),
              image: Type.Boolean({ description: "生图" }),
            },
            { description: "派出去的活能用的能力：exec 跑命令，write 改文件，image 生图" },
          ),
        ),
        knowledge: Type.Optional(Type.Array(Type.String(), { description: "绑定的知识库 id，整体替换" })),
        pinned: Type.Optional(Type.Boolean({ description: "置顶" })),
        hidden: Type.Optional(Type.Boolean({ description: "收起" })),
        notify: Type.Optional(Type.Boolean({ description: "需要确认时通知用户" })),
      }),
      execute: async (_id, params: any) => {
        const id = String(params.assistantId ?? "").trim();
        const target = store.assistant(id);
        if (!target) return fail(`没有这个助手：${id}`);
        const patch: AssistantPatch = {};
        const changes: string[] = [];
        const name = filled(params.name);
        if (name !== undefined && name !== target.name) { patch.name = name; changes.push("名字"); }
        const duty = filled(params.duty);
        if (duty !== undefined && clampDuty(duty) !== target.duty) { patch.duty = clampDuty(duty); changes.push("职责"); }
        const dutyLong = filled(params.dutyLong);
        if (dutyLong !== undefined && dutyLong !== (target.dutyLong ?? "").trim()) { patch.dutyLong = dutyLong; changes.push("详细职责"); }
        const instructions = filled(params.instructions);
        if (instructions !== undefined && instructions !== target.instructions.trim()) { patch.instructions = instructions; changes.push("说明"); }
        // 模型：填了 ref 沿用这个助手现在的思考档，没有就用全局的；default 是去掉这一项
        const modelSettings = runtime.settings.settings.models;
        const nextModels: NonNullable<Assistant["models"]> = { ...(target.models ?? {}) };
        let modelsGiven = false;
        for (const [key, given, label] of [["conversation", params.conversationModel, "对话模型"], ["work", params.workModel, "任务模型"]] as const) {
          const ref = filled(given);
          if (ref === undefined) continue;
          modelsGiven = true;
          if (ref === "default") delete nextModels[key];
          else nextModels[key] = { ref, thinking: target.models?.[key]?.thinking ?? modelSettings[key].thinking };
          if (JSON.stringify(nextModels[key] ?? null) !== JSON.stringify(target.models?.[key] ?? null)) changes.push(label);
        }
        if (modelsGiven) patch.models = nextModels;
        if (params.abilities) {
          const given = params.abilities as { exec?: unknown; write?: unknown; image?: unknown };
          const abilities = { exec: given.exec !== false, write: given.write !== false, image: given.image !== false };
          if (JSON.stringify(abilities) !== JSON.stringify(target.abilities ?? { exec: true, write: true, image: true })) {
            patch.abilities = abilities;
            changes.push("能力");
          }
        }
        if (params.knowledge !== undefined) {
          if (!Array.isArray(params.knowledge)) return fail("knowledge 要是知识库 id 的列表。");
          const knowledge = [...new Set(params.knowledge.map((item: unknown) => String(item)))];
          if (JSON.stringify(knowledge) !== JSON.stringify(target.knowledge ?? [])) { patch.knowledge = knowledge; changes.push("知识库"); }
        }
        for (const [key, given, label] of [["pinned", params.pinned, "置顶"], ["hidden", params.hidden, "收起"], ["notify", params.notify, "需要确认时通知"]] as const) {
          if (typeof given !== "boolean") continue;
          if (given !== target[key]) { patch[key] = given; changes.push(label); }
        }
        if (!changes.length) return fail("没有要改的项：至少填一项和现在不一样的。");
        const result = await updateAssistant(runtime, id, patch);
        if (result.status !== 200) {
          const message = (result.body as { error?: string }).error ?? "修改失败";
          if (!message.includes("模型")) return fail(message);
          // 模型不在名单里：把能填的列出来
          const usable = runtime.settings.settings.models.roster.map((entry) => entry.ref).filter((ref) => runtime.models.find(ref));
          return fail(`${message}能填的模型：${usable.length ? usable.join("、") : "（现在没有可用的模型）"}`);
        }
        const saved = store.assistant(id)!;
        const done = `已修改助手「${saved.name}」：${changes.join("、")}`;
        await announce({ conversation: done });
        return ok(`${done}。`);
      },
    },
    {
      name: "create_group",
      label: "建群",
      description: "建一个群。",
      parameters: Type.Object({
        name: Type.String({ description: "群名，最多 40 字" }),
        purpose: Type.String({ description: "这个群负责什么，最多 200 字" }),
        members: Type.Array(Type.String(), { description: "成员的助手 id" }),
        ownerId: Type.String({ description: "群主的助手 id，要在成员里" }),
        workflow: Type.Optional(Type.String({ description: "可选，工作方式，填 software（软件开发）；不填是普通群" })),
      }),
      execute: async (_id, params: any) => {
        const workflow = workflowParam(params.workflow);
        if (workflow === false) return fail(`workflow 要填 software（软件开发），普通群不填，收到「${params.workflow}」。`);
        try {
          const group = runtime.groups.create({
            name: params.name,
            purpose: params.purpose,
            members: params.members,
            ownerId: params.ownerId,
            ...(workflow ? { workflow } : {}),
          });
          await announce({ conversation: `已建好群「${group.name}」`, targetGroupId: group.id });
          return ok(`已建好群「${group.name}」（${group.id}）。`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "update_group",
      label: "修改群",
      description: "改一个群，只改填了的项。",
      parameters: Type.Object({
        groupId: Type.String({ description: "群 id" }),
        name: Type.Optional(Type.String({ description: "群名，最多 40 字" })),
        purpose: Type.Optional(Type.String({ description: "这个群负责什么，最多 200 字" })),
        instructions: Type.Optional(Type.String({ description: "本群的补充说明，整段替换" })),
        addMembers: Type.Optional(Type.Array(Type.String(), { description: "要加的成员 id" })),
        removeMembers: Type.Optional(Type.Array(Type.String(), { description: "要减的成员 id" })),
        ownerId: Type.Optional(Type.String({ description: "新群主的助手 id，要在成员里" })),
        workflow: Type.Optional(Type.String({ description: "software 是软件开发，none 是普通群" })),
      }),
      execute: async (_id, params: any) => {
        const id = String(params.groupId ?? "").trim();
        const group = store.group(id);
        if (!group) return fail(`没有这个群：${id}`);
        if (group.parentId) return fail(`${id} 是话题，不是群；改话题名用 manage_topic。`);
        const patch: { name?: unknown; purpose?: unknown; instructions?: unknown; members?: string[]; ownerId?: unknown; workflow?: unknown } = {};
        const changes: string[] = [];
        const name = filled(params.name);
        if (name !== undefined && name !== group.name) { patch.name = name; changes.push("名字"); }
        const purpose = filled(params.purpose);
        if (purpose !== undefined && purpose !== group.purpose) { patch.purpose = purpose; changes.push("负责什么"); }
        if (typeof params.instructions === "string" && params.instructions !== (group.instructions ?? "")) { patch.instructions = params.instructions; changes.push("补充说明"); }
        const added = [...new Set<string>(params.addMembers ?? [])];
        const removed = [...new Set<string>(params.removeMembers ?? [])];
        const addedReal = added.filter((member) => !group.members.includes(member));
        const removedReal = removed.filter((member) => group.members.includes(member));
        let members = [...group.members];
        for (const member of addedReal) members.push(member);
        members = members.filter((member) => !removedReal.includes(member));
        if (addedReal.length || removedReal.length) { patch.members = members; changes.push("成员"); }
        const ownerId = filled(params.ownerId);
        if (ownerId !== undefined && ownerId !== group.ownerId) { patch.ownerId = ownerId; changes.push("群主"); }
        const workflow = workflowParam(params.workflow);
        if (workflow === false) return fail(`workflow 要填 software（软件开发）或 none（普通群），收到「${params.workflow}」。`);
        if (workflow !== undefined && workflow !== (group.workflow ?? null)) { patch.workflow = workflow; changes.push("工作方式"); }
        if (!changes.length) return fail("没有要改的项：至少填一项和现在不一样的。");
        let next: Group;
        try { next = runtime.groups.update(id, patch); }
        catch (error) { return fail(error instanceof Error ? error.message : String(error)); }
        /** 一句一句写改了什么：在群里不用再点群名（"Hob 把写稿搭子拉进了群"），在自己的对话里带上群名 */
        const clauses = (inGroup: boolean) => {
          const list: string[] = [];
          if (changes.includes("名字")) list.push(inGroup ? `把群名改成「${next.name}」` : `把${group.name}改名为「${next.name}」`);
          if (changes.includes("负责什么")) list.push("改了负责什么");
          if (changes.includes("补充说明")) list.push("改了补充说明");
          const who = (ids: string[]) => ids.map(nameOf).join("、");
          if (addedReal.length) list.push(inGroup ? `把${who(addedReal)}拉进了群` : `把${who(addedReal)}拉进${next.name}`);
          if (removedReal.length) list.push(inGroup ? `把${who(removedReal)}移出了群` : `把${who(removedReal)}移出${next.name}`);
          if (changes.includes("群主")) list.push(inGroup ? `群主换成${nameOf(next.ownerId)}` : `把${next.name}的群主换成${nameOf(next.ownerId)}`);
          if (changes.includes("工作方式")) {
            const how = next.workflow === "software" ? "软件开发" : "无";
            list.push(inGroup ? `工作方式改成${how}` : `把${next.name}的工作方式改成${how}`);
          }
          return list.join("；");
        };
        await announce({ conversation: `已${clauses(false)}`, group: { gid: id, text: `${nameOf(assistantId)} ${clauses(true)}` } });
        return ok(`已修改群「${next.name}」：${changes.join("、")}。`);
      },
    },
    {
      name: "manage_topic",
      label: "管理话题",
      description: "开、关、重开或改名任何一个群的话题。",
      parameters: Type.Object({
        action: Type.Unsafe<"open" | "close" | "reopen" | "rename">(Type.String({ description: "open 开新话题，close 关，reopen 重开，rename 改名" })),
        groupId: Type.Optional(Type.String({ description: "open 时填群 id" })),
        topicId: Type.Optional(Type.String({ description: "close、reopen、rename 时填话题 id" })),
        title: Type.Optional(Type.String({ description: "open、rename 时填话题名" })),
        note: Type.Optional(Type.String({ description: "close 时可选，给用户的结论，显示在综合的话题卡上" })),
      }),
      execute: async (_id, params: any) => {
        const action = String(params.action ?? "");
        if (action === "open") {
          const id = String(params.groupId ?? "").trim();
          const group = store.group(id);
          if (!group) return fail(`没有这个群：${id}`);
          const title = String(params.title ?? "").trim();
          if (!title) return fail("title 不能为空：open 时填新话题的名字。");
          // 在自己是群主的那个群的会话里开这个群的话题：用 open_topic，它会带上用户的原话
          const current = groupId ? store.group(groupId) : undefined;
          const here = group.parentId ? group.parentId : (current?.parentId ?? current?.id);
          if (here === group.id && group.ownerId === assistantId) return fail("在这个群开话题用 open_topic，它会把用户的原话转进话题。");
          try {
            const topic = runtime.groups.createTopic(group.id, title, assistantId);
            await announce({ conversation: `已开话题「${topic.name}」`, group: { gid: group.id, text: `${nameOf(assistantId)} 开了话题「${topic.name}」` } });
            return ok(`已开话题「${topic.name}」（${topic.id}）。`);
          } catch (error) {
            return fail(error instanceof Error ? error.message : String(error));
          }
        }
        const topicId = String(params.topicId ?? "").trim();
        const topic = store.group(topicId);
        if (!topic) return fail(`没有这个话题：${topicId}`);
        const host = topic.parentId ?? topic.id;
        try {
          if (action === "close") {
            const project = runtime.projects.active(topicId)[0];
            if (project) return fail(`话题「${topic.name}」里的事项「${project.title}」还没结束，事项由群主「${nameOf(topic.ownerId)}」结束。`);
            const closed = runtime.groups.closeByUser(topicId, params.note);
            await announce({ conversation: `已关闭话题「${closed.name}」`, group: { gid: host, text: `${nameOf(assistantId)} 关闭了话题「${closed.name}」` } });
            return ok(`已关闭话题「${closed.name}」。`);
          }
          if (action === "reopen") {
            const reopened = runtime.groups.reopen(topicId);
            await announce({ conversation: `已重开话题「${reopened.name}」`, group: { gid: host, text: `${nameOf(assistantId)} 重开了话题「${reopened.name}」` } });
            return ok(`已重开话题「${reopened.name}」。`);
          }
          if (action === "rename") {
            if (!topic.parentId) return fail(`${topicId} 是群，不是话题；改群名用 update_group。`);
            const title = String(params.title ?? "").trim();
            if (!title) return fail("title 不能为空：rename 时填新的话题名。");
            const renamed = runtime.groups.update(topicId, { name: title });
            await announce({ conversation: `已把话题改名为「${renamed.name}」`, group: { gid: host, text: `${nameOf(assistantId)} 把话题改名为「${renamed.name}」` } });
            return ok(`已把话题改名为「${renamed.name}」。`);
          }
          return fail(`action 要填 open、close、reopen 或 rename，收到「${action}」。`);
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error));
        }
      },
    },
  ];
  return tools;
}
