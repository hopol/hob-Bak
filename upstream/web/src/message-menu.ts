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

export function menuPosition(bubble: Pick<DOMRect, "top" | "bottom" | "right">, area: Pick<DOMRect, "top" | "bottom" | "left" | "right">) {
  const height = 92;
  return {
    top: bubble.bottom + 8 + height <= area.bottom ? bubble.bottom + 8 : Math.max(area.top + 8, bubble.top - height - 8),
    left: Math.max(area.left + 8, Math.min(bubble.right - 160, area.right - 168)),
  };
}

export type MenuAction = { type: "open"; id: string } | { type: "close" } | { type: "outside"; inside: boolean };

export function messageMenu(state: string | null, action: MenuAction): string | null {
  if (action.type === "open") return action.id;
  if (action.type === "outside" && action.inside) return state;
  return null;
}
