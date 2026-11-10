// 助手头像：都是 Hob 的像素小火苗，换一种颜色、带一件和职责有关的道具。
// sprite 记成「道具」或「道具:颜色」，如 "server"、"wifi:green"；只写道具时用这件道具的默认颜色。
// 库里没有合适的道具时，AI 可以自己画一件：sprite 记成 "custom" 或 "custom:颜色"，画法存在 Assistant.prop，格式和 PROPS 里的一项相同。
// 旧数据里的 page、server、bird 这些 id 就是道具 id，不用迁移。

import type { CustomProp } from "./types.ts";

/** 12×12 的火苗（主助手 Hob 就是它，应用图标也是）。k 描边，o 外焰，y 内焰，e 眼睛。 */
export const FLAME = [
  "......k.....",
  ".....kok....",
  ".....kook...",
  "..k.koook...",
  ".kokoooook..",
  ".kooooooook.",
  "kooyyyyyyook",
  "koyyeyyeyyok",
  "koyyeyyeyyok",
  "koyyyyyyyyok",
  ".kooyyyyook.",
  "..kkkkkkkk..",
];

const SIZE = 16;
const INK = "#40261a";

export const COLORS = {
  orange: { name: "橙", o: "#ff7a2e", y: "#ffcf4a", bg: "#ffe6d3" },
  red: { name: "红", o: "#ff5a3c", y: "#ffd2a8", bg: "#ffe3dc" },
  pink: { name: "粉", o: "#ff6b8a", y: "#ffd6de", bg: "#ffe4ef" },
  purple: { name: "紫", o: "#8f7bff", y: "#ddd6ff", bg: "#e9e5ff" },
  blue: { name: "蓝", o: "#4ea3ff", y: "#cfe6ff", bg: "#fff0c4" },
  slate: { name: "灰蓝", o: "#6f8fb3", y: "#d8e5f2", bg: "#e3eeff" },
  teal: { name: "青", o: "#20b8b0", y: "#c2f0ea", bg: "#d6f3f1" },
  green: { name: "绿", o: "#2fbf71", y: "#c9f2da", bg: "#e4f5d9" },
};
export type ColorId = keyof typeof COLORS;

interface Prop {
  /** 适合的职责，建助手时给模型挑头像用 */
  label: string;
  color: ColorId;
  /** 火苗在 16×16 里的横向位置：头顶的道具居中（2），手边的靠左（0、1），道具放右边不挡右眼 */
  dx: number;
  pal: Record<string, string>;
  /** 从第 0 行起逐行盖上去：'.' 不动，其它字符换成 pal 里的颜色 */
  art: string[];
}

const at = (y: number, rows: string[]) => [...Array<string>(y).fill(""), ...rows];

