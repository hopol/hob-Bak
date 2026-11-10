import { useEffect, useState, type ReactNode } from "react";

export function Empty({ children, action, large = false }: { children: ReactNode; action?: { label: string; onClick: () => void }; large?: boolean }) {
  return <div className={`empty${large ? " empty-large" : ""}`}>{children}{action ? <> · <button onClick={action.onClick}>{action.label}</button></> : null}</div>;
}

/** 读取中的提示等 300ms 还没读完才出现，读得快就不会一闪。 */
export function DelayedText({ text }: { text: string }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setVisible(true), 300); return () => clearTimeout(timer); }, []);
  return visible ? text : null;
}
