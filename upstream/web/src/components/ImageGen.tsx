// 对话里正在生成的图片：没有卡片底色，只有一片方格排布的圆点。点的大小和亮度一起变：
// 两团光在中间一带慢慢游走，边上的点又小又暗；隔几秒随机涌动一下（一圈波纹扩开，或一片亮斑鼓起又落下）。
// 上面一行写进行到哪一步，右下角是百分比。
// 生图接口不报进度，百分比和步骤都按用时估（越往后涨得越慢，到图之前停在 96%）。
// 图到了，圆点按随机顺序缩没，原图从模糊变清楚。
import { useEffect, useRef, useState } from "react";
import { openFilePreview, photoUrl } from "../store.ts";

export type ImageGenStatus = "pending" | "done" | "failed";

/** 圆点间距和最大半径（px） */
const PITCH = 13;
const MAX_R = 2.7;
const REVEAL_MS = 700;

/** 宽高比：1536x1024 这类写法；认不出就当方图 */
export function aspectOf(size?: string) {
  const m = /^(\d{2,5})x(\d{2,5})$/.exec(size ?? "");
  const ratio = m ? Number(m[1]) / Number(m[2]) : 1;
  return Math.min(16 / 9, Math.max(9 / 16, ratio));
}

/** 按用时估的进度：30 秒约 63%，一分钟约 86%，之后越来越慢 */
export function estimate(seconds: number) {
  return Math.min(0.96, 1 - Math.exp(-seconds / 30));
}

export function stageText(progress: number) {
  return progress < 0.2 ? "正在构思" : progress < 0.55 ? "正在勾勒草图" : progress < 0.85 ? "正在上色" : "正在润色细节";
}

/** 两团光：每隔几秒挑一个新的随机位置，慢慢滑过去；新位置离另一团远一点，免得叠成一块 */
type Light = { x: number; y: number; tx: number; ty: number; next: number; r: number; gain: number };
function newLights(): Light[] {
  return [[0.22, 0.6, 0.3], [0.18, 0.5, 0.7]].map(([r, gain, x]) => {
    const y = 0.3 + Math.random() * 0.4;
    return { x, y, tx: x, ty: y, next: 0, r, gain };
  });
}
function retarget(light: Light, other: Light) {
  for (let i = 0; i < 6; i++) {
    light.tx = 0.2 + Math.random() * 0.6;
    light.ty = 0.2 + Math.random() * 0.6;
    if (Math.hypot(light.tx - other.tx, light.ty - other.ty) > 0.35) return;
  }
}

/** 涌动：ring 是一圈往外扩的波纹，swell 是一片鼓起来又落下去的亮斑 */
type Surge = { kind: "ring" | "swell"; x: number; y: number; at: number; dur: number };
const SURGE_GAP = [3500, 7500]; // 两次涌动的间隔（ms），随机取
function surgeGlow(s: Surge, nowMs: number, dx: number, dy: number) {
  const p = (nowMs - s.at) / s.dur;
  if (p < 0 || p >= 1) return 0;
  const d = Math.hypot(dx, dy);
  if (s.kind === "ring") {
    const off = d - p * 0.85; // 波前从 0 扩到 0.85，越往外越淡
    return 0.75 * (1 - p) * Math.exp(-(off * off) / 0.008);
  }
  return 0.7 * Math.sin(Math.PI * p) * Math.exp(-(d * d) / 0.03);
}

