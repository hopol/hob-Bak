// 助手头像：Hob 的像素小火苗 + 颜色 + 道具，数据在 shared/sprites.ts；自画道具的数据跟着助手走。
import { useRef } from "react";
import { spriteArt, spriteEyes } from "../../shared/sprites.ts";
import type { CustomProp, SpriteId } from "../../shared/types.ts";

/** 同一行里连着的同色像素合成一个矩形，列表里几十个头像时少画很多节点。 */
function SpritePixels({ art }: { art: ReturnType<typeof spriteArt> }) {
  const rects: { x: number; y: number; w: number; fill: string }[] = [];
  art.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      if (ch !== "." && art.pal[ch]) rects.push({ x, y, w: end - x, fill: art.pal[ch] });
      x = end;
    }
  });
  return (
    <>
      {rects.map((r, i) => (
        <rect key={i} x={r.x} y={r.y} width={r.w + 0.02} height={1.02} fill={r.fill} />
      ))}
    </>
  );
}

export type AvatarMark = "busy" | "ask" | "stuck" | "done";
const MARK_LABEL: Record<AvatarMark, string> = { busy: "正在工作", ask: "等你确认", stuck: "受阻", done: "已完成，未读" };

/** peek：每 30 秒看一圈（约 3.6 秒，见 styles.css 的 eye-peek）；第 n 个在忙的助手晚 n×4 秒开始，一个看完下一个才看。 */
const PEEK_GAP_S = 4;
const PEEK_TURNS = 7;

/**
 * 头像。默认是圆底（列表、卡片、头部都是它，形状一致）；free 是不带圆底的小人，只用在单独一个的地方（对话底部状态行、空对话、资料页、登录），不进列表。
 * motion：眼睛动起来，表示在忙。sprite 是 custom / custom:* 时传 prop（自画的画法）；没传或数据坏了画空手火苗。
 */
export function Avatar({
  sprite,
  prop,
  size,
  title,
  onClick,
  motion,
  mark,
  free,
  slot,
}: {
  sprite: SpriteId;
  prop?: CustomProp;
  size: number;
  title?: string;
  onClick?: () => void;
  motion?: "think" | "work" | "home" | "peek";
  /** 右下角状态符号：busy 正在工作、ask 等你确认、stuck 受阻、done 完成未读 */
  mark?: AvatarMark;
  free?: boolean;
  /** peek 的轮次：第几个在忙的助手，按顺序轮流看一圈，不同时动 */
  slot?: number;
}) {
  const lastMark = useRef(mark);
  if (mark) lastMark.current = mark;
  const displayedMark = mark ?? lastMark.current;
  const art = spriteArt(sprite, prop);
  // 动起来时眼睛单独一层：外层管看的方向，内层管眨眼，两个 transform 互不覆盖
  const split = motion ? spriteEyes(art) : undefined;
  // 同一个助手在各处一样，不同助手错开起点
  const eyeDelay = motion === "peek"
    ? `${((slot ?? 0) % PEEK_TURNS) * PEEK_GAP_S}s`
    : motion ? `${-([...sprite].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 7) % 4000) / 1000}s` : undefined;
  return (
    <div className={`av${free ? " av-free" : ""}${motion ? ` av-motion av-${motion}` : ""} av-marked`} title={title} onClick={onClick} style={{ "--av-size": `${size}px`, "--av-bg": art.bg } as React.CSSProperties}>
      <svg viewBox={`${art.offset[0]} ${art.offset[1]} 16 16`} shapeRendering="crispEdges" aria-hidden="true" style={eyeDelay ? ({ "--eye-delay": eyeDelay } as React.CSSProperties) : undefined}>
        {split ? (
          <>
            <SpritePixels art={{ ...art, rows: split.body }} />
            <g className="av-eyes">
              <g className="av-blink">
                {split.eyes.map(([x, y]) => (
                  <rect key={`${x}-${y}`} x={x} y={y} width={1.02} height={1.02} fill={art.pal.e} />
                ))}
              </g>
            </g>
          </>
        ) : (
          <SpritePixels art={art} />
        )}
      </svg>
      <span className={`av-mark${mark ? " present" : ""}${displayedMark ? ` ${displayedMark}` : ""}`} aria-label={mark ? MARK_LABEL[mark] : undefined} aria-hidden={!mark}><span key={displayedMark} className="av-mark-icon">{displayedMark === "busy" ? <svg viewBox="0 0 13 5"><circle className="av-dot" cx="2.5" cy="2.5" r="1.5" /><circle className="av-dot" cx="6.5" cy="2.5" r="1.5" /><circle className="av-dot" cx="10.5" cy="2.5" r="1.5" /></svg> : displayedMark === "done" ? <svg viewBox="0 0 16 16" fill="none"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg> : displayedMark === "ask" ? "?" : displayedMark === "stuck" ? "!" : null}</span></span>
    </div>
  );
}
