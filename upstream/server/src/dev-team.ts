// 自带的「敏捷团队」：第一次启动时建 5 个收起的助手和一个群。
// 只建一次：标记写在 system/seeded.json；用户删了、归档了都不补回来。
// 这 5 个是 hidden，平时从群成员里找；主助手的提示词只列没收起的助手，不会把它们当成转交对象。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Locale } from "../../shared/i18n.ts";
import { t } from "../../shared/i18n.ts";
import type { Assistant, Group } from "../../shared/types.ts";
import { archiveAssistantsDir, systemDir } from "./config.ts";
import type { CreateGroupInput } from "./groups.ts";
import type { Store } from "./store.ts";
import type { PluginStore } from "./plugin-store.ts";

export interface DevTeamRole {
  id: string;
  name: string;
  sprite: string;
  duty: string;
  dutyLong: string;
}

/** 产品负责人的详细职责。 */
export const PRODUCT_OWNER_DUTY = "接住用户和定时任务带来的事，按分量安排：一个任务能完成的，自己分派任务或者请合适的成员执行，结果回来核对后再告诉用户；要几个人接力的，创建一个话题，在里面安排，完成后给用户一个结论。";

/** 179 之前的默认详细职责：启动时一字不差是它的，换成上面那句；用户改过的不动。 */
const OLD_PRODUCT_OWNER_DUTY = "把用户的想法问清楚，写成需求说明和验收标准，拆成子任务分给合适的成员；做完以后对照验收标准验收。拿不准用户要什么时先问用户。";

/** 五个角色，顺序就是群里的成员顺序。 */
export const DEV_TEAM_ROLES: DevTeamRole[] = [
  {
    id: "po",
    name: "产品负责人",
    sprite: "sticky:purple",
    duty: "需求和验收",
    dutyLong: PRODUCT_OWNER_DUTY,
  },
  {
    id: "architect",
    name: "架构师",
    sprite: "blocks:slate",
    duty: "技术方案",
    dutyLong: "定技术方案和模块边界，评估改动的影响和风险，审查关键代码。",
  },
  {
    id: "dev",
    name: "开发",
    sprite: "code:green",
    duty: "写代码",
    dutyLong: "按子任务写代码和测试，做完说明改了什么、怎么验证的。",
  },
  {
    id: "qa",
    name: "测试",
    sprite: "bug:red",
    duty: "测试和验证",
    dutyLong: "对照验收标准测试，发现问题写清复现步骤和实际结果。",
  },
  {
    id: "release",
    name: "发布",
    sprite: "rocket:orange",
    duty: "发布和上线",
    dutyLong: "打包、部署、发版；上线后确认服务正常，出问题时回滚。",
  },
];

/** 启动时把产品负责人的旧默认职责换成新的一句；用户自己改过的、别的助手的都不动。 */
export function migrateProductOwnerDuty(store: Store): void {
  const oldChinese = OLD_PRODUCT_OWNER_DUTY;
  const oldEnglish = t(OLD_PRODUCT_OWNER_DUTY, {}, "en");
  for (const assistant of store.assistants()) {
    const current = (assistant.dutyLong ?? "").trim();
    if (current !== oldChinese && current !== oldEnglish) continue;
    const dutyLong = t(PRODUCT_OWNER_DUTY, {}, current === oldEnglish ? "en" : "zh-CN");
    store.saveAssistant({ ...assistant, dutyLong });
  }
}

/** 自带的 Hacker：和 Hob 一起置顶，安全和逆向的事找它。补充提示词随包带在 hacker-instructions.md，建的时候原样写进去。 */
export const HACKER = {
  id: "hacker",
  name: "Hacker",
  sprite: "shield",
  duty: "安全与逆向",
  dutyLong: "安全研究、逆向分析、抓包和调试：分析程序、协议和数据格式，读二进制和内存，写验证用的脚本。",
};

/**
 * 建一次 Hacker（老用户升级后也补上）。已经有 id 为 hacker 的助手（包括归档了的）就不再建，只记下标记；
 * 用户删了也不补回来。
 */
export function seedHacker(store: Store, locale: Locale): void {
  if (readSeeded(store.home).hacker) return;
  if (!takenIds(store).has(HACKER.id)) {
    store.saveAssistant({
      id: HACKER.id,
      name: HACKER.name,
      duty: t(HACKER.duty, {}, locale),
      dutyLong: t(HACKER.dutyLong, {}, locale),
      sprite: HACKER.sprite,
      instructions: readFileSync(new URL("./hacker-instructions.md", import.meta.url), "utf8").trim(),
      primary: false,
      pinned: true,
      hidden: false,
      notify: true,
      createdAt: new Date().toISOString(),
    });
  }
  writeSeeded(store.home, { hacker: true });
}

export function seedBuiltinVault(plugins: PluginStore, onUpdated?: (id: string) => void): void {
  // 自带密码库跟着 Hob 版本走：装着的是自带的那份、Hob 带了新版本时，启动就换上（install 在版本没变时什么都不做）
  const installed = plugins.list().find(plugin => plugin.id === "vault" && plugin.source === "builtin");
  if (installed) {
    try { if (plugins.install("vault", true).version !== installed.version) onUpdated?.("vault"); }
    catch (error) { console.error("更新自带密码库失败，下次启动再试：", error instanceof Error ? error.message : error); }
  }
  const seeded = readSeeded(plugins.home);
  if (seeded.vault) return;
  if (plugins.list().some(plugin => plugin.id === "vault")) {
    writeSeeded(plugins.home, { vault: true });
    return;
  }
  try {
    plugins.install("vault");
    writeSeeded(plugins.home, { vault: true });
  } catch (error) {
    console.error("安装自带密码库失败，下次启动再试：", error instanceof Error ? error.message : error);
  }
}

