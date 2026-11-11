// 看大图：铺满屏幕。手机双指缩放、单指拖动、双击放大、单击关闭；
// 电脑滚轮上下看、触控板捏合或 Ctrl/⌘+滚轮缩放、拖动、双击放大、点空白处关闭；底部按钮和 + - 0 键缩放。
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from "react";
import { Icon } from "../icons.tsx";

type View = { s: number; x: number; y: number };
type Size = { w: number; h: number };
type Point = { x: number; y: number };

/** 铺开时四周留的空。 */
const GAP = 16;
/** 两次点击算双击的间隔。 */
const DOUBLE_TAP_MS = 280;

/** 刚打开时的大小：整张放进屏幕，小图最多放大 2 倍；特别长的图（整页截图）按宽度铺开，从顶上往下看。 */
export function fitScale(img: Size, area: Size): number {
  const vw = Math.max(area.w - GAP * 2, 1);
  const vh = Math.max(area.h - GAP * 2, 1);
  if (img.h / img.w > (2 * vh) / vw) return Math.min(1, vw / img.w);
  return Math.min(vw / img.w, vh / img.h, 2);
}

/** 放大的上限：原图的 2 倍，或者铺开大小的 4 倍，取大的。 */
function maxScale(fit: number): number {
  return Math.max(fit * 4, 2);
}

/** 图比屏幕小的方向居中，比屏幕大的方向不许拖出空白。 */
export function clampView(view: View, img: Size, area: Size): View {
  const axis = (pos: number, length: number, room: number) => {
    const scaled = length * view.s;
    if (scaled <= room) return (room - scaled) / 2;
    return Math.min(0, Math.max(room - scaled, pos));
  };
  return { s: view.s, x: axis(view.x, img.w, area.w), y: axis(view.y, img.h, area.h) };
}

/** 以屏幕上的 point 为中心缩放到 s。 */
function zoomAround(view: View, s: number, point: Point): View {
  const ratio = s / view.s;
  return { s, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio };
}

