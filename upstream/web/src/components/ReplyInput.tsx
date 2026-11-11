import { useState } from "react";

export function ReplyInput({ value, onChange, sending, placeholder, onSend, onCancel, className = "replybox", autoFocus = false }: { value: string; onChange: (value: string) => void; sending: boolean; placeholder: string; onSend: () => void | Promise<void>; onCancel?: () => void; className?: string; autoFocus?: boolean }) {
  return <div className={className}>
    <input autoFocus={autoFocus} value={value} disabled={sending} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { event.stopPropagation(); if (event.nativeEvent.isComposing) return; if (event.key === "Enter") void onSend(); if (event.key === "Escape") onCancel?.(); }} />
    <button className="hob-btn hob-btn-primary" disabled={sending || !value.trim()} onClick={() => void onSend()}>发送</button>
  </div>;
}
