// 几张图片叠成一摞（微信的做法）：左右拖最上面那张，后面那张跟着手指慢慢浮上来；
// 拖过一小段就换到下一张，被拖走的那张回到最底下。点一下打开当前这张。
import { useRef, useState } from "react";
import { photoUrl } from "../store.ts";

/** 拖多远算换一张（px） */
const SWITCH = 50;
/** 拖多远后面那张完全浮到最上面的位置（px） */
const RISE = 110;

export function PhotoStack({ photos, onOpen }: { photos: string[]; onOpen: (path: string) => void }) {
  const [top, setTop] = useState(0);
  const [dx, setDx] = useState(0);
  const drag = useRef<{ id: number; x: number; moved: boolean } | null>(null);
  const n = photos.length;
  const rise = Math.min(1, Math.abs(dx) / RISE);

  const end = (open: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      if (open) onOpen(photos[top]);
    } else if (Math.abs(dx) > SWITCH) {
      setTop((top + 1) % n);
    }
    setDx(0);
  };

  return (
    <div
      className={`album-stack${dx ? " dragging" : ""}`}
      role="group"
      aria-label={`${n} 张图片，左右滑动切换，点一下查看`}
      onPointerDown={(event) => {
        drag.current = { id: event.pointerId, x: event.clientX, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const d = drag.current;
        if (!d || d.id !== event.pointerId) return;
        const moved = event.clientX - d.x;
        if (!d.moved && Math.abs(moved) < 6) return;
        d.moved = true;
        setDx(moved);
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
    >
      {photos.map((path, j) => {
        const depth = (j - top + n) % n;
        if (depth > 2) return null;
        // 最上面那张跟着手指走、略转；后面的按拖动距离往前挪（浮上来）
        const d = depth === 0 ? 0 : depth - rise;
        const style = {
          "--d": d,
          "--dx": depth === 0 ? `${dx}px` : "0px",
          "--rot": depth === 0 ? `${dx * 0.06}deg` : "0deg",
          zIndex: n - depth,
        } as React.CSSProperties;
        return <img key={path} src={photoUrl(path)} alt="" draggable={false} style={style} />;
      })}
    </div>
  );
}
