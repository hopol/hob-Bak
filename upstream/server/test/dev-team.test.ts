import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Assistant, HobConfig } from "../../shared/types.ts";
import { archiveAssistant } from "../src/actions.ts";
import { applyEngineEnv } from "../src/boot.ts";
import { DEV_TEAM_GROUP, DEV_TEAM_ROLES, HACKER } from "../src/dev-team.ts";
import { PiHost } from "../src/pi.ts";
import { createRuntime } from "../src/runtime.ts";
import { makeHob, text, waitFor, type TestHob } from "./helpers.ts";

const teamGroup = (hob: TestHob) => {
  const groups = hob.runtime.store.groups();
  expect(groups).toHaveLength(1);
  return groups[0]!;
};

/** 模拟进程重启：同一份 HOB_HOME 再建一次运行时。 */
function restart(hob: TestHob) {
  hob.runtime.router.disposeAll();
  return createRuntime({ home: hob.home, config: hob.runtime.config, pi: hob.runtime.pi });
}

const hiddenAssistants = (store: { assistants: () => Assistant[] }) => store.assistants().filter((assistant) => assistant.hidden);

function legacyAssistant(id: string, name: string): Assistant {
  return {
    id,
    name,
    duty: "老助手",
    sprite: "page",
    primary: false,
    pinned: true,
    hidden: false,
    notify: true,
    createdAt: new Date().toISOString(),
  };
}

describe("自带的敏捷团队", () => {
  it("首次启动建出 5 个收起的助手和一个群：名字、职责、头像、成员顺序都对", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const { store } = hob.runtime;
      for (const role of DEV_TEAM_ROLES) {
        expect(store.assistant(role.id)).toMatchObject({
          name: role.name,
          duty: role.duty,
          dutyLong: role.dutyLong,
          sprite: role.sprite,
          hidden: true,
          pinned: false,
          primary: false,
        });
      }
      expect(hiddenAssistants(store)).toHaveLength(DEV_TEAM_ROLES.length);

      const group = teamGroup(hob);
      expect(group).toMatchObject({
        name: DEV_TEAM_GROUP.name,
        purpose: DEV_TEAM_GROUP.purpose,
        ownerId: "po",
        members: DEV_TEAM_ROLES.map((role) => role.id),
      });
      // 建群那条系统 note 照常写
      expect(hob.runtime.groups.items(group.id).items[0]).toMatchObject({ kind: "note", text: "已创建群「敏捷团队」" });
      // 标记写在系统目录：只建一次
      expect(JSON.parse(readFileSync(join(hob.home, "system", "seeded.json"), "utf8"))).toMatchObject({ devTeam: true });
    } finally {
      hob.close();
    }
  });

  it("再启动不重复建", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const again = restart(hob);
      try {
        expect(hiddenAssistants(again.store)).toHaveLength(DEV_TEAM_ROLES.length);
        expect(again.store.groups()).toHaveLength(1);
        expect(again.store.groups()[0]!.members).toEqual(DEV_TEAM_ROLES.map((role) => role.id));
      } finally {
        again.router.disposeAll();
      }
    } finally {
      hob.close();
    }
  });

  it("归档了其中一个以后不再补回来", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      expect((await archiveAssistant(hob.runtime, "qa")).status).toBe(200);
      expect(hob.runtime.store.assistant("qa")).toBeUndefined();
      // 群里也把它移出了
      expect(teamGroup(hob).members).not.toContain("qa");

      const again = restart(hob);
      try {
        expect(again.store.assistant("qa")).toBeUndefined();
        expect(hiddenAssistants(again.store)).toHaveLength(DEV_TEAM_ROLES.length - 1);
        expect(again.store.groups()).toHaveLength(1);
        expect(again.store.groups()[0]!.members).toHaveLength(DEV_TEAM_ROLES.length - 1);
      } finally {
        again.router.disposeAll();
      }
    } finally {
      hob.close();
    }
  });

  it("id 被占用时不覆盖原来的助手，敏捷团队换一个 id", () => {
    const home = mkdtempSync(join(tmpdir(), "hob-dev-team-"));
    try {
      // 老用户自己建过一个 id 叫 po 的助手
      applyEngineEnv(process.env, home);
      const legacy = legacyAssistant("po", "我的产品助手");
      mkdirSync(join(home, "assistants", "po"), { recursive: true });
      writeFileSync(join(home, "assistants", "po", "profile.json"), JSON.stringify(legacy));
      const config: HobConfig = { passwordHash: "x", cookieSecret: "y", host: "127.0.0.1", port: 0 };
      const runtime = createRuntime({ home, config, pi: new PiHost({ engineDir: join(home, "system", "engine") }) });
      runtime.initializeLocale("zh-CN");
      try {
        expect(runtime.store.assistant("po")).toEqual(legacy);
        expect(hiddenAssistants(runtime.store)).toHaveLength(DEV_TEAM_ROLES.length);
        expect(runtime.store.assistant("po-2")).toMatchObject({ name: "产品负责人", duty: "需求和验收", hidden: true });

        const groups = runtime.store.groups();
        expect(groups).toHaveLength(1);
        const group = groups[0]!;
        expect(group.members).not.toContain("po");
        expect(group.ownerId).toBe(group.members[0]);
        expect(runtime.store.assistant(group.ownerId)).toMatchObject({ name: "产品负责人", hidden: true });
      } finally {
        runtime.router.disposeAll();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("群里的收起助手能被 @ 点名", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      const group = teamGroup(hob);
      hob.faux.setResponses([text("我按验收标准测一遍")]);
      await hob.runtime.groups.send(group.id, { text: "@测试 看一下这个改动" });
      await waitFor(() => hob.runtime.groups.items(group.id).items.some((item) => item.kind === "assistant" && item.speaker === "qa"));
      const replies = hob.runtime.groups.items(group.id).items.filter((item) => item.kind === "assistant");
      expect(replies.map((item) => item.speaker)).toEqual(["qa"]);
    } finally {
      hob.close();
    }
  });
});

