import { basename } from "node:path";

/** 把 Router 工具和流式参数压成界面上的一句话。 */
export function activityLabel(name: string, args: Record<string, unknown> = {}, assistantName?: (id: string) => string | undefined): string {
  const value = (key: string) => typeof args[key] === "string" ? (args[key] as string).trim() : "";
  const withValue = (label: string, text: string) => text ? `${label}：${text}` : label;
  let label: string;
  switch (name) {
    case "read": label = withValue("正在读", basename(value("path"))); break;
    case "start_job": label = withValue("派任务", value("title")); break;
    case "check_job": label = "看任务"; break;
    case "edit_skill": label = "改技能"; break;
    case "reply_job": label = "补充任务要求"; break;
    case "stop_job": label = "停止任务"; break;
    case "ask_user": label = "准备问你"; break;
    case "set_rule": case "remove_rule": label = "改规矩"; break;
    case "create_routine": case "update_routine": case "delete_routine": label = withValue("设定时任务", value("name")); break;
    case "send_file": label = withValue("发文件", basename(value("path"))); break;
    case "set_avatar": label = "换头像"; break;
    case "create_assistant": label = "新建助手"; break;
    case "message_assistant": { const id = value("assistantId"); label = id ? `交给「${assistantName?.(id) ?? id}」` : "交给助手"; break; }
    case "hand_back_to_hob": label = "交回 Hob"; break;
    case "show_page": label = withValue("写页面", value("title")); break;
    case "find_knowledge": label = withValue("正在找资料", value("query")); break;
    case "search_knowledge": label = withValue("正在查知识库", value("query")); break;
    case "web_search": label = withValue("搜索", value("query")); break;
    case "web_fetch": label = "读取网页"; break;
    case "browser_open": { let target = value("url"); try { target = new URL(target).hostname; } catch { /* 保留原地址 */ } label = `浏览器 · 打开 ${target}`; break; }
    case "browser_snapshot": label = "浏览器 · 读取页面"; break;
    case "browser_click": label = "浏览器 · 点击"; break;
    case "browser_type": label = "浏览器 · 输入"; break;
    case "browser_press": label = "浏览器 · 按键"; break;
    case "browser_back": label = "浏览器 · 返回"; break;
    case "browser_screenshot": label = "浏览器 · 截图"; break;
    case "generate_image": label = "画图"; break;
    case "overview": label = "查看工作概况"; break;
    case "read_skill": label = withValue("看技能", value("name")); break;
    case "save_job_as_skill": label = "沉淀技能"; break;
    default:
      label = /^(memory_write|memory_forget|memory_restore|lore_create_node|lore_update_node|lore_delete_node|lore_move_node)$/.test(name) ? "记下来"
        : /^(memory_|lore_|scratchpad)/.test(name) ? "翻记忆" : "调用工具";
  }
  return [...label].length > 24 ? `${[...label].slice(0, 23).join("")}…` : label;
}

/**
 * 思考中那一行：模型当前思考的最后一段压成一行（照 Pix 的 Codex 模式，只在想的时候显示，不进对话记录）。
 * 最后一段太短（如「写吧。」）就带上前一段；太长就留最新的尾巴，前面用 … 代替。
 */
export function thinkingLine(thinking: string): string | undefined {
  const parts = thinking
    .split(/\n+/)
    .map((part) => part.replace(/^\s*(?:[-*#>]+|\d+[.)])\s*/, "").replace(/\*\*|__|`/g, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let line = parts.pop();
  if (!line) return undefined;
  while ([...line].length < 12 && parts.length) line = `${parts.pop()} ${line}`;
  const chars = [...line];
  return chars.length > 110 ? `…${chars.slice(-109).join("")}` : line;
}