export const DEFAULT_BUNDLED_PLUGINS = ["github"] as const;

export function defaultPluginsRoot(): string {
  return fileURLToPath(new URL("../../vendor/default-plugins", import.meta.url));
}

export function markDefaultPluginUninstalled(home: string, id: string): void {
  const seeded = readSeeded(home);
  const existing = seeded.plugins ?? {};
  const isDefault = (DEFAULT_BUNDLED_PLUGINS as readonly string[]).includes(id);
  if (!isDefault && !Object.hasOwn(existing, id)) return;
  if (existing[id] === "uninstalled") return;
  writeSeeded(home, { plugins: { ...existing, [id]: "uninstalled" } });
}

export function seedDefaultPlugins(
  plugins: PluginStore,
  options: { root?: string; ids?: readonly string[] } = {},
): void {
  const root = options.root ?? defaultPluginsRoot();
  const ids = options.ids ?? DEFAULT_BUNDLED_PLUGINS;
  const seeded = readSeeded(plugins.home);
  const recorded: Record<string, "installed" | "uninstalled"> = { ...(seeded.plugins ?? {}) };
  let changed = false;
  for (const id of ids) {
    if (recorded[id]) continue;
    if (plugins.list().some((plugin) => plugin.id === id)) {
      recorded[id] = "installed";
      changed = true;
      continue;
    }
    const sourceDir = join(root, id);
    if (!existsSync(join(sourceDir, "plugin.json"))) continue;
    try {
      plugins.installBundled(id, sourceDir);
      recorded[id] = "installed";
      changed = true;
    } catch (error) {
      console.error(`安装默认自带插件 ${id} 失败，下次启动再试：`, error instanceof Error ? error.message : error);
    }
  }
  if (changed) writeSeeded(plugins.home, { plugins: recorded });
}

/** 默认建的那个群：自带的敏捷团队走「软件开发」这一套。 */
export const DEV_TEAM_GROUP = {
  name: "敏捷团队",
  purpose: "软件开发：需求、方案、开发、测试和发布",
};

export function devTeamRoles(locale: Locale): DevTeamRole[] {
  if (locale === "zh-CN") return DEV_TEAM_ROLES;
  return DEV_TEAM_ROLES.map((role) => ({
    ...role,
    name: t(role.name, {}, locale),
    duty: t(role.duty, {}, locale),
    dutyLong: t(role.dutyLong, {}, locale),
  }));
}

export function devTeamGroup(locale: Locale) {
  return {
    ...DEV_TEAM_GROUP,
    name: t(DEV_TEAM_GROUP.name, {}, locale),
    purpose: t(DEV_TEAM_GROUP.purpose, {}, locale),
  };
}

interface SeededFile {
  devTeam?: boolean;
  hacker?: boolean;
  vault?: boolean;
  plugins?: Record<string, "installed" | "uninstalled">;
}

function seededPath(home: string): string {
  return join(systemDir(home), "seeded.json");
}

function readSeeded(home: string): SeededFile {
  const path = seededPath(home);
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return value && typeof value === "object" ? (value as SeededFile) : {};
  } catch (error) {
    throw new Error(`读取 ${path} 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** 记住别的键，只把 devTeam 标上（和设置文件一样的临时文件 + rename）。 */
function writeSeeded(home: string, value: SeededFile): void {
  const path = seededPath(home);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...readSeeded(home), ...value }, null, 2)}\n`);
  renameSync(tmp, path);
}

/** 已经在用的 id：还在的助手和归档了的助手都算，复用会和归档目录里的同名 id 撞上。 */
function takenIds(store: Store): Set<string> {
  const taken = new Set(store.assistants().map((assistant) => assistant.id));
  const root = archiveAssistantsDir(store.home);
  if (!existsSync(root)) return taken;
  for (const folder of readdirSync(root)) {
    try {
      const profile = JSON.parse(readFileSync(join(root, folder, "profile.json"), "utf8")) as { id?: unknown };
      if (typeof profile.id === "string") taken.add(profile.id);
    } catch {
      // 归档目录里没有档案或读不出来：跳过，不影响这次启动
    }
  }
  return taken;
}

/** 想用的 id 被占了就往后加 -2、-3…，不覆盖别人的助手。 */
function freeId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * 首次启动带上敏捷团队。建群走 GroupManager.create（那条「建了群」的系统 note 照常写）。
 * 中途失败就把这次建的助手撤掉、标记不写，下次启动重来，不留半套。
 */
export function seedDevTeam(store: Store, createGroup: (input: CreateGroupInput) => Group, locale: Locale): void {
  if (readSeeded(store.home).devTeam) return;
  const roles = devTeamRoles(locale);
  const group = devTeamGroup(locale);
  const taken = takenIds(store);
  const created: string[] = [];
  try {
    const now = new Date().toISOString();
    const ids = roles.map((role) => {
      const id = freeId(role.id, taken);
      taken.add(id);
      const assistant: Assistant = {
        id,
        name: role.name,
        duty: role.duty,
        dutyLong: role.dutyLong,
        sprite: role.sprite,
        primary: false,
        pinned: false,
        hidden: true,
        notify: true,
        createdAt: now,
      };
      store.saveAssistant(assistant);
      created.push(id);
      return id;
    });
    createGroup({ ...group, ownerId: ids[0], members: ids });
  } catch (error) {
    for (const id of created) store.deleteAssistant(id);
    console.error("建敏捷团队失败，下次启动再建：", error instanceof Error ? error.message : error);
    return;
  }
  writeSeeded(store.home, { devTeam: true });
}
