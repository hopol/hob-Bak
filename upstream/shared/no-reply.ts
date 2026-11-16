// 系统事件那一轮的「不说话」出口：模型只回 NO_REPLY，这一轮写的字都不给用户看。
// 什么时候回由提示词讲、模型判断；这个词本身任何时候都不显示，由代码保证。

export const NO_REPLY = "NO_REPLY";

/** 去掉一段文字首尾的 NO_REPLY：这个词是给系统看的，显示给用户时一律去掉。 */
export function stripNoReply(text: string): string {
  let out = text.trim();
  while (out.startsWith(NO_REPLY)) out = out.slice(NO_REPLY.length).trim();
  while (out.endsWith(NO_REPLY)) out = out.slice(0, -NO_REPLY.length).trim();
  return out;
}

/** 这一段是在说「这一轮不用说」：去掉首尾空白后整段就是它，或者以它开头、以它结尾。 */
export function saysNoReply(text: string): boolean {
  const out = text.trim();
  return !!out && (out.startsWith(NO_REPLY) || out.endsWith(NO_REPLY));
}
