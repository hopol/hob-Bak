// 交给任务、转给别的助手的那段话：原话、附件、备注照常显示；「最近的对话」和转交时带过去的待办是给模型补的背景，折起来。
import { t } from "../../../shared/i18n.ts";

const RECENT = "最近的对话：";
/** 转交时带过去的待办（server/src/router-tools.ts 的 message_assistant）：「Hob」转交前列过的待办，没做完的： */
const CARRIED = /^「[^」\n]{1,40}」转交前列过的待办/u;
/** 下一段是这些段头时，「最近的对话」那一段就结束了（格式见 server/src/router.ts 的 originalWordsText）。 */
const SECTION = /^(附件：|用户原话（|按技能「|[^\n：]{1,40} 的备注：|[^\n：]{1,40} 转来（)/u;

/** 拆成给人看的部分和折起来的背景（最近的对话去掉段头）。转来的话里套着转来的话时，几段合在一起。 */
export function splitBrief(text: string): { main: string; recent: string } {
  const main: string[] = [];
  const recent: string[] = [];
  let inRecent = false;
  for (const part of text.split("\n\n")) {
    if (part.startsWith(RECENT) || CARRIED.test(part)) inRecent = true;
    else if (SECTION.test(part)) inRecent = false;
    if (!inRecent) main.push(part);
    else recent.push(part.startsWith(RECENT) ? part.slice(RECENT.length).replace(/^\n/, "") : part);
  }
  return { main: main.join("\n\n"), recent: recent.join("\n\n") };
}

export function Brief({ text }: { text: string }) {
  const { main, recent } = splitBrief(text);
  return (
    <>
      {main}
      {recent ? (
        <details className="brief-recent">
          <summary>{t("附带的背景")}</summary>
          <div>{recent}</div>
        </details>
      ) : null}
    </>
  );
}
