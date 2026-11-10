// 生成 PWA 图标：把 hob 火苗（12×12 像素画）画成 SVG，用系统 Chrome headless 截图成 PNG。
// 不加依赖：node scripts/make-icons.mjs（出图提交进仓库，部署时不用跑）
// 火苗和界面里的头像是同一份（shared/sprites.ts 的 FLAME），这里抄了一份，改了要一起改。
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "web", "public", "icons");

const hob = {
  bg: "#ffe6d3",
  pal: { k: "#40261a", o: "#ff7a2e", y: "#ffcf4a", e: "#40261a" },
  rows: [
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
  ],
};
const size = 12; // 精灵是 12×12

/**
 * 一张图标：px 是画布边长，cell 是精灵每一格画多少像素（整数，像素画才不糊），
 * 底色是精灵的底色往下稍微加深一点的渐变。
 */
function svg(px, cell) {
  const draw = size * cell;
  const offset = Math.round((px - draw) / 2);
  const rects = [];
  hob.rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch === ".") return;
      rects.push(`<rect x="${offset + x * cell}" y="${offset + y * cell}" width="${cell}" height="${cell}" fill="${hob.pal[ch] ?? "transparent"}"/>`);
    }),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${px} ${px}" width="${px}" height="${px}" shape-rendering="crispEdges">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff0e4"/><stop offset="1" stop-color="${hob.bg}"/></linearGradient></defs>
<rect width="${px}" height="${px}" fill="url(#bg)"/>
${rects.join("")}
</svg>`;
}

function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/")) {
      if (existsSync(candidate)) return candidate;
      continue;
    }
    const found = spawnSync("which", [candidate], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error("找不到 Chrome：装一个，或用 CHROME_PATH 指定路径");
}

/**
 * 每个尺寸：画布边长 + 每格像素。火苗约占画布的四分之三；
 * maskable 要整个落在中间 80% 的安全圆里（12×24=288，对角线 407 < 410）。
 */
const TARGETS = [
  { file: "icon-192.png", px: 192, cell: 12 },
  { file: "icon-512.png", px: 512, cell: 32 },
  { file: "icon-maskable-512.png", px: 512, cell: 24 },
  { file: "apple-touch-icon-180.png", px: 180, cell: 12 },
  { file: "favicon-32.png", px: 32, cell: 2 },
];

const chrome = chromePath();
const work = mkdtempSync(join(tmpdir(), "hob-icons-"));
mkdirSync(outDir, { recursive: true });
try {
  for (const target of TARGETS) {
    const html = join(work, `${target.file}.html`);
    writeFileSync(
      html,
      `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;background:${hob.bg}}svg{display:block;width:100vw;height:100vh}</style>${svg(target.px, target.cell)}`,
    );
    const png = join(outDir, target.file);
    const shot = spawnSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-sandbox",
        "--force-device-scale-factor=1",
        `--window-size=${target.px},${target.px}`,
        "--virtual-time-budget=1500",
        `--screenshot=${png}`,
        pathToFileURL(html).href,
      ],
      { encoding: "utf8" },
    );
    if (shot.status !== 0 || !existsSync(png)) {
      throw new Error(`截 ${target.file} 失败：${shot.stderr?.trim() || shot.stdout?.trim() || "没有输出"}`);
    }
    console.log(`${target.file} ${target.px}×${target.px}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
