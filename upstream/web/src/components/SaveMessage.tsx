import { useEffect, useState } from "react";

export function useSaveMessage() {
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    if (message !== "已保存") return;
    const timer = setTimeout(() => setMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [message]);
  return [message, setMessage] as const;
}

export function SaveMessage({ message, toast = false }: { message: string | null; toast?: boolean }) {
  return message ? <span className={`${message === "已保存" ? "okline" : "badline"}${toast ? " savetoast" : ""}`} role="status">{message}</span> : null;
}
