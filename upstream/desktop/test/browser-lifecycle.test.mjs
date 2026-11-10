import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../desktopd/server.mjs", import.meta.url), "utf8");
const code = source.slice(source.indexOf("function ensureBrowser("), source.indexOf("// 没在跑的 child"));

test("启动中 stop 和随后 start 必须按顺序完成", async () => {
  const events = [];
  let finishStart;
  const context = {
    browsers: new Map(), shuttingDown: false, HttpError: Error, console, publish: () => {},
    launchBrowser: async (profile, entry) => {
      events.push("start");
      entry.child = {};
      if (events.length === 1) await new Promise((resolve) => { finishStart = resolve; });
      return entry;
    },
    cdpClose: async () => { events.push("close"); },
    waitForExit: async () => true,
    killAndWait: async () => { throw new Error("不应强杀"); },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  const first = context.ensureBrowser("a");
  const stop = context.stopBrowser("a");
  const next = context.ensureBrowser("a");
  assert.deepEqual(events, ["start"]);
  finishStart();
  await Promise.all([first, stop, next]);
  assert.deepEqual(events, ["start", "close", "start"]);
});
