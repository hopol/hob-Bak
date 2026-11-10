// 设置页的公共外壳：页头、分组、几选一的分段控件。设置里的各分栏共用，尺寸和间距照 docs/design/v2。
import type { CSSProperties, ReactNode } from "react";
import { Icon, type IconName } from "../icons.tsx";

export function PageHead({ title, desc }: { title: string; desc: ReactNode }) {
  return (
    <div className="setintro">
      <div className="h">{title}</div>
      <div className="d">{desc}</div>
    </div>
  );
}

/** 几选一：分段控件（一条底槽里几段，选中的那段抬起来）。 */
export function Seg<K extends string>({
  items,
  value,
  onChange,
  disabled,
}: {
  items: { key: K; label: string }[];
  value: K;
  onChange: (key: K) => void;
  disabled?: boolean;
}) {
  return (
    <div className="seg" role="radiogroup" style={{ "--seg-count": items.length, "--seg-index": Math.max(0, items.findIndex((item) => item.key === value)) } as CSSProperties}>
      {items.map((item) => (
        <button
          key={item.key}
          role="radio"
          aria-checked={value === item.key}
          className={value === item.key ? "on" : undefined}
          onClick={() => onChange(item.key)}
          disabled={disabled}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** 键值卡片里的外链行：整行可点，右端带外链箭头。 */
export function LinkRow({ icon, label, value, href }: { icon?: IconName; label: string; value: string; href: string }) {
  return (
    <a className="kvrow linkrow" href={href} target="_blank" rel="noreferrer">
      <span className="k kicon">
        {icon ? <Icon name={icon} size={14} /> : null}
        {label}
      </span>
      <span className="v">
        <span className="link">{value}</span>
        <Icon name="out" size={13} />
      </span>
    </a>
  );
}

/** 一组设置：组内 8px，组与组 24px。 */
export function Group({ children }: { children: ReactNode }) {
  return <div className="group">{children}</div>;
}
