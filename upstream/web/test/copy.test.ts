import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// 界面文字规范见 docs/copy.md：用户能看到的文字一律用书面中文，口语词不再出现。
const BANNED = ["干活", "派活", "拍板", "卡住", "没动静", "试一张", "先问你", "直接做"];
// 状态词全站统一成这七个，旧的写法不许再出现。
const OLD_STATUS = ["等你批"];

const ROOT = join(import.meta.dirname, "..", "..");
const WEB_SRC = join(ROOT, "web", "src");
const SERVER_SRC = join(ROOT, "server", "src");


/** 某个目录下全部 .ts / .tsx 源文件。 */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** 这些文件里出现不能出现的词，逐条列出来。 */
function hits(files: string[], words: string[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      for (const word of words) {
        // 模型提示词与工具描述照第三版定稿，不属于界面文案。
        if (file.endsWith("server/src/prompt.ts") && words === BANNED) continue;
        if (file.endsWith("server/src/router-tools.ts") && word === "直接做" && (line.includes("这类事以后可以不再问时") || line.includes("记下用户对某类事的处理方式"))) continue;
        if (file.endsWith("server/src/worker-tools.ts") && word === "拍板" && (line.includes("交结果。做完了") || line.includes("done 要的结果拿到了；stuck"))) continue;
        if (file.endsWith("server/src/worker-tools.ts") && word === "派活" && line.includes("带上数据、链接和文件路径，写给派活的助手。")) continue;
        if (file.endsWith("server/src/prompt.ts") && word === "派活" && line.includes("你的技能是做同类事的做法，派活时可以让任务照着做。")) continue;
        if ((file.endsWith("server/src/router-tools.ts") || file.endsWith("server/src/worker-tools.ts")) && word === "直接做" && (line.includes("同类事以后可以不再问时，填这类事的简称") || line.includes("以后「${remember}」直接做") || line.includes("记下用户对某类事的确认方式：ask 先问，allow 直接做。"))) continue;
        if (file.endsWith("server/src/worker-tools.ts") && word === "拍板" && line.includes("done 做完 / stuck 做不下去（写明缺什么）/ need_approval 需要用户拍板")) continue;
        if (file.endsWith("server/src/jobs.ts") && word === "干活" && line.includes("不能在 Hob 的数据目录里干活；不填 cwd 就在任务自己的目录里做。")) continue;
        if (file.endsWith("server/src/jobs.ts") && word === "派活" && line.includes('"派活时估的"')) continue;
        if (line.includes(word)) found.push(`${relative(ROOT, file)}: ${word} → ${line.trim().slice(0, 60)}`);
      }
    }
  }
  return found;
}

describe("界面文字", () => {
  it("前端不再出现口语词", () => {
    expect(hits(sources(WEB_SRC), BANNED)).toEqual([]);
  });

  it("服务端的提示行、状态、推送、接口错误不再出现口语词", () => {
    expect(hits(sources(SERVER_SRC), BANNED)).toEqual([]);
  });

  it("助手补充说明的提示记录事实而不是做法", () => {
    const files = ["Panel.tsx", "PanelRootDetails.tsx", "Settings.tsx"].map((name) => join(WEB_SRC, "components", name));
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.includes("补充说明") || line.includes("记下这个助手"));
      expect(lines.every((line) => !line.includes("做法"))).toBe(true);
    }
  });

  it("状态词的旧写法已经清掉", () => {
    expect(hits([...sources(WEB_SRC), ...sources(SERVER_SRC)], OLD_STATUS)).toEqual([]);
  });
});