describe("自带的 Hacker", () => {
  it("首次启动建出 Hacker，和 Hob 一起置顶", () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      expect(hob.runtime.store.assistant("hacker")).toMatchObject({ name: "Hacker", duty: HACKER.duty, dutyLong: HACKER.dutyLong, sprite: "shield", pinned: true, hidden: false, primary: false });
      // 补充提示词照随包的文件原样写进去（只比相等，不把原文打进测试输出）
      const instructions = readFileSync(new URL("../src/hacker-instructions.md", import.meta.url), "utf8").trim();
      expect(instructions.length > 0 && hob.runtime.store.assistant("hacker")?.instructions === instructions).toBe(true);
      expect(hob.runtime.store.assistants().filter((assistant) => assistant.pinned).map((assistant) => assistant.id).sort()).toEqual(["hacker", "hob"]);
      expect(JSON.parse(readFileSync(join(hob.home, "system", "seeded.json"), "utf8"))).toMatchObject({ devTeam: true, hacker: true });
    } finally {
      hob.close();
    }
  });

  it("删了以后重启不补回来", async () => {
    const hob = makeHob({}, { memory: "off" });
    try {
      hob.runtime.store.deleteAssistant("hacker");
      const again = restart(hob);
      try {
        expect(again.store.assistant("hacker")).toBeUndefined();
      } finally {
        again.router.disposeAll();
      }
    } finally {
      hob.close();
    }
  });

  it("已经有 id 为 hacker 的助手时不覆盖、不另建", () => {
    const home = mkdtempSync(join(tmpdir(), "hob-hacker-"));
    try {
      applyEngineEnv(process.env, home);
      const own = { ...legacyAssistant("hacker", "我的安全助手"), pinned: false, dutyLong: "用户自己写的职责" };
      mkdirSync(join(home, "assistants", "hacker"), { recursive: true });
      writeFileSync(join(home, "assistants", "hacker", "profile.json"), JSON.stringify(own));
      const config: HobConfig = { passwordHash: "x", cookieSecret: "y", host: "127.0.0.1", port: 0 };
      const runtime = createRuntime({ home, config, pi: new PiHost({ engineDir: join(home, "system", "engine") }) });
      runtime.initializeLocale("zh-CN");
      try {
        expect(runtime.store.assistant("hacker")).toEqual(own);
        expect(runtime.store.assistants().some((assistant) => assistant.id.startsWith("hacker-"))).toBe(false);
      } finally {
        runtime.router.disposeAll();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
