import { describe, expect, it } from "vitest";
import {
  COLOR_IDS,
  customSprite,
  distinctSprite,
  FLAME,
  parseSprite,
  PROP_IDS,
  PROPS,
  spriteArt,
  spriteId,
  validateCustomProp,
} from "../../shared/sprites.ts";
import type { Assistant, Draft } from "../../shared/types.ts";
import { createFromDraft } from "../src/actions.ts";
import { createApp } from "../src/http.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import { buildRouterTools } from "../src/router-tools.ts";
import { call, makeHob, text } from "./helpers.ts";

describe("头像数据", () => {
  it("道具 id 和「道具:颜色」都认；自画的记成 custom / custom:颜色；其它一律不认", () => {
    expect(parseSprite("server")).toEqual({ prop: "server", color: "slate" });
    expect(parseSprite("hob")).toEqual({ prop: "hob", color: "orange" });
    expect(parseSprite("wifi:green")).toEqual({ prop: "wifi", color: "green" });
    expect(parseSprite("custom")).toEqual({ prop: "custom", color: "orange" });
    expect(parseSprite("custom:teal")).toEqual({ prop: "custom", color: "teal" });
    expect(parseSprite("custom:bogus")).toBeUndefined();
    expect(customSprite("orange")).toBe("custom");
    expect(customSprite("teal")).toBe("custom:teal");
    expect(spriteId("wifi", PROPS.wifi.color)).toBe("wifi");
    expect(spriteId("wifi", "green")).toBe("wifi:green");
    for (const bad of ["img:img-abc123.png", "nope", "wifi:nocolor", "wifi:green:x", "", "constructor", "toString:green", "__proto__"]) {
      expect(parseSprite(bad)).toBeUndefined();
    }
  });

  it("每件道具每种颜色都画得出 16×16，颜色都有定义，两只眼睛不被道具挡住", () => {
    const eyes = FLAME.join("").split("e").length - 1;
    for (const prop of PROP_IDS) {
      for (const color of COLOR_IDS) {
        const art = spriteArt(spriteId(prop, color));
        expect(art.rows).toHaveLength(16);
        for (const row of art.rows) {
          expect(row).toHaveLength(16);
          for (const ch of row) if (ch !== ".") expect(art.pal[ch], `${prop}:${color} 的 ${ch}`).toBeDefined();
        }
        expect(art.rows.join("").split("e").length - 1, `${prop} 挡住了眼睛`).toBe(eyes);
      }
    }
    // 认不出的画成空手火苗，不报错
    expect(spriteArt("img:img-abc123.png").rows.join("")).toBe(spriteArt("hob:slate").rows.join(""));
  });

  it("撞了头像换成这件道具还没人用的颜色，不给橙色；自画的图案各不相同，不算撞", () => {
    expect(distinctSprite("server", ["hob", "bird"])).toBe("server");
    expect(distinctSprite("server", ["server"])).toBe("server:red");
    // 写法不同也算撞：server 就是 server:slate
    expect(distinctSprite("server:slate", ["server", "server:red"])).toBe("server:pink");
    expect(distinctSprite("hob", ["hob"])).toBe("hob:red");
    expect(distinctSprite("nope", ["nope"])).toBe("nope");
    expect(distinctSprite("custom", ["custom", "custom:green"])).toBe("custom");
    expect(distinctSprite("custom:green", ["custom"])).toBe("custom:green");
  });

  it("自画道具校验：合法通过，每条违规都拒并给出能照着改的原因", () => {
    const good = {
      art: ["................", ".....kkkk.......", "....kwwwwk......", "....kwwwwk......", ".....kkkk......."],
      pal: { w: "#ffffff" },
      dx: 2,
    };
    expect(validateCustomProp(good)).toEqual({ ok: true, prop: good });
    expect(validateCustomProp({ ...good, dx: 0 }).ok).toBe(true);
    // 描边色不用进 pal，直态算像素
    expect(validateCustomProp({ art: [".kkkkkkkkkkkkkk.", ".kkkkkkkkkkkkkk."], pal: {}, dx: 1 }).ok).toBe(true);

    const bad: [unknown, string][] = [
      [null, "要是一个对象"],
      [["...."], "要是一个对象"],
      [{ ...good, art: [] }, "非空的字符串数组"],
      [{ ...good, art: [...good.art, ...good.art, ...good.art, "................", "................"] }, "最多 16 行"],
      [{ ...good, art: ["...............16"] }, "要正好 16 个字符"],
      [{ ...good, art: ["..Z............Z"] }, "「Z」没有在 pal 里定义"],
      [{ ...good, pal: { W: "#ffffff" } }, "单个小写字母"],
      [{ ...good, pal: { ww: "#ffffff" } }, "单个小写字母"],
      [{ ...good, pal: { o: "#123456" } }, "火苗自己的颜色"],
      [{ ...good, pal: { y: "#123456" } }, "火苗自己的颜色"],
      [{ ...good, pal: { e: "#123456" } }, "火苗自己的颜色"],
      [{ ...good, pal: { k: "#123456" } }, "描边色是固定的"],
      [{ ...good, pal: { w: "#fff" } }, "#rrggbb"],
      [{ ...good, pal: { w: "white" } }, "#rrggbb"],
      [{ ...good, pal: { a: "#111111", b: "#222222", c: "#333333", d: "#444444", f: "#555555", g: "#666666", h: "#777777", w: "#ffffff" } }, "最多 6 种颜色"],
      [{ ...good, art: ["....kk..........", "....kk..........", "....k..........."], pal: {} }, "至少要画 6 个像素"],
      [{ ...good, dx: 3 }, "dx 要是 0、1 或 2"],
      [{ ...good, dx: "2" }, "dx 要是 0、1 或 2"],
      // 盖住眼睛（dx=2 时眼睛在画布第 12、13 行）
      [
        {
          art: [...Array<string>(11).fill("................"), ".....wwww.......", ".....wwww......."],
          pal: { w: "#ffffff" },
          dx: 2,
        },
        "盖住火苗的眼睛",
      ],
    ];
    for (const [input, message] of bad) {
      const result = validateCustomProp(input);
      expect(result.ok, `${message}：${JSON.stringify(result).slice(0, 120)}`).toBe(false);
      if (!result.ok) expect(result.error).toContain(message);
    }
  });

  it("自画道具渲染：盖在火苗上、眼睛还在；数据坏了画空手火苗，不报错", () => {
    const eyes = FLAME.join("").split("e").length - 1;
    const prop = {
      art: ["................", ".....kkkk.......", "....kwwwwk......", "....kwwwwk......", ".....kkkk......."],
      pal: { w: "#ffffff" },
      dx: 2,
    };
    for (const sprite of ["custom", "custom:teal"]) {
      const art = spriteArt(sprite, prop);
      expect(art.rows).toHaveLength(16);
      for (const row of art.rows) expect(row).toHaveLength(16);
      expect(art.rows.join("").split("e").length - 1, "眼睛不变").toBe(eyes);
      expect(Object.values(art.pal)).toContain("#ffffff");
    }
    expect(spriteArt("custom:teal").rows.join("")).toBe(spriteArt("hob:teal").rows.join(""));
    expect(spriteArt("custom", { ...prop, pal: { w: "#fff" } }).rows.join("")).toBe(spriteArt("custom").rows.join(""));
  });

  it("主助手的提示词按道具表列出可选的头像", () => {
    const hob = makeHob();
    try {
      const prompt = buildSystemPrompt(hob.runtime.store, "hob", {
        timezone: "Asia/Shanghai",
        aboutYou: { name: "", language: "", notes: "" },
        memory: "off",
      });
      expect(prompt).not.toContain("server 服务器/运维");
      expect(prompt).not.toContain("wifi 网络/路由器");
      expect(prompt).not.toContain("hob 那个火苗是主助手专用的，不要用。");
      expect(prompt).not.toContain("库里没有贴合职责的道具时，可以自己画一件");
    } finally {
      hob.close();
    }
  });
});