export function ImageViewer({ src, thumb, download, name, onClose }: { src: string; thumb?: string; download?: string; name: string; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [img, setImg] = useState<Size | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<View | null>(null);
  const [animate, setAnimate] = useState(false);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: View; from: Point; dist: number; moved: boolean; pinched: boolean } | null>(null);
  const lastTap = useRef<{ at: number; point: Point } | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const lastType = useRef("mouse");
  // 按下时点在不在图上：setPointerCapture 以后抬起事件的 target 是外层，只能按下时记
  const downOnImage = useRef(false);

  const area = useCallback((): Size => ({ w: box.current?.clientWidth ?? window.innerWidth, h: box.current?.clientHeight ?? window.innerHeight }), []);
  const fit = img ? fitScale(img, area()) : 1;

  const reset = useCallback((animated = false) => {
    if (!img) return;
    const a = area();
    const s = fitScale(img, a);
    // 长图从顶上开始看，其余居中
    setAnimate(animated);
    setView(clampView({ s, x: 0, y: 0 }, img, a));
  }, [img, area]);

  useEffect(() => reset(), [reset]);

  const set = useCallback((next: View, animated: boolean) => {
    if (!img) return;
    setAnimate(animated);
    setView(clampView(next, img, area()));
  }, [img, area]);

  /** 以 point 为中心缩放，大小限制在铺开和上限之间。 */
  const zoomTo = useCallback((from: View, s: number, point: Point) => zoomAround(from, Math.min(maxScale(fit), Math.max(fit, s)), point), [fit]);

  /** 双击：没放大就放大到原图大小（至少两倍），放大了就回到铺开。 */
  const toggleAt = useCallback((point: Point) => {
    if (!view || !img) return;
    if (view.s > fit * 1.05) return reset(true);
    set(zoomTo(view, Math.max(fit * 2, 1), point), true);
  }, [view, img, fit, reset, set, zoomTo]);

  const zoomBy = useCallback((factor: number) => {
    if (!view) return;
    set(zoomTo(view, view.s * factor, { x: area().w / 2, y: area().h / 2 }), true);
  }, [view, set, area, zoomTo]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      else if (event.key === "+" || event.key === "=") zoomBy(1.5);
      else if (event.key === "-") zoomBy(1 / 1.5);
      else if (event.key === "0") reset(true);
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, zoomBy, reset]);

  useEffect(() => {
    const onResize = () => reset();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [reset]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  // 滚轮要能 preventDefault，React 的 onWheel 是 passive，只能自己挂
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!view) return;
      const rect = el.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        // 触控板捏合在浏览器里就是带 ctrlKey 的滚轮
        const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        set(zoomTo(view, view.s * Math.exp(-event.deltaY * 0.01), point), false);
      } else {
        set({ s: view.s, x: view.x - event.deltaX, y: view.y - event.deltaY }, false);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [view, set, zoomTo]);

  const local = (event: ReactPointerEvent): Point => {
    const rect = box.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  /** 两根手指：中点和距离。 */
  const pair = () => {
    const [a, b] = [...pointers.current.values()];
    return { mid: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 }, dist: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
  };

  /** 手指数变了：从现在的位置重新算起，不跳。 */
  const restart = (pinched: boolean) => {
    if (!view || pointers.current.size === 0) return (gesture.current = null);
    const moved = gesture.current?.moved ?? false;
    if (pointers.current.size >= 2) {
      const { mid, dist } = pair();
      gesture.current = { start: view, from: mid, dist, moved: true, pinched: true };
    } else {
      gesture.current = { start: view, from: [...pointers.current.values()][0]!, dist: 0, moved, pinched };
    }
  };

  const onPointerDown = (event: ReactPointerEvent) => {
    if (!view) return;
    lastType.current = event.pointerType;
    if (pointers.current.size === 0) downOnImage.current = (event.target as HTMLElement).tagName === "IMG";
    box.current!.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, local(event));
    restart(gesture.current?.pinched ?? false);
  };

  const onPointerMove = (event: ReactPointerEvent) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current || !img) return;
    pointers.current.set(event.pointerId, local(event));
    const g = gesture.current;
    if (pointers.current.size >= 2) {
      const { mid, dist } = pair();
      const zoomed = zoomTo(g.start, g.start.s * (dist / g.dist), g.from);
      set({ s: zoomed.s, x: zoomed.x + mid.x - g.from.x, y: zoomed.y + mid.y - g.from.y }, false);
      return;
    }
    const point = local(event);
    const dx = point.x - g.from.x;
    const dy = point.y - g.from.y;
    if (!g.moved && Math.hypot(dx, dy) < 6) return;
    g.moved = true;
    set({ s: g.start.s, x: g.start.x + dx, y: g.start.y + dy }, false);
  };

  const onPointerUp = (event: ReactPointerEvent) => {
    if (!pointers.current.delete(event.pointerId)) return;
    const g = gesture.current;
    if (pointers.current.size > 0) return restart(true);
    gesture.current = null;
    if (!g || g.moved || g.pinched || event.type === "pointercancel") return;
    const point = local(event);
    if (event.pointerType === "mouse") {
      // 电脑：点空白处关闭，点图不动（双击交给 onDoubleClick）
      if (!downOnImage.current) onClose();
      return;
    }
    // 手机：单击关闭，双击放大；单击要等一下看是不是双击
    const last = lastTap.current;
    if (last && event.timeStamp - last.at < DOUBLE_TAP_MS && Math.hypot(point.x - last.point.x, point.y - last.point.y) < 30) {
      window.clearTimeout(closeTimer.current);
      lastTap.current = null;
      toggleAt(point);
      return;
    }
    lastTap.current = { at: event.timeStamp, point };
    closeTimer.current = window.setTimeout(() => {
      lastTap.current = null;
      onClose();
    }, DOUBLE_TAP_MS);
  };

  const onDoubleClick = (event: ReactMouseEvent) => {
    // 手机的双击自己处理过了，浏览器补发的 dblclick 不再算一次
    if (lastType.current !== "mouse" || !downOnImage.current) return;
    const rect = box.current!.getBoundingClientRect();
    toggleAt({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  const percent = view ? Math.round(view.s * 100) : 100;
  const stop = (event: SyntheticEvent) => event.stopPropagation();

  return (
    <div
      className="iv"
      role="dialog"
      aria-label={name}
      ref={box}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <img
        src={src}
        alt={name}
        draggable={false}
        // 没写宽高的 svg 有的浏览器报 0：按 300×150（浏览器的默认尺寸）算
        onLoad={(event) => setImg({ w: event.currentTarget.naturalWidth || 300, h: event.currentTarget.naturalHeight || 150 })}
        onError={() => setFailed(true)}
        className={animate ? "iv-img iv-anim" : "iv-img"}
        style={img && view ? { width: img.w, height: img.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})` } : { visibility: "hidden" }}
      />
      {!img && !failed ? (
        <div className="iv-wait">
          {thumb ? <img src={thumb} alt="" aria-hidden="true" draggable={false} /> : null}
          <span className="fp-img-spin" aria-label="图片加载中"><Icon name="spin" size={18} w={2.2} className="spin" /></span>
        </div>
      ) : null}
      {failed ? <div className="iv-wait"><span className="iv-error">图片加载失败</span></div> : null}
      <div className="iv-top" onPointerDown={stop} onPointerUp={stop} onDoubleClick={stop}>
        {download ? <a title="下载" aria-label="下载" href={download} download={name}><Icon name="dl" size={19} /></a> : null}
        <button title="关闭" aria-label="关闭" onClick={onClose}><Icon name="close" size={20} /></button>
      </div>
      {img && view ? (
        <div className="iv-bar" onPointerDown={stop} onPointerUp={stop} onDoubleClick={stop}>
          <button title="缩小" aria-label="缩小" disabled={view.s <= fit * 1.001} onClick={() => zoomBy(1 / 1.5)}><Icon name="minus" size={18} /></button>
          <button className="iv-pct" title="铺满屏幕" onClick={() => reset(true)}>{percent}%</button>
          <button title="放大" aria-label="放大" disabled={view.s >= maxScale(fit) * 0.999} onClick={() => zoomBy(1.5)}><Icon name="plus" size={18} /></button>
        </div>
      ) : null}
    </div>
  );
}
