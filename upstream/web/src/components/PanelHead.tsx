import { t } from "../../../shared/i18n.ts";
import type { ReactNode } from "react";
import { Icon } from "../icons.tsx";
import { backPanel, closePanelPages, closeSheet, collapsePanel, useApp } from "../store.ts";

export function CollapsePanelButton() {
  return <button className="hob-icon-btn panel-close" title={t("收起右栏")} aria-label={t("收起右栏")} onClick={collapsePanel}><Icon name="close" size={17} /></button>;
}

export function PanelHead({ title, children, root = false, close = false, className = "" }: { title?: ReactNode; children?: ReactNode; root?: boolean; close?: boolean; className?: string }) {
  const s = useApp();
  const mobileOnly = root || (s.page !== "main" && s.panelStack.length <= 1);
  return <div className={`panel-head ${className}`}>
    <button className={`hob-icon-btn${mobileOnly ? " panel-mobile-back" : ""}`} title={t("返回")} onClick={root ? closeSheet : backPanel}><Icon name="left" size={18} /></button>
    {title}
    {children}
    {/* 非主界面的覆盖层保留原来的关闭方式。 */}
    {close && s.panelStack.length > 1 ? <button className={`hob-icon-btn panel-close${s.page === "main" ? " panel-legacy-close" : ""}`} title={t("关闭")} onClick={closePanelPages}><Icon name="close" size={17} /></button> : null}
    {s.page === "main" ? <CollapsePanelButton /> : null}
  </div>;
}
