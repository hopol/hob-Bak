import type { ReactNode } from "react";

export function DetailRow({ leading, title, detail, trailing = "›", onClick, className = "sidebar-row" }: { leading: ReactNode; title: ReactNode; detail?: ReactNode; trailing?: ReactNode; onClick: () => void; className?: string }) {
  return <button className={`list-row${className ? ` ${className}` : ""}`} onClick={onClick}>
    {leading}<span><strong>{title}</strong>{detail !== undefined ? <small>{detail}</small> : null}</span><b>{trailing}</b>
  </button>;
}
