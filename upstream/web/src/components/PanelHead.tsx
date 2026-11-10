import type { ReactNode } from "react";
import { Icon } from "../icons.tsx";
import { backPanel, closePanelPages, closeSheet, useApp } from "../store.ts";

export function PanelHead({ title, children, root = false, close = false, className = "" }: { title?: ReactNode; children?: ReactNode; root?: boolean; close?: boolean; className?: string }) {
  const s = useApp();
  const mobileOnly = root || (s.page !== "main" && s.panelStack.length <= 1);
  return <div className={`panel-head ${className}`}>
    <button className={`hob-icon-btn${mobileOnly ? " panel-mobile-back" : ""}`} title="返回" onClick={root ? closeSheet : backPanel}><Icon name="left" size={18} /></button>
    {title}
    {children}
    {close ? <button className="hob-icon-btn panel-close" title="关闭" onClick={closePanelPages}><Icon name="close" size={17} /></button> : null}
  </div>;
}
