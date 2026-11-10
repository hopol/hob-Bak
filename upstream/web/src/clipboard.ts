// 复制进剪贴板。原文一字不改：模型回复里的 Markdown 标记、下划线路径都要留着，
// 只有回复引用的摘要才走 plain()。写不进去（http、没权限、老浏览器）返回 false，由调用方提示，不假装成功。
export async function copyText(text: string): Promise<boolean> {
  try {
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
