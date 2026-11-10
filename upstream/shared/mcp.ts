// MCP（Model Context Protocol）服务的契约：设置 → MCP 页和 REST 接口共用。
// 配置文件就是引擎读的那份 HOB_HOME/engine/mcp.json；说明见 docs/architecture.md 的 MCP 一节。

/** 服务里每个工具怎么给模型：direct = 直接提供；deferred = 按需搜索。 */
export type McpExposureChoice = "direct" | "deferred";

/**
 * 环境变量 / 请求头的值：密钥永不回传。redacted = 只知道「已设置」；
 * 整值 `${VAR}` 引用或 `!command` 不含密钥，原样回显。
 */
export interface McpSecretValue {
  redacted: boolean;
  value?: string;
}

/** GET /api/mcp：列表里的一项（不含密钥明文）。valid = false 表示手改坏了，只可编辑或删除。 */
export interface McpServerView {
  name: string;
  valid: boolean;
  invalidReason?: string;
  kind?: "stdio" | "http";
  enabled: boolean;
  exposure: McpExposureChoice;
  description?: string;
  /** 本地命令（stdio） */
  command?: string;
  args?: string[];
  env?: Record<string, McpSecretValue>;
  cwd?: string;
  /** 远程地址（streamable HTTP） */
  url?: string;
  headers?: Record<string, McpSecretValue>;
  /** 单独关掉的工具名（toolExposure 里设为 hidden 的） */
  hiddenTools?: string[];
}

/** GET /api/mcp。 */
export interface McpView {
  servers: McpServerView[];
}

/** POST /api/mcp/:name/test（失败也是 200，原因在这里）。 */
export type McpTestResult =
  | { ok: true; tools: { name: string; description: string }[] }
  | { ok: false; state: "failed" | "needs_auth"; error: string; stderrTail: string[] };

/** 环境变量 / 请求头逐键的改法：保留已存的值 / 删除 / 换成新值。 */
export type McpSecretMutation = { mode: "preserve" } | { mode: "remove" } | { mode: "replace"; value: string };

/** PUT /api/mcp/:name：新建或改一个服务。提供方式、启用状态不在这里改。 */
export interface McpServerSave {
  kind: "stdio" | "http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  description?: string;
  env?: Record<string, McpSecretMutation>;
  headers?: Record<string, McpSecretMutation>;
}

/** PATCH /api/mcp/:name：启用开关、提供方式、单独关掉的工具（完整列表，全量替换）。 */
export interface McpServerPatch {
  enabled?: boolean;
  exposure?: McpExposureChoice;
  hiddenTools?: string[];
}

/** GET /api/mcp/import：本机其他客户端里配的 MCP 服务（只读来源文件）。 */
export interface McpImportItem {
  /** 勾选时回传的标识：来源:服务名 */
  id: string;
  name: string;
  source: "pi" | "claude" | "cursor";
  kind?: "stdio" | "http";
  exists: boolean; // Hob 里已有同名（- 和 _ 视为同名），导入会跳过
  selectable: boolean;
  note?: string; // 不可选的原因
}

export interface McpImportView {
  /** 读了哪些位置（界面显示用） */
  sources: string[];
  items: McpImportItem[];
}

/** POST /api/mcp/import {ids}。 */
export interface McpImportResult {
  imported: string[];
  skipped: string[]; // 跳过的，带说明
}
