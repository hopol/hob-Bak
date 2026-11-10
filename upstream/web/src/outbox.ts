// 发件箱：点了发送就先在对话里出现一条（iMessage 式，界面不等网络），附件在后台上传，
// 传完、发完由服务端那条真消息顶替；没发出去就留在原地标「未送达」，点了重试。
// 这一层只在前端，不写进 items（那是服务端的权威列表）。
import type { Item } from "../../shared/types.ts";

export interface Attachment {
  id: string;
  name: string;
  /** 上传好以后服务器上的路径 */
  path?: string;
  status: "uploading" | "done" | "failed";
}

export interface PendingMessage {
  localId: string;
  assistantId: string;
  at: string;
  text: string;
  quote?: { itemId: string; text: string };
  attachments: Attachment[];
  status: "sending" | "failed";
  error?: string;
}

/** 还没传完的附件在界面上用的占位路径：带原文件名（扩展名决定按图片还是文件显示）。 */
export function localPath(att: Pick<Attachment, "id" | "name">): string {
  return `pending/${att.id}/${att.name}`;
}

/** 画成一条普通的用户消息；附件传好了用真路径，没传好用占位路径。 */
export function pendingItem(p: PendingMessage): Item {
  return {
    kind: "user",
    id: p.localId,
    at: p.at,
    text: p.text,
    ...(p.quote ? { quote: p.quote } : {}),
    ...(p.attachments.length ? { files: p.attachments.map((a) => a.path ?? localPath(a)) } : {}),
  };
}

/** 服务端推来的这条用户消息是不是这条待发的（字一样、附件路径一样）。 */
export function isSentAs(p: PendingMessage, item: Item): boolean {
  if (item.kind !== "user" || p.status !== "sending" || item.text !== p.text) return false;
  const paths = p.attachments.map((a) => a.path);
  const files = item.files ?? [];
  return paths.length === files.length && paths.every((path, i) => path === files[i]);
}
