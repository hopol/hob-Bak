// 部署时定的语言：DESKTOP_LANG 填 BCP 47 语言标签，换成桌面程序用的 POSIX locale
// （LANG/LANGUAGE）和浏览器用的语言标签（--lang / --accept-lang）。
// 对应的 xx_RR.UTF-8 没编进 glibc 时在这里生成；localedef 写 /usr/lib/locale，镜像里这个目录归 hob。
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const LOCALE_SOURCES = "/usr/share/i18n/locales";
const DEFAULT_LANG = "zh-CN";
// 语言 2-3 个字母，可选 4 字母书写系统，可选 2 字母 / 3 字母地区，按 BCP 47 的顺序用 "-" 连。
const TAG = /^([A-Za-z]{2,3})(?:-([A-Za-z]{4}))?(?:-([A-Za-z]{2}|[0-9]{3}))?$/;

/** DESKTOP_LANG 不合法，或者这个语言在镜像里怎么做都做不出来。 */
export class LangError extends Error {}

/** 把 DESKTOP_LANG 解析成 { tag, lang, script, region }；不合法时抛错，说清要什么格式。 */
export function parseLang(raw) {
  const value = String(raw ?? "").trim();
  const m = TAG.exec(value);
  if (!m) throw new LangError(`无效的 DESKTOP_LANG "${raw}"（要 BCP 47 语言标签，如 zh-CN、en-US、ja-JP）`);
  const lang = m[1].toLowerCase();
  const script = m[2] ? m[2][0].toUpperCase() + m[2].slice(1).toLowerCase() : "";
  const region = m[3] ? m[3].toUpperCase() : "";
  return { tag: [lang, script, region].filter(Boolean).join("-"), lang, script, region };
}

// glibc 的 locale 名是 ll_RR（中文书写系统不参与命名：zh-Hant-TW → zh_TW）。
// 没写地区时用语言名本身（glibc 里没有单独的 ja），再退到这门语言排在最前的地区。
function pickSource({ lang, region }, list) {
  const names = list()
    .filter((n) => !n.includes(".") && !n.includes("@"))
    .sort();
  const wants = region ? [`${lang}_${region}`] : [lang];
  if (!region) wants.push(...names.filter((n) => n.startsWith(`${lang}_`)));
  const hit = wants.find((n) => names.includes(n));
  if (!hit) {
    throw new LangError(
      `DESKTOP_LANG 没有对应的 locale：${lang}${region ? `_${region}` : ""}（${LOCALE_SOURCES} 里没有；要 glibc 支持的写法，如 zh-CN、en-US、ja-JP）`
    );
  }
  return hit;
}

// glibc 里已编好的 locale（zh_CN.utf8 这种）；只看 UTF-8 的条目。
function compiledPosix(run) {
  const list = run("localedef", ["--list-archive"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const set = new Set();
  for (const line of String(list).split("\n")) {
    const [name, codeset] = line.trim().toLowerCase().split(".");
    if (name && (codeset === undefined || codeset === "utf8")) set.add(name);
  }
  return set;
}

/**
 * 解析 DESKTOP_LANG 并保证对应 locale 已生成。
 * 返回值：LANG / LANGUAGE 给所有子进程用，tag 给浏览器 --lang，acceptLanguage 给 --accept-lang。
 */
export function ensureLocale(raw = DEFAULT_LANG, { run = execFileSync, list = () => fs.readdirSync(LOCALE_SOURCES) } = {}) {
  const { tag, lang, region } = parseLang(raw);
  const posix = pickSource({ lang, region }, list);
  const result = { tag, posix, LANG: `${posix}.UTF-8`, LANGUAGE: `${posix}:${posix.split("_")[0]}`, acceptLanguage: tag === lang ? tag : `${tag},${lang}`, generated: false };
  if (compiledPosix(run).has(posix.toLowerCase())) return result;
  let stderr = "";
  try {
    // 用 C locale 跑：这台机器的目标语言可能正好还没生成，gettext 会退回 ASCII 把报错变成乱码
    run("localedef", ["-i", posix, "-f", "UTF-8", result.LANG], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, LANG: "C", LANGUAGE: "", LC_ALL: "C" } });
  } catch (e) {
    stderr = String(e?.stderr || e?.message || e).trim();
    throw new LangError(`生成 ${result.LANG} 失败：${stderr.split("\n")[0] || "localedef 出错"}（localedef 要写 /usr/lib/locale，镜像里这个目录归 hob；自己改了镜像权限时要注意）`);
  }
  if (!compiledPosix(run).has(posix.toLowerCase())) throw new LangError(`生成 ${result.LANG} 后仍然找不到这个 locale（localedef 没有报错但结果不在 /usr/lib/locale）`);
  return { ...result, generated: true };
}

// 命令行用：node desktopd/locale.mjs 生成缺的 locale 并打印结果，出错时退出码 1（调试和脚本用）。
// 写回调里再退出：写进管道的数据留到下一个 tick 会丢。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const r = ensureLocale(process.env.DESKTOP_LANG || DEFAULT_LANG);
    process.stdout.write(`desktopd: 语言 ${r.tag} → ${r.LANG}${r.generated ? "（本次生成）" : ""}\n`, () => process.exit(0));
  } catch (e) {
    process.stderr.write(`desktopd: ${e.message}\n`, () => process.exit(1));
  }
}
