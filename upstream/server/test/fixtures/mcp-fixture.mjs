// 最小的 stdio MCP 假服务：按行读 JSON-RPC，应答 initialize / tools/list / tools/call。
// 测试 mcp.json 探测和任务会话用；stderr 里写一行日志供 stderr 尾部断言。
const LATEST = "2025-11-25";

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const TOOLS = [
  {
    name: "echo",
    description: process.env.HOB_MCP_DESCRIPTION ?? "原样返回 message",
    inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  },
  {
    name: "fail",
    description: "总是失败",
    inputSchema: { type: "object", properties: {} },
  },
];
if (process.env.HOB_MCP_NEVER === "1") TOOLS.push({ name: "hang", description: "挂起的测试查询", inputSchema: { type: "object", properties: {} } });

if (process.env.HOB_MCP_MANY === "1") {
  for (let i = 0; i < 12; i++) TOOLS.push({ name: `extra_${i}`, description: `Extra test operation ${i}`, inputSchema: { type: "object", properties: {} } });
}

if (process.env.HOB_MCP_COLLISIONS === "1") {
  TOOLS.push({ name: "search", description: "Search fixture", inputSchema: { type: "object", properties: {} } });
  TOOLS.push({ name: "x".repeat(70), description: "Long name fixture", inputSchema: { type: "object", properties: {} } });
}

if (process.env.HOB_MCP_SLOW) {
  TOOLS.push({ name: "instance", description: "Return process ID", inputSchema: { type: "object", properties: {} } });
  TOOLS.push({ name: "slow", description: "Complete after a delay", inputSchema: { type: "object", properties: {} } });
}

if (process.env.HOB_MCP_CARDS === "1") {
  TOOLS.push({
    name: "show_card",
    description: "显示一张凭据卡片",
    inputSchema: { type: "object", properties: {} },
  });
  TOOLS.push({
    name: "save_callback",
    description: "保存卡片内容",
    inputSchema: { type: "object", properties: { card_id: { type: "string" }, action: { type: "object" } } },
    _meta: { ui: { visibility: ["app"] } },
  });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});

function handle(message) {
  if (message.method === "initialize") {
    write({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? LATEST,
        capabilities: { tools: {} },
        serverInfo: { name: "hob-fixture", version: "1.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") return;
  if (message.method === "tools/list") {
    write({ jsonrpc: "2.0", id: message.id, result: { tools: TOOLS } });
    return;
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    if (name === "hang" && process.env.HOB_MCP_NEVER === "1") return;
    if (name === "instance" && process.env.HOB_MCP_SLOW) {
      write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: String(process.pid) }] } });
      return;
    }
    if (name === "slow" && process.env.HOB_MCP_SLOW) {
      setTimeout(() => write({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "finished" }] } }), 300);
      return;
    }
    if (name === "save_callback" && process.env.HOB_MCP_CARDS === "1") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "已保存到插件" }],
          _meta: {
            "hob/card": { header: { title: "已保存" }, body: { elements: [{ tag: "div", text: "保存成功" }] } },
            "hob/toast": { type: "success", content: "保存成功" },
          },
        },
      });
      return;
    }
    if (name === "show_card" && process.env.HOB_MCP_CARDS === "1") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          content: [{ type: "text", text: "请填写凭据" }],
          _meta: {
            "hob/card": {
              config: { callback_tool: "save_callback" },
              header: { title: "保存凭据" },
              body: { elements: [{ tag: "form", name: "credential", elements: [{ tag: "input", name: "secret", label: "密码", input_type: "password" }, { tag: "button", text: "保存", form_action_type: "submit" }] }] },
            },
          },
        },
      });
      return;
    }
    if (name === "echo") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: `echo: ${message.params?.arguments?.message ?? ""}` }] },
      });
      return;
    }
    if (name === "fail") {
      write({
        jsonrpc: "2.0",
        id: message.id,
        result: { content: [{ type: "text", text: "工具执行失败" }], isError: true },
      });
      return;
    }
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `unknown tool ${name}` } });
    return;
  }
  if (message.id !== undefined) {
    write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
  }
}

process.stderr.write("hob-fixture mcp server started\n");
