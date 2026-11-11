// 自带的「敏捷团队」：第一次启动时建 5 个收起的助手和一个群。
// 只建一次：标记写在 system/seeded.json；用户删了、归档了都不补回来。
// 这 5 个是 hidden，平时从群成员里找；主助手的提示词只列没收起的助手，不会把它们当成转交对象。
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Assistant, Group } from "../../shared/types.ts";
import { archiveAssistantsDir, systemDir } from "./config.ts";
import type { CreateGroupInput } from "./groups.ts";
import type { Store } from "./store.ts";

export interface DevTeamRole {
  id: string;
  name: string;
  sprite: string;
  duty: string;
  dutyLong: string;
}

/** 五个角色，顺序就是群里的成员顺序。 */
export const DEV_TEAM_ROLES: DevTeamRole[] = [
  {
    id: "po",
    name: "产品负责人",
    sprite: "sticky:purple",
    duty: "需求和验收",
    dutyLong: "把用户的想法问清楚，写成需求说明和验收标准，拆成子任务分给合适的成员；做完以后对照验收标准验收。拿不准用户要什么时先问用户。",
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

/** 默认建的那个群：自带的敏捷团队走「软件开发」这一套。 */
export const DEV_TEAM_GROUP = {
  name: "敏捷团队",
  purpose: "软件开发：需求、方案、开发、测试和发布",
  workflow: "software" as const,
};

interface SeededFile {
  devTeam?: boolean;
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
export function seedDevTeam(store: Store, createGroup: (input: CreateGroupInput) => Group): void {
  if (readSeeded(store.home).devTeam) return;
  const taken = takenIds(store);
  const created: string[] = [];
  try {
    const now = new Date().toISOString();
    const ids = DEV_TEAM_ROLES.map((role) => {
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
        instructions: "",
        createdAt: now,
      };
      store.saveAssistant(assistant);
      created.push(id);
      return id;
    });
    createGroup({ ...DEV_TEAM_GROUP, ownerId: ids[0], members: ids });
  } catch (error) {
    for (const id of created) store.deleteAssistant(id);
    console.error("建敏捷团队失败，下次启动再建：", error instanceof Error ? error.message : error);
    return;
  }
  writeSeeded(store.home, { devTeam: true });
}