export const PROPS = {
  hob: { label: "主助手", color: "orange", dx: 2, pal: {}, art: [] },
  page: {
    label: "写作/文档",
    color: "purple",
    dx: 1,
    pal: { p: "#ff9db0", g: "#b9c0c8", h: "#ffc21a", b: "#f2c58f" },
    art: at(5, [
      "............kkkk",
      "............kppk",
      "............kppk",
      "............kggk",
      "............khhk",
      "............khhk",
      "............khhk",
      "............khhk",
      "............kbbk",
      ".............kk.",
    ]),
  },
  server: {
    label: "服务器/运维",
    color: "slate",
    dx: 2,
    pal: { h: "#ffc21a", w: "#fff1b8" },
    art: at(2, [
      "......kkkk......",
      ".....khhwwk.....",
      "....khhhhwhk....",
      "....khhhhhhk....",
      "...kkkkkkkkkk...",
    ]),
  },
  bird: {
    label: "资讯/动态",
    color: "blue",
    dx: 0,
    pal: { l: "#dff3ff", w: "#ffffff" },
    art: at(6, [
      "..........kkkk..",
      ".........kllllk.",
      ".........kwlllk.",
      ".........kllllk.",
      ".........kllllk.",
      "..........kkkk..",
      ".............kk.",
      "..............kk",
      "...............k",
    ]),
  },
  house: {
    label: "家/NAS/生活",
    color: "teal",
    dx: 0,
    pal: { r: "#ff8b6a", w: "#fff7ea", d: "#9b6b52" },
    art: at(9, [
      "............k...",
      "...........krk..",
      "..........krrrk.",
      ".........krrrrrk",
      "..........kwwwk.",
      "..........kwdwk.",
      "..........kkkkk.",
    ]),
  },
  coin: {
    label: "钱/记账",
    color: "green",
    dx: 0,
    pal: { h: "#ffc21a", w: "#fff1b8", d: "#d18f00" },
    art: at(9, [
      "...........kkk..",
      "..........khhhk.",
      ".........khwdhhk",
      ".........khwdhhk",
      ".........khhdhhk",
      "..........khhhk.",
      "...........kkk..",
    ]),
  },
  book: {
    label: "学习/读书",
    color: "red",
    dx: 2,
    pal: { d: "#3a3f58", t: "#ffc21a" },
    art: at(1, [
      ".......kk.......",
      ".....kkddkk.....",
      "...kkddddddkk...",
      ".kkddddddddddkk.",
      "...kkddddddkk.t.",
      "....kddddddk..t.",
      "....kkkkkkkk..t.",
      "..............t.",
    ]),
  },
  leaf: {
    label: "健康/植物",
    color: "pink",
    dx: 2,
    pal: { g: "#5ccf6b", s: "#3a9a4f" },
    art: at(0, [
      "....kk.....kk...",
      "...kggk...kggk..",
      "....kggkskggk...",
      ".....kk.s.kk....",
    ]),
  },
  wifi: {
    label: "网络/路由器",
    color: "teal",
    dx: 2,
    pal: {},
    art: at(0, ["......kkkkk.....", ".....k.....k....", ".......kkk......", "......k...k....."]),
  },
  calendar: {
    label: "日程/提醒",
    color: "purple",
    dx: 0,
    pal: { r: "#ff4d4d", w: "#ffffff" },
    art: at(8, [
      "..........k...k.",
      ".........kkkkkkk",
      ".........krrrrrk",
      ".........kkkkkkk",
      ".........kwwwwwk",
      ".........kwwkwwk",
      ".........kwwwwwk",
      ".........kkkkkkk",
    ]),
  },
  chef: {
    label: "做饭/饮食",
    color: "red",
    dx: 2,
    pal: { w: "#ffffff", g: "#d9dde2" },
    art: at(1, [
      ".....kk..kk.....",
      "....kwwkkwwk....",
      "...kwwwwwwwwk...",
      "...kwwwwwwwwk...",
      "....kwwwwwwk....",
      "....kggggggk....",
      "....kkkkkkkk....",
    ]),
  },
  chart: {
    label: "股票/数据",
    color: "slate",
    dx: 0,
    pal: { w: "#ffffff", g: "#f04848" },
    art: at(9, [
      ".........kkkkkkk",
      ".........kwwwwgk",
      ".........kwwgwgk",
      ".........kwwgwgk",
      ".........kgwgwgk",
      ".........kgwgwgk",
      ".........kkkkkkk",
    ]),
  },
  bag: {
    label: "旅行/出行",
    color: "blue",
    dx: 0,
    pal: { b: "#e8833a", s: "#ffd59a" },
    art: at(9, [
      "...........kkk..",
      "...........k.k..",
      ".........kkkkkkk",
      ".........kbsbsbk",
      ".........kbsbsbk",
      ".........kbsbsbk",
      ".........kkkkkkk",
    ]),
  },
  paw: {
    label: "宠物",
    color: "purple",
    dx: 0,
    pal: { c: "#ffb36b", p: "#ff8fa6" },
    art: at(9, [
      ".........k.....k",
      ".........kck.kck",
      ".........kccccck",
      ".........kckckck",
      ".........kccpcck",
      "..........kkkkk.",
    ]),
  },
  note: {
    label: "音乐",
    color: "pink",
    dx: 1,
    pal: {},
    art: at(2, [
      "..............k.",
      "..............kk",
      "..............kk",
      "..............k.",
      "..............k.",
      "............kkk.",
      "............kkk.",
    ]),
  },
  code: {
    label: "代码/开发",
    color: "green",
    dx: 0,
    pal: { d: "#2b3240", g: "#6ef0a0" },
    art: at(10, [
      ".........kkkkkkk",
      ".........kgddddk",
      ".........kdgdddk",
      ".........kgdggdk",
      ".........kdddddk",
      ".........kkkkkkk",
    ]),
  },
  gym: {
    label: "健身/运动",
    color: "blue",
    dx: 2,
    pal: { r: "#ff3b5c" },
    art: at(9, ["...krrrrrrrrk...", "..krrrrrrrrrrkr.", "...............r"]),
  },
  // 软件工程和敏捷开发里的角色
  sticky: {
    label: "需求/产品负责人",
    color: "purple",
    dx: 0,
    pal: { n: "#ffe066", d: "#c9a227" },
    art: at(9, [
      ".........kkkkkkk",
      ".........knnnnnk",
      ".........kdddnnk",
      ".........knnnnnk",
      ".........kddddnk",
      ".........knnnnkk",
      ".........kkkkkk.",
    ]),
  },
  timer: {
    label: "迭代/敏捷教练",
    color: "teal",
    dx: 0,
    pal: { w: "#ffffff", r: "#ff5a3c" },
    art: at(8, [
      "...........kkk..",
      "............k...",
      "..........kkkkk.",
      ".........kwwrwwk",
      ".........kwwrwwk",
      ".........kwwkkwk",
      ".........kwwwwwk",
      "..........kkkkk.",
    ]),
  },
  bug: {
    label: "测试/质量",
    color: "green",
    dx: 0,
    pal: { r: "#ff4d4d" },
    art: at(8, [
      "..........k...k.",
      "...........kkk..",
      "..........krrrk.",
      ".........krkrkrk",
      ".........krrrrrk",
      ".........krkrkrk",
      "..........krrrk.",
      "...........kkk..",
    ]),
  },
  magnifier: {
    label: "代码审查/调研",
    color: "blue",
    dx: 0,
    pal: { l: "#cfe8ff", w: "#ffffff", h: "#8a5a3c" },
    art: at(8, [
      "..........kkk...",
      ".........kwllk..",
      ".........kllllk.",
      ".........kllllk.",
      "..........kkkk..",
      ".............hh.",
      "..............hh",
    ]),
  },
  blocks: {
    label: "架构/系统设计",
    color: "slate",
    dx: 0,
    pal: { a: "#ff8b6a", b: "#4ea3ff", c: "#ffc21a" },
    art: at(9, [
      "...........kkkk.",
      "...........kaak.",
      "...........kaak.",
      ".........kkkkkkk",
      ".........kbbkcck",
      ".........kbbkcck",
      ".........kkkkkkk",
    ]),
  },
  rocket: {
    label: "发布/部署",
    color: "purple",
    dx: 0,
    pal: { w: "#e8edf3", r: "#ff5a3c", b: "#4ea3ff", f: "#ffb020" },
    art: at(6, [
      "............k...",
      "...........krk..",
      "...........krk..",
      "..........kwwwk.",
      "..........kwbwk.",
      "..........kwwwk.",
      "..........kwwwk.",
      ".........krwwwrk",
      ".........kkkkkkk",
      "...........kfk..",
    ]),
  },
  shield: {
    label: "安全/权限",
    color: "blue",
    dx: 0,
    pal: { s: "#5b8def", w: "#ffffff" },
    art: at(9, [
      ".........kkkkkkk",
      ".........kssswsk",
      ".........kwswssk",
      ".........kswsssk",
      "..........ksssk.",
      "...........ksk..",
      "............k...",
    ]),
  },
  database: {
    label: "数据库/数据",
    color: "teal",
    dx: 0,
    pal: { d: "#5fa8ff", t: "#cfe6ff" },
    art: at(8, [
      "..........kkkkk.",
      ".........ktttttk",
      ".........kkkkkkk",
      ".........kdddddk",
      ".........kkkkkkk",
      ".........kdddddk",
      "..........kkkkk.",
    ]),
  },
  palette: {
    label: "界面/视觉设计",
    color: "pink",
    dx: 0,
    pal: { p: "#f2c58f", a: "#ff4d4d", b: "#4ea3ff", c: "#5ccf6b" },
    art: at(9, [
      "..........kkkkk.",
      ".........kpppppk",
      ".........kpapbpk",
      ".........kppppk.",
      ".........kpcppk.",
      "..........kkkk..",
    ]),
  },
  siren: {
    label: "值班/告警",
    color: "red",
    dx: 2,
    pal: { r: "#ff3b3b", w: "#ffd0d0" },
    art: at(1, [
      "..k...kkkk...k..",
      "...k.krwrrk.k...",
      ".....krrrrk.....",
      "....kkkkkkkk....",
    ]),
  },
  kanban: {
    label: "项目管理/看板",
    color: "green",
    dx: 0,
    pal: { w: "#ffffff", a: "#ff8b6a", b: "#ffc21a", c: "#5ccf6b" },
    art: at(9, [
      ".........kkkkkkk",
      ".........kakbkck",
      ".........kakwkck",
      ".........kwkbkwk",
      ".........kwkwkwk",
      ".........kkkkkkk",
    ]),
  },
  wrench: {
    label: "维护/修复",
    color: "slate",
    dx: 0,
    pal: { g: "#b9c0c8" },
    art: at(8, [
      "............k.k.",
      "...........kgkgk",
      "...........kgggk",
      "..........kgggk.",
      ".........kggk...",
      "........kggk....",
      "........kgk.....",
      "........kk......",
    ]),
  },
  bolt: {
    label: "性能/优化",
    color: "purple",
    dx: 0,
    pal: { b: "#ffc21a" },
    art: at(8, [
      "............kkk.",
      "...........kbbk.",
      "..........kbbk..",
      ".........kbbbbk.",
      "..........kkbbk.",
      "...........kbk..",
      "..........kbk...",
      "..........kk....",
    ]),
  },
} satisfies Record<string, Prop>;
export type PropId = keyof typeof PROPS;

