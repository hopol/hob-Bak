import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../desktopd/server.mjs", import.meta.url), "utf8");
const queueCode = source.slice(source.indexOf("function doInput("), source.indexOf("// ---------- HTTP / WS ----------"));

test("输入命令失败后队列继续执行", async () => {
  let calls = 0;
  class HttpError extends Error {}
  const screen = { inputQueue: Promise.resolve() };
  const context = { context: { getStore: () => screen }, HttpError, sleep: async () => {}, actionArgs: () => [], run: async () => ({ code: ++calls === 1 ? 1 : 0, err: "failed" }), firstLine: String };
  vm.createContext(context);
  vm.runInContext(queueCode, context);
  await assert.rejects(context.doInput([{ type: "key" }]));
  await context.doInput([{ type: "key" }]);
  assert.equal(calls, 2);
});
