import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../icons.tsx";

type Option = { value: string; label: string; disabled?: boolean };

export function Select({ value, onChange, options, disabled, className, "aria-label": label }: {
  value: string; onChange: (value: string) => void; options: Option[]; disabled?: boolean; className?: string; "aria-label"?: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState<React.CSSProperties>({ visibility: "hidden" });
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const show = () => {
    const selected = options.findIndex((option) => option.value === value && !option.disabled);
    setActive(selected >= 0 ? selected : options.findIndex((option) => !option.disabled));
    setPosition({ visibility: "hidden" });
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (!open || !trigger.current || !popup.current) return;
    const rect = trigger.current.getBoundingClientRect();
    // 选项的字和按钮上的字左边对齐：减去按钮内边距，补上列表外框和选项的内边距
    const inset = parseFloat(getComputedStyle(trigger.current).paddingLeft) || 0;
    const shift = (parseFloat(getComputedStyle(popup.current).paddingLeft) || 0) + (popup.current.clientLeft || 0) + (parseFloat(getComputedStyle(popup.current.querySelector('[role="option"]') ?? popup.current).paddingLeft) || 0) - inset;
    const width = Math.min(window.innerWidth - 16, Math.max(rect.width + shift * 2, popup.current.offsetWidth));
    const height = Math.min(popup.current.scrollHeight, window.innerHeight - 16);
    const below = window.innerHeight - rect.bottom - 8;
    const above = rect.top - 8;
    const up = below < height && above > below;
    const maxHeight = Math.max(0, up ? above : below);
    setPosition({ left: Math.max(8, Math.min(rect.left - shift, window.innerWidth - width - 8)), top: up ? Math.max(8, rect.top - Math.min(height, maxHeight) - 4) : rect.bottom + 4, width, maxHeight });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!trigger.current?.contains(event.target as Node) && !popup.current?.contains(event.target as Node)) close(); };
    const dismiss = (event: Event) => { if (!popup.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("resize", dismiss); window.removeEventListener("scroll", dismiss, true); };
  }, [open]);
  useEffect(() => { if (open && active >= 0) popup.current?.querySelectorAll<HTMLElement>('[role="option"]')[active]?.scrollIntoView?.({ block: "nearest" }); }, [open, active]);
  const move = (direction: number, start = active) => {
    for (let i = start + direction; i >= 0 && i < options.length; i += direction) if (!options[i].disabled) { setActive(i); break; }
  };
  const choose = (index: number) => { const option = options[index]; if (option && !option.disabled) { onChange(option.value); close(); } };
  return <>
    <button ref={trigger} type="button" className={`pick select-trigger${className ? ` ${className}` : ""}`} disabled={disabled} aria-label={label} aria-haspopup="listbox" aria-expanded={open} onClick={() => open ? close() : show()} onKeyDown={(event) => {
      if (!open && ["Enter", " ", "ArrowDown"].includes(event.key)) { event.preventDefault(); show(); return; }
      if (!open) return;
      if (event.key === "Escape") { event.preventDefault(); close(); }
      else if (event.key === "ArrowDown") { event.preventDefault(); move(1); }
      else if (event.key === "ArrowUp") { event.preventDefault(); move(-1); }
      else if (event.key === "Home") { event.preventDefault(); move(1, -1); }
      else if (event.key === "End") { event.preventDefault(); move(-1, options.length); }
      else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(active); }
    }}><span>{options.find((option) => option.value === value)?.label ?? ""}</span><Icon name="down" size={14} /></button>
    {open && createPortal(<div ref={popup} className="amenu select-popup" style={position} role="listbox" aria-label={label} onScroll={(event) => event.stopPropagation()}>{options.map((option, index) => <button key={`${option.value}-${index}`} type="button" role="option" aria-selected={option.value === value} disabled={option.disabled} className={index === active ? "sel" : ""} onMouseEnter={() => !option.disabled && setActive(index)} onClick={() => choose(index)}><span>{option.label}</span>{option.value === value && <Icon name="check" size={15} />}</button>)}</div>, document.body)}
  </>;
}