export const PROP_IDS = Object.keys(PROPS) as PropId[];
export const COLOR_IDS = Object.keys(COLORS) as ColorId[];

export type ParsedSprite = { prop: PropId; color: ColorId } | { prop: "custom"; color: ColorId };

/** 拆成道具和颜色；自画的记成 custom / custom:颜色（默认橙色）；不认识的（含旧的生成头像 img:…）返回 undefined。 */
export function parseSprite(sprite: string): ParsedSprite | undefined {
  if (sprite === "custom") return { prop: "custom", color: "orange" };
  if (sprite.startsWith("custom:")) {
    const color = sprite.slice("custom:".length);
    return Object.hasOwn(COLORS, color) ? { prop: "custom", color: color as ColorId } : undefined;
  }
  const [prop, color, ...rest] = sprite.split(":");
  if (rest.length || !Object.hasOwn(PROPS, prop)) return undefined;
  const p = prop as PropId;
  if (color === undefined) return { prop: p, color: PROPS[p].color };
  return Object.hasOwn(COLORS, color) ? { prop: p, color: color as ColorId } : undefined;
}

/** 自画道具的 sprite：默认颜色（橙）就只写 custom。 */
export function customSprite(color: ColorId): string {
  return color === "orange" ? "custom" : `custom:${color}`;
}

