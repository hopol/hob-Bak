import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../desktopd/server.mjs", import.meta.url), "utf8");
const code = source.slice(source.indexOf("const BUTTONS ="), source.indexOf("function doInput("));
const context = vm.createContext({ width: 1280, height: 800 });
vm.runInContext(code, context);

test("拒绝原型属性作为鼠标按键", () => {
  assert.match(context.validateActions([{ type: "click", x: 0, y: 0, button: "constructor" }]), /button/);
  assert.equal(context.validateActions([{ type: "click", x: 0, y: 0, button: "left" }]), null);
});

test("输入内容不能被解释成 xdotool 参数", () => {
  assert.deepEqual(Array.from(context.actionArgs({ type: "type", text: "--help" })).slice(-2), ["--", "--help"]);
});
