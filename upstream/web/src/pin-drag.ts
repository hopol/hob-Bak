// 拖动置顶头像换位置：量出来的格子和指针位置换成新的先后。和界面无关，好单测；
// 指针事件和落盘在 components/PinDrag.ts。

/** 头像那一格在屏幕上的位置和大小（getBoundingClientRect 的几个数）。 */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 把 from 那一个挪到 to：中间依次让开，两头不出界。没变就还回原数组。 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return list;
  const at = Math.min(Math.max(to, 0), list.length - 1);
  if (at === from) return list;
  const out = list.slice();
  const [moved] = out.splice(from, 1);
  out.splice(at, 0, moved);
  return out;
}

/**
 * 指针落在哪一格：取中心离得最近的那格。按距离而不是按矩形包含判断，
 * 指针滑到两格中间、或者落在网格外面时也有确定的结果，不会来回跳。
 */
export function dropIndex(boxes: Box[], x: number, y: number): number {
  let best = -1;
  let bestDist = Infinity;
  boxes.forEach((box, index) => {
    const dx = x - (box.left + box.width / 2);
    const dy = y - (box.top + box.height / 2);
    const dist = dx * dx + dy * dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = index;
    }
  });
  return best;
}

/**
 * 指针移到 (x, y) 时新的先后：被拖的那个去找最近的一格站过去。
 * 被拖那一格按它此刻占的位置（不含跟手的位移）参与比较，所以没过中线就还留在原处。
 * 没换位置就把原数组还回去。
 */
export function reorderAt(ids: string[], boxes: Box[], id: string, x: number, y: number): string[] {
  const from = ids.indexOf(id);
  if (from < 0) return ids;
  const at = dropIndex(boxes, x, y);
  if (at < 0) return ids;
  return moveItem(ids, from, at);
}