const HEX = /^#[0-9a-f]{6}$/;

/**
 * 校验 AI 画的自定义道具（前后端共用）。不合格返回清楚的原因，让模型照着改了重画。
 * art 最多 16 行、每行恰好 16 个字符，字符只能是 `.`、`k`（描边色，固定）或 pal 里的键；
 * pal 键是单个小写字母，不能用火苗自己的 o y e 和描边 k，最多 6 种，值是 #rrggbb；
 * 不能盖住火苗的两只眼睛；至少画 6 个像素。
 */
export function validateCustomProp(input: unknown): { ok: true; prop: CustomProp } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "prop_art 要是一个对象：art（字符串数组）、pal（字母 → 颜色）、dx（0|1|2）" };
  }
  const { art, pal, dx } = input as Record<string, unknown>;
  if (!Array.isArray(art) || art.length === 0) return { ok: false, error: "prop_art.art 要是非空的字符串数组" };
  if (art.length > SIZE) return { ok: false, error: `prop_art.art 最多 ${SIZE} 行，收到 ${art.length} 行` };
  for (const row of art) {
    if (typeof row !== "string") return { ok: false, error: "prop_art.art 的每行都要是字符串" };
    if ([...row].length !== SIZE) {
      return { ok: false, error: `prop_art.art 每行要正好 ${SIZE} 个字符，这一行是 ${[...row].length} 个：「${row}」` };
    }
  }
  if (!pal || typeof pal !== "object" || Array.isArray(pal)) {
    return { ok: false, error: "prop_art.pal 要是对象：单个小写字母 → #rrggbb" };
  }
  const entries = Object.entries(pal as Record<string, unknown>);
  if (entries.length > 6) return { ok: false, error: `prop_art.pal 最多 6 种颜色，收到 ${entries.length} 种` };
  for (const [key, value] of entries) {
    if (!/^[a-z]$/.test(key)) return { ok: false, error: `pal 的键要是单个小写字母，收到「${key}」` };
    if (key === "k") return { ok: false, error: "pal 不能有 k：描边色是固定的，art 里直接用 k 就行" };
    if ("oye".includes(key)) return { ok: false, error: `pal 不能用 ${key}：这是火苗自己的颜色` };
    if (typeof value !== "string" || !HEX.test(value)) {
      return { ok: false, error: `pal[${key}] 要是 #rrggbb 格式的颜色，收到「${String(value)}」` };
    }
  }
  const drawn = (art as string[]).join("");
  for (const ch of new Set([...drawn].filter((c) => c !== "."))) {
    if (ch === "k") continue;
    if (!Object.hasOwn(pal as Record<string, unknown>, ch)) {
      return { ok: false, error: `art 里的「${ch}」没有在 pal 里定义颜色` };
    }
  }
  const pixels = [...drawn].filter((c) => c !== ".").length;
  if (pixels < 6) return { ok: false, error: `至少要画 6 个像素，现在只有 ${pixels} 个` };
  if (dx !== 0 && dx !== 1 && dx !== 2) return { ok: false, error: `prop_art.dx 要是 0、1 或 2，收到 ${String(dx)}` };
  // 火苗两只眼睛在画布的第 12、13 行（第 5 行起是火苗），道具不能盖住
  const top = SIZE - FLAME.length;
  for (let y = 0; y < FLAME.length; y++) {
    for (let x = 0; x < FLAME[y].length; x++) {
      if (FLAME[y][x] !== "e") continue;
      const row = (art as string[])[top + y];
      const ch = row?.[dx + x];
      if (ch && ch !== ".") {
        return {
          ok: false,
          error: `art 第 ${top + y + 1} 行第 ${dx + x + 1} 列会盖住火苗的眼睛，把图案挪开（或调小 dx）`,
        };
      }
    }
  }
  return { ok: true, prop: { art: art as string[], pal: pal as Record<string, string>, dx } };
}

