// 交接内容由助手自己写，完整显示在任务详情和转交卡片里。
export function splitBrief(text: string): { main: string; recent: string } {
  return { main: text, recent: "" };
}

export function Brief({ text }: { text: string }) {
  return <>{text}</>;
}
