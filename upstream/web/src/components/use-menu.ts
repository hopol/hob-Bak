import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** 行尾的菜单向左展开（right）；行首的按钮向右展开（left）。 */
export function useMenu(align: "left" | "right" = "right") {
  const [menu, setMenu] = useState<{ id: string; anchor: HTMLElement } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!menu || !box.current) return;
    const anchor = menu.anchor.getBoundingClientRect();
    const rect = box.current.getBoundingClientRect();
    const x = align === "left" ? anchor.left : anchor.right - rect.width;
    box.current.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    // 下面放不下就开在按钮上面（比如输入框里的加号），不压住按钮
    const below = anchor.bottom + 4 + rect.height <= window.innerHeight - 8;
    box.current.style.top = `${below ? anchor.bottom + 4 : Math.max(8, anchor.top - rect.height - 4)}px`;
  });
  useEffect(() => {
    if (!menu) return;
    const outside = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !menu.anchor.contains(e.target as Node)) setMenu(null);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); setMenu(null); }
    };
    // 菜单自己能滚（知识库多时），只有外面滚动才关
    const scroll = (e: Event) => { if (!box.current?.contains(e.target as Node)) setMenu(null); };
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("scroll", scroll, true);
    };
  }, [menu]);
  return {
    menu, box, close: () => setMenu(null),
    toggle: (id: string, anchor: HTMLElement) => setMenu((current) => current?.id === id ? null : { id, anchor }),
  };
}
