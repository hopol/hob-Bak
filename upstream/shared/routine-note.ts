// 定时任务到执行时间时留在对话里的那一行。数据里存的文字换过一次说法：
// 老记录写「到点了」，现在写「已到执行时间」，认的时候两种都要认。

export const ROUTINE_DUE_TEXT = "已到执行时间";
/** 老数据里那一行的说法；只在认老记录时用，界面不再写它。 */
export const ROUTINE_DUE_TEXT_LEGACY = "到点了";

/**
 * 这条提示是不是定时任务到执行时间的那一行。
 * 条目上存了 routineId 的按它认（新记录都有）；老记录没有 routineId，退回按文字认。
 */
export function isRoutineDueNote(text: string, routineId?: string): boolean {
  if (routineId) return true;
  return text.includes(ROUTINE_DUE_TEXT) || text.includes(ROUTINE_DUE_TEXT_LEGACY);
}
