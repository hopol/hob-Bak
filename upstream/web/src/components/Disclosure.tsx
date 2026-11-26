import type { ReactNode } from "react";
import { Icon } from "../icons.tsx";

/** 全站统一的就地展开行：整行可点，右侧显示数量和线性箭头。 */
export function Disclosure({
  label,
  count,
  open,
  onToggle,
  children,
  className = "",
  disabled = false,
}: {
  label: ReactNode;
  count?: ReactNode;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <div className={`disclosure${open ? " open" : ""}${className ? ` ${className}` : ""}`}>
      <button
        type="button"
        className="disclosure-row"
        aria-expanded={open}
        disabled={disabled}
        onClick={onToggle}
      >
        <span className="disclosure-label">{label}</span>
        <span className="disclosure-end">
          {count !== undefined ? <span className="disclosure-count">{count}</span> : null}
          <Icon name="down" size={14} className="disclosure-arrow" />
        </span>
      </button>
      {children !== undefined ? (
        <div className={`expand${open ? " open" : ""}`} inert={!open}>
          <div>{children}</div>
        </div>
      ) : null}
    </div>
  );
}
