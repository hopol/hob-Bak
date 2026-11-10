import { describe, expect, it } from "vitest";
import { characterKeysym, compositionInput, isPasteShortcut, keyboardKeysym, textInputMethod } from "../src/desktop-input.ts";

describe("云桌面输入", () => {
  it("将字符转成 Unicode 按键", () => {
    expect(characterKeysym("A")).toBe(65);
    expect(characterKeysym("é")).toBe(233);
    expect(characterKeysym("中")).toBe(0x01004e2d);
    expect(characterKeysym("😀")).toBe(0x0101f600);
  });

  it("去重紧随输入法上屏的重复 input", () => {
    expect(compositionInput("中文", "中文")).toBe("");
    expect(compositionInput("", "中文")).toBe("中文");
    expect(compositionInput("中文", "中文a")).toBe("中文a");
  });

  it("按长度和换行选择输入方式", () => {
    expect(textInputMethod("中".repeat(32))).toBe("keys");
    expect(textInputMethod("中".repeat(33))).toBe("paste");
    expect(textInputMethod("你好\n世界")).toBe("paste");
  });

  it("识别 Ctrl 和 Command 粘贴快捷键", () => {
    expect(isPasteShortcut({ key: "v", code: "KeyV", ctrlKey: true, metaKey: false, altKey: false })).toBe(true);
    expect(isPasteShortcut({ key: "м", code: "KeyV", ctrlKey: false, metaKey: true, altKey: false })).toBe(true);
    expect(isPasteShortcut({ key: "v", code: "KeyV", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isPasteShortcut({ key: "v", code: "KeyV", ctrlKey: true, metaKey: false, altKey: true })).toBe(false);
    expect(isPasteShortcut({ key: "v", code: "KeyC", ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
  });

  it("转发方向键和左右修饰键", () => {
    expect(keyboardKeysym({ key: "ArrowLeft", location: 0 })).toBe(0xff51);
    expect(keyboardKeysym({ key: "Control", location: 2 })).toBe(0xffe4);
    expect(keyboardKeysym({ key: "Meta", location: 1 })).toBe(0xffeb);
    expect(keyboardKeysym({ key: "Meta", location: 1 }, true)).toBe(0xffe3);
    expect(keyboardKeysym({ key: "с", code: "KeyC", location: 0, ctrlKey: true })).toBe(0x63);
    expect(keyboardKeysym({ key: "Я", code: "KeyZ", location: 0, metaKey: true }, true)).toBe(0x7a);
  });
});