/** 组回 sprite：颜色就是默认的就只写道具。 */
export function spriteId(prop: PropId, color: ColorId): string {
  return color === PROPS[prop].color ? prop : `${prop}:${color}`;
}

/**
 * 画出来的样子：16×16 的行、调色板、圆底颜色，以及让图案居中的偏移（按实际像素的包围盒）。
 * sprite 是 custom 时用传入的自画道具（数据坏了或没传就画空手火苗）；认不出的画成灰蓝色的空手火苗。都不报错。
 */
export function spriteArt(
  sprite: string,
  custom?: CustomProp,
): {
  rows: string[];
  pal: Record<string, string>;
  bg: string;
  offset: [number, number];
} {
  const parsed: ParsedSprite = parseSprite(sprite) ?? { prop: "hob", color: "slate" };
  const checked = parsed.prop === "custom" && custom ? validateCustomProp(custom) : undefined;
  const overlay: Pick<Prop, "dx" | "pal" | "art"> =
    parsed.prop === "custom" ? (checked?.ok ? checked.prop : PROPS.hob) : PROPS[parsed.prop];
  const c = COLORS[parsed.color];
  const rows = [...Array<string>(SIZE - FLAME.length).fill(""), ...FLAME].map((row, y) => {
    const base = row ? `${".".repeat(overlay.dx)}${row}`.padEnd(SIZE, ".") : ".".repeat(SIZE);
    const over = overlay.art[y] ?? "";
    return [...base].map((ch, x) => (over[x] && over[x] !== "." ? over[x] : ch)).join("");
  });
  let [x0, y0, x1, y1] = [SIZE, SIZE, 0, 0];
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x + 1), Math.max(y1, y + 1)];
    }),
  );
  return {
    rows,
    pal: { k: INK, e: INK, o: c.o, y: c.y, ...overlay.pal },
    bg: c.bg,
    offset: [(x0 + x1 - SIZE) / 2, (y0 + y1 - SIZE) / 2],
  };
}

/**
 * 动画用：把眼睛从画里拿出来单独动（看方向、眨眼），身体只整体浮动，不换帧。
 * 眼睛就是画里的 e 像素：道具不能用 e（validateCustomProp 拦着，内置道具也没用），也盖不住眼睛，所以任何头像都拆得出来。
 * body 是挖掉眼睛、补上内焰色的画；eyes 是眼睛像素的 [x, y]。
 */
export function spriteEyes(art: { rows: string[] }): { body: string[]; eyes: [number, number][] } {
  const eyes: [number, number][] = [];
  const body = art.rows.map((row, y) =>
    [...row].map((ch, x) => {
      if (ch !== "e") return ch;
      eyes.push([x, y]);
      return "y";
    }).join(""),
  );
  return { body, eyes };
}

/** 新建助手时：已有助手用着同一个头像就换成这件道具还没人用的颜色（橙色留给 Hob）；自画的图案各不相同，不算撞。 */
export function distinctSprite(sprite: string, taken: string[]): string {
  const want = parseSprite(sprite);
  if (!want || want.prop === "custom") return sprite;
  const key = (s: string) => {
    const p = parseSprite(s);
    return p ? `${p.prop}:${p.color}` : s;
  };
  const used = new Set(taken.map(key));
  if (!used.has(`${want.prop}:${want.color}`)) return sprite;
  const free = COLOR_IDS.find((c) => c !== "orange" && !used.has(`${want.prop}:${c}`));
  return free ? spriteId(want.prop, free) : sprite;
}
