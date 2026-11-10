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
