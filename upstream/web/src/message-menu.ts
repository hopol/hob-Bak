export type SwipeState = { x: number; y: number; direction: "pending" | "horizontal" | "vertical"; distance: number };

export function moveSwipe(state: SwipeState, x: number, y: number): SwipeState {
  const dx = x - state.x;
  const dy = y - state.y;
  let direction = state.direction;
  if (direction === "pending" && Math.hypot(dx, dy) > 8) {
    if (dx < -8 && Math.abs(dx) > Math.abs(dy) * 1.5) direction = "horizontal";
    else if (Math.abs(dy) > Math.abs(dx) || dx > 8) direction = "vertical";
  }
  return { ...state, direction, distance: direction === "horizontal" ? Math.max(0, -dx) : 0 };
}

export function swipeReply(state: SwipeState): boolean {
  return state.direction === "horizontal" && state.distance > 48;
}

export type MessageAction = "reply" | "copy" | "select" | "star" | "job";

export function actionsFor(kind: string): MessageAction[] {
  if (kind === "user" || kind === "assistant") return ["reply", "copy", "star", "select"];
  if (kind === "job") return ["reply", "job"];
  if (kind === "question" || kind === "image" || kind === "file") return ["reply"];
  return [];
}

export function menuPosition(bubble: Pick<DOMRect, "top" | "bottom" | "left" | "right">, area: Pick<DOMRect, "top" | "bottom" | "left" | "right">, right: boolean, count: number) {
  const height = count * 48;
  const available = area.bottom - area.top - height - 32;
  const clipped = bubble.bottom - bubble.top > available || (bubble.bottom > area.bottom && bubble.top < area.top + height + 16);
  const top = clipped ? Math.max(area.top + 8, Math.min(bubble.top, area.bottom - height - 24 - Math.min(available, bubble.bottom - bubble.top))) : bubble.top;
  const maxHeight = clipped ? Math.max(0, Math.min(available, area.bottom - height - 24 - top)) : undefined;
  const bottom = maxHeight === undefined ? bubble.bottom : top + maxHeight;
  return {
    top: bottom + 8 + height <= area.bottom - 8 ? bottom + 8 : Math.max(area.top + 8, top - height - 8),
    left: Math.max(area.left + 8, Math.min(right ? bubble.right - 240 : bubble.left, area.right - 248)),
    bubbleTop: top,
    maxHeight,
  };
}

export type MenuAction = { type: "open"; id: string } | { type: "close" } | { type: "outside"; inside: boolean };

export function messageMenu(state: string | null, action: MenuAction): string | null {
  if (action.type === "open") return action.id;
  if (action.type === "outside" && action.inside) return state;
  return null;
}
