#!/usr/bin/env node
// 生成桌面壁纸 wallpaper.png（深蓝灰渐变 + 底部一团很淡的冷光 + 极淡的点阵）。
// 自画，没有版权问题；改动后跑 `node desktop/wallpaper.mjs` 重新生成并提交 PNG。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const W = 1600;
const H = 1000;

const lerp = (a, b, t) => a + (b - a) * t;
const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

const TOP = [11, 17, 28]; // #0b111c
const BOTTOM = [23, 33, 48]; // #172130
const GLOW = [38, 71, 107]; // #26476b
const glow = { x: W * 0.5, y: H * 1.05, r: W * 0.62 };

function pixel(x, y) {
  const t = y / (H - 1);
  let c = mix(TOP, BOTTOM, t ** 0.9);
  // 底部中央的冷光：只有一点点，不抢图标
  const d = Math.hypot(x - glow.x, y - glow.y) / glow.r;
  if (d < 1) c = mix(c, GLOW, (1 - d) ** 2.4 * 0.5);
  // 极淡的点阵，给大片渐变一点质感
  if (x % 40 === 0 && y % 40 === 0) c = mix(c, [255, 255, 255], 0.05);
  return c.map((v) => Math.max(0, Math.min(255, Math.round(v))));
}

const raw = Buffer.alloc((W * 3 + 1) * H);
let off = 0;
for (let y = 0; y < H; y++) {
  const row = Buffer.alloc(W * 3);
  for (let x = 0; x < W; x++) {
    const c = pixel(x, y);
    row[x * 3] = c[0];
    row[x * 3 + 1] = c[1];
    row[x * 3 + 2] = c[2];
  }
  raw[off++] = 1; // Sub 过滤：水平渐变残差很小，压缩率高
  for (let i = 0; i < row.length; i++) raw[off++] = (row[i] - (i >= 3 ? row[i - 3] : 0)) & 0xff;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // 每通道 8 位
ihdr[9] = 2; // 真彩色 RGB
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "wallpaper.png");
fs.writeFileSync(out, png);
console.log(`${out}：${W}x${H}，${(png.length / 1024).toFixed(0)}KB`);
