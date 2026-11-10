// 贴底滚动的判断：从滚动位置和内容高度里算出「是不是还在底部」。
//
// 对话里滚动位置会自己动：内容长高（流式文字、卡片晚到、图片加载）、内容变矮（等文字的提示消失）、
// 上面掉了条目（只留最近 60 条）被浏览器往上收，这些都不是用户在翻。只有比「预期位置」更靠上的滚动
// 才算用户自己往上翻，所以调用方每次自己动了滚动位置（滚到底、给分页让位）都要记进预期位置。

export interface ScrollBox {
  /** 现在的滚动位置 */
  top: number;
  /** 内容总高 */
  height: number;
  /** 视口高 */
  view: number;
}

/** 离底部这么多像素以内还算贴底：内容抖动和轻微的回弹不会让人掉出贴底状态。 */
export const STICK_GAP = 80;

/** 这个位置能滚到的最大 top。 */
export function maxTop(box: ScrollBox): number {
  return Math.max(0, box.height - box.view);
}

/** 内容高度变了以后预期的位置：贴底时就是新的底部；没贴底时最多被浏览器往上收（内容变矮）。 */
export function expectAfterResize(stuck: boolean, expect: number, box: ScrollBox): number {
  const max = maxTop(box);
  return stuck ? max : Math.min(expect, max);
}

/**
 * 处理一次滚动事件：离底部很近就重新贴底；否则只有位置比预期更靠上，才算用户自己往上翻。
 * 预期位置每次都会跟着实际位置走，所以一次上翻只判一次，不会连着误判。
 */
export function afterScroll(stuck: boolean, expect: number, box: ScrollBox): { stuck: boolean; expect: number } {
  const gap = box.height - box.top - box.view;
  if (gap < STICK_GAP) return { stuck: true, expect: box.top };
  if (box.top < Math.min(expect, maxTop(box)) - 2) return { stuck: false, expect: box.top };
  return { stuck, expect: box.top };
}
