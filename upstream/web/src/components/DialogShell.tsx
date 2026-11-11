import type { FormEvent, PointerEvent, ReactNode } from "react";
import { createPortal } from "react-dom";

export function DialogShell({ label, title, className = "", onClose, onSubmit, children, actions }: { label: string; title: string; className?: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; children: ReactNode; actions: ReactNode }) {
  const backdrop = (event: PointerEvent<HTMLDivElement>) => { if (event.target === event.currentTarget) onClose(); };
  return createPortal(<div className="gcreate" role="dialog" aria-modal="true" aria-label={label} onPointerDown={backdrop}>
    <form className={`gcreate-card${className ? ` ${className}` : ""}`} onSubmit={onSubmit}>
      <div className="gcreate-title">{title}</div>{children}<div className="gcreate-acts">{actions}</div>
    </form>
  </div>, document.body);
}
