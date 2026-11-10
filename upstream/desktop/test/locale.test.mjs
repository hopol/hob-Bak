import assert from "node:assert/strict";
import test from "node:test";
import { ensureLocale, LangError, parseLang } from "../desktopd/locale.mjs";

const sources = ["C", "de_DE", "en_GB", "en_US", "ja_JP", "zh_CN", "zh_TW"];
const list = () => sources;

// localedef 的两种用法：--list-archive 列已编好的，-i/-f 生成新的。
function fakeLocaledef({ archive = ["zh_CN.utf8"], failWith = null } = {}) {
  const calls = [];
  const run = (cmd, args) => {
    assert.equal(cmd, "localedef");
    calls.push(args);
    if (args[0] === "--list-archive") return archive.join("\n");
    if (failWith) throw Object.assign(new Error("localedef failed"), { stderr: failWith });
    // 和真 localedef 一样，生成出来的条目在 archive 里叫 en_US.utf8
    archive.push(args[4].replace(/\.UTF-8$/i, ".utf8").toLowerCase());
    return "";
  };
  return { run, calls };
}

test("BCP 47 标签大小写归一，书写系统和地区都保留", () => {
  assert.equal(parseLang("zh-cn").tag, "zh-CN");
  assert.equal(parseLang("EN-us").tag, "en-US");
  assert.equal(parseLang("zh-hant-tw").tag, "zh-Hant-TW");
  assert.equal(parseLang(" ja ").tag, "ja");
});

test("不合法的 DESKTOP_LANG 报错并说清格式", () => {
  for (const bad of ["", "zh_CN", "chinese", "e", "en-US-x-foo", "en-US-1"]) {
    assert.throws(() => parseLang(bad), LangError, bad);
  }
  assert.throws(() => parseLang("zh_CN"), /BCP 47 语言标签，如 zh-CN/);
});

test("已有 locale 时直接用，不重新生成", () => {
  const { run, calls } = fakeLocaledef({ archive: ["zh_CN.utf8", "en_US.utf8"] });
  const r = ensureLocale("en-US", { run, list });
  assert.deepEqual(r, { tag: "en-US", posix: "en_US", LANG: "en_US.UTF-8", LANGUAGE: "en_US:en", acceptLanguage: "en-US,en", generated: false });
  assert.equal(calls.length, 1, "只查一次 --list-archive");
});

test("没有的 locale 在启动时生成", () => {
  const { run, calls } = fakeLocaledef({ archive: ["zh_CN.utf8"] });
  const r = ensureLocale("en-US", { run, list });
  assert.equal(r.generated, true);
  assert.deepEqual(calls[1], ["-i", "en_US", "-f", "UTF-8", "en_US.UTF-8"]);
  assert.deepEqual(calls[2], ["--list-archive"], "生成后再确认一遍");
});

test("生成不了时报错，不悄悄退回中文", () => {
  const { run } = fakeLocaledef({ archive: ["zh_CN.utf8"], failWith: "cannot open locale archive" });
  assert.throws(() => ensureLocale("ja-JP", { run, list }), /生成 ja_JP.UTF-8 失败：cannot open locale archive/);
  assert.throws(() => ensureLocale("ja-JP", { run, list }), /镜像里这个目录归 hob/);
});

test("镜像里没有这门语言的 locale 时报错", () => {
  const { run } = fakeLocaledef();
  assert.throws(() => ensureLocale("fr-FR", { run, list }), /fr_FR/);
});

test("只写语言时用这门语言最靠前的地区", () => {
  const { run } = fakeLocaledef({ archive: ["ja_JP.utf8"] });
  const r = ensureLocale("ja", { run, list });
  assert.equal(r.posix, "ja_JP");
  assert.equal(r.tag, "ja");
  assert.equal(r.LANGUAGE, "ja_JP:ja");
  assert.equal(r.acceptLanguage, "ja");
});

test("中文书写系统只影响标签，locale 用地区名", () => {
  const { run } = fakeLocaledef({ archive: ["zh_TW.utf8"] });
  const r = ensureLocale("zh-Hant-TW", { run, list });
  assert.equal(r.posix, "zh_TW");
  assert.equal(r.tag, "zh-Hant-TW");
  assert.equal(r.LANGUAGE, "zh_TW:zh");
  assert.equal(r.acceptLanguage, "zh-Hant-TW,zh");
});

test("默认是 zh-CN，和以前的中文桌面一致", () => {
  const { run } = fakeLocaledef({ archive: ["zh_CN.utf8"] });
  const r = ensureLocale(undefined, { run, list });
  assert.equal(r.LANG, "zh_CN.UTF-8");
  assert.equal(r.LANGUAGE, "zh_CN:zh");
  assert.equal(r.acceptLanguage, "zh-CN,zh");
});
