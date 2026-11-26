import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { EN } from "../../shared/i18n-en.ts";
// 导入时把前端和服务端各区域的词条并进 EN
import "../../web/src/i18n/en/index.ts";
import "../../server/src/i18n/en/index.ts";

const root = join(process.cwd());
// 本票翻过的样板（只作记录；检查范围是 web/src 里不在 pendingFiles 的全部文件）
const sampleFiles = [
  "web/src/App.tsx",
  "web/src/components/Login.tsx",
  "web/src/util.ts",
  "web/src/components/status-meta.tsx",
  "web/src/components/Home.tsx",
  "web/src/components/Mobile.tsx",
  "web/src/components/Sidebar.tsx",
  "web/src/sprites.tsx",
  "web/src/route.ts",
  "web/src/home.ts",
  "shared/thinking.ts",
  "shared/project.ts",
];
const pendingFiles = [
];

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".test.tsx") && !/^mock(-.*)?\.ts$/.test(entry.name) ? [path] : [];
  });
}

function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function isChinese(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function tKeyCalls(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const keys: string[] = [];
  visit(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "t") return;
    const first = node.arguments[0];
    if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) keys.push(first.text);
  });
  return keys;
}

function stringLiterals(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const values: string[] = [];
  visit(source, (node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && isChinese(node.text)) values.push(node.text);
  });
  return values;
}
function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

function isTCall(node: ts.Node | undefined): node is ts.CallExpression {
  return !!node && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t";
}

/**
 * 中文写在表里、显示时再用 t(变量) 翻的文件（状态名、阶段名、默认内容），以及中文分支直接拼格式的 util。
 * 这些文件的中文字面量算词条（要有英文），不按「必须在 t() 里」查。
 */
const DYNAMIC_FILES = ["server/src/store.ts", "server/src/dev-team.ts", "shared/thinking.ts", "shared/model-note.ts", "web/src/components/status-meta.tsx", "web/src/components/Todos.tsx", "web/src/sprites.tsx", "server/src/cron-text.ts", "web/src/util.ts", "server/src/user-facing.ts"];

/** 不该翻的中文：逐条写原因。 */
const KEEP_CHINESE: Record<string, string> = {
  中文: "语言名用它自己的语言写",
  待你执行: "子任务状态的数据值，用来比较，显示时再翻",
  "https://github.com/FFatTiger/hob#云桌面": "文档链接：地址里的锚点跟着中文文档的标题，不显示也不翻译",
  "最近的对话：": "服务端拼给模型的段头（交给任务、转给别的助手的话），用来把上下文拆出来折起，不是界面文字",
  沉淀技能: "任务沉淀步骤的会话标记，用来识别过程，不是界面文字",
  跑: "活动行里的动词代码，用来比较，显示时再翻",
  空闲: "助手状态的数据值，用来比较，显示时再翻",
  已完成: "子任务状态的数据值，用来比较，显示时再翻",
  "只允许读 Hob 自己的文件": "判断文件是否在允许范围内的错误匹配文本，不能翻译",
  等你确认: "助手状态的数据值，用来比较，显示时再翻",
  等待读取: "任务步骤的数据值，用来比较，显示时再翻",
  排队中: "任务状态的数据值，用来比较，显示时再翻",
  进行中: "任务状态的数据值，用来比较，显示时再翻",
  待确认: "任务状态的数据值，用来比较，显示时再翻",
  受阻: "任务状态的数据值，用来比较，显示时再翻",
  失败: "任务状态的数据值，用来比较，显示时再翻",
  已停止: "任务状态的数据值，用来比较，显示时再翻",
  执行中: "助手状态的数据值，用来比较，显示时再翻",
  "截图-………": "粘贴截图的文件名前缀，是用户看到的真实文件名，跟用户自己的文件一样原样保留",
};

/** 含中文、又不是 t() 第一个参数的字符串、模板和 JSX 文字。 */
function untranslated(file: string): string[] {
  const found: string[] = [];
  visit(parse(file), (node) => {
    let text: string | undefined;
    if (ts.isJsxText(node)) text = node.text.trim();
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) text = [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("…");
    if (!text || !isChinese(text) || text in KEEP_CHINESE) return;
    // 厂商识别表里的中文是用户输入的匹配关键词，并非界面文字。
    if (file.endsWith("/brand-recognition.ts") && ["通义", "智谱", "豆包", "字节跳动", "硅基流动"].includes(text)) return;
    if (isTCall(node.parent) && node.parent.arguments[0] === node) return;
    // import 路径、对象键这类不显示的，AST 上也是字符串，按位置跳过
    if (ts.isImportDeclaration(node.parent) || ts.isPropertyAssignment(node.parent) && node.parent.name === node) return;
    found.push(text);
  });
  return found;
}

/** 模块顶层（不在任何函数里）调用的 t()：切换语言后不会重新翻。 */
function topLevelT(file: string): number {
  let count = 0;
  visit(parse(file), (node) => {
    if (!isTCall(node)) return;
    for (let up: ts.Node | undefined = node.parent; up; up = up.parent) if (ts.isFunctionLike(up)) return;
    count += 1;
  });
  return count;
}

const translatedFiles = () => sourceFiles(join(root, "web/src")).map((file) => relative(root, file)).filter((path) => !pendingFiles.includes(path) && !DYNAMIC_FILES.includes(path) && !path.startsWith("web/src/i18n/"));

describe("translation completeness", () => {
  it("has an English entry for every literal t key and no orphaned entry", () => {
    const files = [...sourceFiles(join(root, "web/src")), ...sourceFiles(join(root, "server/src")), ...sourceFiles(join(root, "shared"))].filter((file) => !file.endsWith("/i18n.ts") && !file.endsWith("/i18n-en.ts"));
    const dynamicFiles = DYNAMIC_FILES.map((path) => join(root, path));
    const used = new Set([...files.flatMap(tKeyCalls), ...dynamicFiles.flatMap(stringLiterals).filter((key) => key in EN)]);
    expect([...used].filter((key) => !(key in EN)), "missing English entries").toEqual([]);
    expect(Object.keys(EN).filter((key) => !used.has(key)), "orphaned English entries").toEqual([]);
  });

  it("keeps Chinese in translated web files inside t()", () => {
    const leftover = translatedFiles().flatMap((path) => untranslated(join(root, path)).map((text) => `${path}: ${text}`));
    expect(leftover, "add t() around these strings, list them in KEEP_CHINESE with a reason, or put the file in pendingFiles").toEqual([]);
  });

  it("does not call t() at module top level", () => {
    const files = [...sourceFiles(join(root, "web/src")), ...sourceFiles(join(root, "shared"))].map((file) => relative(root, file));
    expect(files.filter((path) => topLevelT(join(root, path)) > 0)).toEqual([]);
  });

  it("records later ticket files in one pending list", () => {
    expect(new Set(pendingFiles).size).toBe(pendingFiles.length);
    expect(pendingFiles.every((path) => existsSync(join(root, path)))).toBe(true);
  });
});