export function ImageGenCard({ status, prompt, size, path, error, startedAt, fresh, itemId }: {
  status: ImageGenStatus;
  prompt: string;
  size?: string;
  path?: string;
  error?: string;
  startedAt: string;
  fresh?: boolean;
  itemId?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // 打开对话时已经生成好的图直接显示，不再演一遍
  const [phase, setPhase] = useState<"live" | "reveal" | "shown">(status === "done" ? "shown" : "live");
  const [now, setNow] = useState(() => Date.now());
  const start = Date.parse(startedAt) || Date.now();
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  useEffect(() => {
    if (status !== "pending") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [status]);

  useEffect(() => {
    if (phase !== "reveal") return;
    const timer = setTimeout(() => setPhase("shown"), REVEAL_MS + 200);
    return () => clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    const el = canvas.current;
    if (!el || phase === "shown") return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let visible = true;
    let revealAt = 0;
    let seeds: number[] = [];
    const lights = newLights();
    let surges: Surge[] = [];
    let nextSurge = 0;
    let last = 0;
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible && !raf) raf = requestAnimationFrame(frame);
    });
    observer.observe(el);

    function frame(nowMs: number) {
      raf = 0;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const { width: W, height: H } = el!.getBoundingClientRect();
      if (el!.width !== Math.round(W * dpr) || el!.height !== Math.round(H * dpr)) {
        el!.width = Math.round(W * dpr);
        el!.height = Math.round(H * dpr);
      }
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, W, H);
      const cols = Math.max(1, Math.floor(W / PITCH));
      const rows = Math.max(1, Math.floor(H / PITCH));
      const ox = (W - (cols - 1) * PITCH) / 2;
      const oy = (H - (rows - 1) * PITCH) / 2;
      if (seeds.length !== cols * rows) seeds = Array.from({ length: cols * rows }, () => Math.random());
      const dark = document.documentElement.classList.contains("dark");
      if (phaseRef.current === "reveal" && !revealAt) revealAt = nowMs;
      const fade = revealAt ? Math.min(1, (nowMs - revealAt) / REVEAL_MS) : 0;
      const moving = status === "pending" && !still;
      const dt = last ? Math.min(0.1, (nowMs - last) / 1000) : 0;
      last = nowMs;
      if (moving) {
        // 第一次涌动在开始后一两秒，之后间隔随机
        if (!nextSurge) nextSurge = nowMs + 1200 + Math.random() * 1500;
        if (nowMs > nextSurge) {
          const ring = Math.random() < 0.5;
          surges.push({ kind: ring ? "ring" : "swell", x: 0.2 + Math.random() * 0.6, y: 0.2 + Math.random() * 0.6, at: nowMs, dur: ring ? 2600 : 1800 });
          nextSurge = nowMs + SURGE_GAP[0] + Math.random() * (SURGE_GAP[1] - SURGE_GAP[0]);
        }
        surges = surges.filter((s) => nowMs - s.at < s.dur);
        for (const [n, light] of lights.entries()) {
          if (nowMs > light.next) {
            retarget(light, lights[1 - n]!);
            light.next = nowMs + 3000 + Math.random() * 2500;
          }
          const k = 1 - Math.exp(-dt * 0.7);
          light.x += (light.tx - light.x) * k;
          light.y += (light.ty - light.y) * k;
        }
      }
      ctx!.fillStyle = dark ? "rgb(232,232,230)" : "rgb(38,38,36)";
      const aspect = W / H;
      const t = nowMs / 1000;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const seed = seeds[j * cols + i];
          const u = cols > 1 ? i / (cols - 1) : 0.5, v = rows > 1 ? j / (rows - 1) : 0.5;
          // 边上暗、中间亮；光团叠在上面。失败时光团不出现，只剩暗淡的一片
          const edge = Math.min(1, Math.min(u, 1 - u, v, 1 - v) / 0.3);
          let glow = 0.12;
          if (status !== "failed") {
            for (const l of lights) {
              const dx = (u - l.x) * aspect, dy = v - l.y;
              glow += l.gain * Math.exp(-(dx * dx + dy * dy) / (l.r * l.r));
            }
            for (const s of surges) glow += surgeGlow(s, nowMs, (u - s.x) * aspect, v - s.y);
          }
          const shimmer = moving ? Math.sin(t * 1.3 + seed * 6.28) * 0.03 : 0;
          const level = Math.min(1, Math.max(0, 0.08 + 0.92 * (0.35 + 0.65 * edge) * Math.min(1, glow) + shimmer));
          const gone = Math.min(1, Math.max(0, (fade - seed * 0.6) / 0.4));
          const r = (0.45 + (MAX_R - 0.45) * level) * (1 - gone);
          if (r < 0.3) continue;
          ctx!.globalAlpha = (0.16 + 0.84 * level) * (1 - gone);
          ctx!.beginPath();
          ctx!.arc(ox + i * PITCH, oy + j * PITCH, r, 0, Math.PI * 2);
          ctx!.fill();
        }
      }
      ctx!.globalAlpha = 1;
      const more = phaseRef.current === "reveal" ? fade < 1 : moving;
      if (more && visible) raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); };
  }, [phase, status, start]);

  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const progress = estimate(seconds);
  return (
    <div className={`igen ${phase}${status === "failed" ? " failed" : ""}${fresh ? " enter" : ""}`} data-item-id={itemId}>
      {phase === "live" && status !== "failed" ? <div className="igen-stage" role="status" title={prompt}>{stageText(progress)}</div> : null}
      <div className="igen-frame" style={{ aspectRatio: String(aspectOf(size)) }}>
        {path ? (
          <button className="igen-img" onClick={() => openFilePreview(path)} title={prompt} tabIndex={phase === "live" ? -1 : 0}>
            <img src={photoUrl(path)} alt={prompt} onLoad={() => { if (phaseRef.current === "live") setPhase("reveal"); }} />
          </button>
        ) : null}
        {phase === "shown" ? null : <canvas ref={canvas} aria-hidden="true" />}
        {phase === "live" && status === "pending" ? <span className="igen-pct">{Math.floor(progress * 100)}%</span> : null}
      </div>
      {status === "failed" && phase === "live" ? (
        <div className="igen-cap" role="status" title={prompt}>
          <span>没有生成出来</span>
          <span className="igen-note">{error || "图片生成失败。"}</span>
        </div>
      ) : null}
    </div>
  );
}
