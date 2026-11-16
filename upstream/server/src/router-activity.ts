import { t } from "../../shared/i18n.ts";
import { basename } from "node:path";

/** 把 Router 工具和流式参数压成界面上的一句话。 */
export function activityLabel(name: string, args: Record<string, unknown> = {}, assistantName?: (id: string) => string | undefined): string {
  const value = (key: string) => typeof args[key] === "string" ? (args[key] as string).trim() : "";
  const withValue = (label: string, text: string) => text ? t("{label}：{text}", { label, text }) : label;
  let labelText: string;
  switch (name) {
    case "read": labelText = withValue(t("正在读"), basename(value("path"))); break;
    case "start_job": labelText = withValue(t("派任务"), value("title")); break;
    case "check_job": labelText = t("看任务"); break;
    case "edit_skill": labelText = t("改技能"); break;
    case "reply_job": labelText = t("补充任务要求"); break;
    case "stop_job": labelText = t("停止任务"); break;
    case "ask_user": labelText = t("准备问你"); break;
    case "set_rule": case "remove_rule": labelText = t("改规矩"); break;
    case "create_routine": case "update_routine": case "delete_routine": labelText = withValue(t("设定时任务"), value("name")); break;
    case "send_file": labelText = withValue(t("发文件"), basename(value("path"))); break;
    case "set_avatar": labelText = t("换头像"); break;
    case "create_assistant": labelText = t("新建助手"); break;
    case "message_assistant": { const id = value("assistantId"); labelText = id ? t("交给「{name}」", { name: assistantName?.(id) ?? id }) : t("交给助手"); break; }
    case "hand_back_to_hob": labelText = t("交回 Hob"); break;
    case "show_page": labelText = withValue(t("写页面"), value("title")); break;
    case "find_knowledge": labelText = withValue(t("正在找资料"), value("query")); break;
    case "search_knowledge": labelText = withValue(t("正在查知识库"), value("query")); break;
    case "web_search": labelText = withValue(t("搜索"), value("query")); break;
    case "web_fetch": labelText = t("读取网页"); break;
    case "browser_open": { let target = value("url"); try { target = new URL(target).hostname; } catch { /* 保留原地址 */ } labelText = t("浏览器 · 打开 {target}", { target }); break; }
    case "browser_snapshot": labelText = t("浏览器 · 读取页面"); break;
    case "browser_click": labelText = t("浏览器 · 点击"); break;
    case "browser_type": labelText = t("浏览器 · 输入"); break;
    case "browser_press": labelText = t("浏览器 · 按键"); break;
    case "browser_back": labelText = t("浏览器 · 返回"); break;
    case "browser_screenshot": labelText = t("浏览器 · 截图"); break;
    case "generate_image": labelText = t("画图"); break;
    case "overview": labelText = t("查看工作概况"); break;
    case "read_skill": labelText = withValue(t("看技能"), value("name")); break;
    case "save_job_as_skill": labelText = t("沉淀技能"); break;
    default:
      labelText = /^(memory_write|memory_forget|memory_restore|lore_create_node|lore_update_node|lore_delete_node|lore_move_node)$/.test(name) ? t("记下来")
        : /^(memory_|lore_|scratchpad)/.test(name) ? t("翻记忆") : t("调用工具");
  }
  return [...labelText].length > 24 ? `${[...labelText].slice(0, 23).join("")}…` : labelText;
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