describe("换头像", () => {
  async function setup() {
    const hob = makeHob();
    const app = createApp(hob.runtime, { home: hob.home });
    const login = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "test" }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
    const patch = (body: Record<string, unknown>) =>
      app.request("/api/assistants/hob", {
        method: "PATCH",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    return { hob, app, cookie, patch, sprite: () => hob.runtime.store.assistant("hob")!.sprite };
  }

  it("PATCH 只收道具表里的头像；旧数据里认不出的值原样带回来不报错", async () => {
    const t = await setup();
    try {
      expect((await t.patch({ sprite: "wifi:green" })).status).toBe(200);
      expect(t.sprite()).toBe("wifi:green");
      expect((await t.patch({ sprite: "bird" })).status).toBe(200);
      expect(t.sprite()).toBe("bird");
      for (const bad of ["img:img-abc123.png", "nope", "bird:nocolor"]) {
        const res = await t.patch({ sprite: bad });
        expect(res.status).toBe(400);
        expect(((await res.json()) as { error: string }).error).toBe("头像无效。");
      }
      expect(t.sprite()).toBe("bird");
      // 旧版生成的头像：改别的字段时前端把原值带回来
      t.hob.runtime.store.saveAssistant({ ...t.hob.runtime.store.assistant("hob")!, sprite: "img:img-old.png" });
      expect((await t.patch({ sprite: "img:img-old.png", name: "小火" })).status).toBe(200);
      expect(t.hob.runtime.store.assistant("hob")).toMatchObject({ name: "小火", sprite: "img:img-old.png" });
      // 生成头像的接口已经去掉
      expect((await t.app.request("/api/assistants/hob/avatar", { method: "POST", headers: { cookie: t.cookie } })).status).toBe(404);
    } finally {
      t.hob.close();
    }
  });

  it("PATCH 认 custom：有画法数据才收；换回内置道具后画法保留，能换回来", async () => {
    const t = await setup();
    try {
      // 没有画法数据时不收 custom
      expect((await t.patch({ sprite: "custom" })).status).toBe(400);
      const prop = {
        art: ["................", ".....kkkk.......", "....kwwwwk......", "....kwwwwk......", ".....kkkk......."],
        pal: { w: "#ffffff" },
        dx: 2 as const,
      };
      const hob = t.hob.runtime.store.assistant("hob")!;
      t.hob.runtime.store.saveAssistant({ ...hob, sprite: "custom", prop });
      expect((await t.patch({ sprite: "custom:teal" })).status).toBe(200);
      expect(t.sprite()).toBe("custom:teal");
      expect((await t.patch({ sprite: "bird" })).status).toBe(200);
      expect(t.hob.runtime.store.assistant("hob")).toMatchObject({ sprite: "bird", prop });
      expect((await t.patch({ sprite: "custom" })).status).toBe(200);
      expect(t.sprite()).toBe("custom");
    } finally {
      t.hob.close();
    }
  });

  it("自画道具跟着草稿建进新助手；两个自画的不算撞", async () => {
    const hob = makeHob();
    try {
      const store = hob.runtime.store;
      store.saveAssistant({ ...(store.assistant("hob") as Assistant), id: "net", name: "网络", primary: false, sprite: "custom" });
      const draft: Draft = {
        id: "d-2",
        assistantId: "hob",
        status: "pending",
        name: "代理",
        sprite: "custom",
        prop: { art: ["................", "..kkkk..........", ".kwwwwk.........", "..kkkk.........."], pal: { w: "#ffffff" }, dx: 0 },
        duty: "代理转发",
        dutyLong: "负责代理和转发。",
        routines: [],
        routinesText: "",
        askFirst: [],
        instructions: [],
        carry: { conversations: 0 },
        createdAt: new Date().toISOString(),
      };
      store.saveDraft(draft);
      const result = await createFromDraft(hob.runtime, draft.id);
      expect(result.status).toBe(200);
      expect((result.body as { assistant: Assistant }).assistant).toMatchObject({ sprite: "custom", prop: draft.prop });
    } finally {
      hob.close();
    }
  });

  it("新建助手和已有助手撞了头像，自动换个颜色", async () => {
    const hob = makeHob();
    try {
      const store = hob.runtime.store;
      store.saveAssistant({ ...(store.assistant("hob") as Assistant), id: "ops", name: "运维", primary: false, sprite: "server" });
      const draft: Draft = {
        id: "d-1",
        assistantId: "hob",
        status: "pending",
        name: "机房",
        sprite: "server",
        duty: "机房的事",
        dutyLong: "负责机房的事。",
        routines: [],
        routinesText: "",
        askFirst: [],
        instructions: [],
        carry: { conversations: 0 },
        createdAt: new Date().toISOString(),
      };
      store.saveDraft(draft);
      const result = await createFromDraft(hob.runtime, draft.id);
      expect(result.status).toBe(200);
      expect((result.body as { assistant: Assistant }).assistant.sprite).toBe("server:red");
    } finally {
      hob.close();
    }
  });
});

describe("set_avatar 工具", () => {
  const GOOD = {
    art: ["....kkkk........", "...khhhhk.......", "....kkkk........"],
    pal: { h: "#ffc21a" },
    dx: 2 as const,
  };

  const run = async (hob: ReturnType<typeof makeHob>, aid: string, name: string, args: Record<string, unknown>) => {
    const tool = buildRouterTools(hob.runtime, aid).find((item) => item.name === name)!;
    const result = (await tool.execute("t", args)) as { content: { text: string }[]; isError?: boolean };
    return { text: result.content[0].text, isError: Boolean(result.isError) };
  };

  const addOps = (hob: ReturnType<typeof makeHob>) => {
    const store = hob.runtime.store;
    store.saveAssistant({
      id: "ops",
      name: "运维",
      duty: "线上和机器",
      sprite: "server",
      primary: false,
      pinned: true,
      hidden: false,
      notify: true,
      createdAt: new Date().toISOString(),
    });
  };

  it("给自己换内置道具和颜色：存 sprite、出提示行、推 assistant 事件", async () => {
    const hob = makeHob();
    try {
      const sprites: string[] = [];
      hob.runtime.bus.subscribe((event) => {
        if (event.type === "assistant") sprites.push(event.assistant.sprite);
      });
      const result = await run(hob, "hob", "set_avatar", { sprite: "wifi", color: "green" });
      expect(result.isError).toBe(false);
      expect(hob.runtime.store.assistant("hob")!.sprite).toBe("wifi:green");
      expect(
        hob.runtime.router.items("hob").items.some((item) => item.kind === "note" && item.icon === "info" && item.text.startsWith("已换头像")),
      ).toBe(true);
      expect(sprites).toContain("wifi:green");
      const bad = await run(hob, "hob", "set_avatar", { sprite: "nope" });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("sprite 要是内置道具 id");
    } finally {
      hob.close();
    }
  });

  it("自画道具：画一件存进 prop；画错的被拒；换走后能换回来、能改颜色", async () => {
    const hob = makeHob();
    try {
      const bad = await run(hob, "hob", "set_avatar", { sprite: "custom", prop_art: { ...GOOD, pal: { h: "yellow" } } });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain("#rrggbb");
      expect(hob.runtime.store.assistant("hob")!.prop).toBeUndefined();

      const ok = await run(hob, "hob", "set_avatar", { sprite: "custom", prop_art: GOOD });
      expect(ok.isError).toBe(false);
      expect(hob.runtime.store.assistant("hob")).toMatchObject({ sprite: "custom", prop: GOOD });

      await run(hob, "hob", "set_avatar", { sprite: "bird" });
      expect(hob.runtime.store.assistant("hob")).toMatchObject({ sprite: "bird", prop: GOOD });

      const back = await run(hob, "hob", "set_avatar", { sprite: "custom", color: "teal" });
      expect(back.isError).toBe(false);
      expect(hob.runtime.store.assistant("hob")!.sprite).toBe("custom:teal");
    } finally {
      hob.close();
    }
  });

  it("主助手可以给别的助手换；别的助手不能给别人换", async () => {
    const hob = makeHob();
    try {
      addOps(hob);
      const byHob = await run(hob, "hob", "set_avatar", { sprite: "bird", assistant: "ops" });
      expect(byHob.isError).toBe(false);
      expect(hob.runtime.store.assistant("ops")!.sprite).toBe("bird");
      // 提示行出在主助手的对话里，写明换的是谁
      expect(
        hob.runtime.router.items("hob").items.some((item) => item.kind === "note" && item.text.includes("已换头像 · 运维")),
      ).toBe(true);

      const byOps = await run(hob, "ops", "set_avatar", { sprite: "coin", assistant: "hob" });
      expect(byOps.isError).toBe(true);
      expect(byOps.text).toContain("只有主助手");
      expect(hob.runtime.store.assistant("hob")!.sprite).not.toBe("coin");
    } finally {
      hob.close();
    }
  });

  it("propose_assistant 带 prop_art：草稿存自画道具，建出来的助手头像正确；画错的不出草稿", async () => {
    const hob = makeHob();
    try {
      hob.faux.setResponses([
        call("propose_assistant", { name: "代理", duty: "代理转发", dutyLong: "负责代理和转发。", sprite: "custom", prop_art: GOOD, facts: ["负责代理"] }),
        text("草稿好了。"),
      ]);
      await hob.runtime.router.send("hob", { text: "代理和转发的事多，分个助手吧" });
      await hob.runtime.router.waitIdle("hob");
      const draft = hob.runtime.store.drafts()[0];
      expect(draft).toMatchObject({ sprite: "custom", prop: GOOD });

      hob.faux.appendResponses([
        call("propose_assistant", { name: "错了", duty: "试试", dutyLong: "试试。", sprite: "custom", prop_art: { ...GOOD, pal: { h: "yellow" } } }),
        text("重画了。"),
      ]);
      await hob.runtime.router.send("hob", { text: "再画一个试试" });
      await hob.runtime.router.waitIdle("hob");
      expect(hob.runtime.store.drafts().find((item) => item.name === "错了")).toBeUndefined();

      const result = await createFromDraft(hob.runtime, draft.id);
      expect(result.status).toBe(200);
      expect((result.body as { assistant: Assistant }).assistant).toMatchObject({ sprite: "custom", prop: GOOD });
    } finally {
      hob.close();
    }
  });
});
