// 待办：会话输入框上方那一条（连同在跑的任务）和只读清单。待办只归助手，任务没有；界面只显示进度，改由模型调 update_todos。
import { t } from "../../../shared/i18n.ts";
import { useState } from "react";
import type { TodoItem } from "../../../shared/types.ts";
import { Icon, type IconName } from "../icons.tsx";
import { fmtElapsed } from "../util.ts";

/** 做完了几项、一共几项。 */
export function todoProgress(items: TodoItem[] | undefined): { done: number; total: number } {
  const list = items ?? [];
  return { done: list.filter((item) => item.status === "done").length, total: list.length };
}

/** 现在在做的那一项：有 doing 的就是它，没有就是第一项还没做的。 */
export function todoCurrent(items: TodoItem[] | undefined): TodoItem | undefined {
  const list = items ?? [];
  return list.find((item) => item.status === "doing") ?? list.find((item) => item.status === "todo");
}

/** 还有没有没做完的。 */
export function todoUnfinished(items: TodoItem[] | undefined): boolean {
  const { done, total } = todoProgress(items);
  return total > 0 && done < total;
}

const TODO_STATE: Record<TodoItem["status"], { label: string; icon: IconName }> = {
  todo: { label: "未开始", icon: "ring" },
  doing: { label: "进行中", icon: "half" },
  done: { label: "已完成", icon: "check" },
};

/** 只读的清单：每项前面一个静止的状态图标。「进行中」只说明这一项轮到了，不代表助手此刻正在做，所以不转。 */
export function TodoList({ items, className = "" }: { items: TodoItem[]; className?: string }) {
  if (!items.length) return null;
  return (
    <ol className={`todo-list${className ? ` ${className}` : ""}`}>
      {items.map((item, index) => {
        const state = TODO_STATE[item.status];
        return (
          <li className={`todo-item ${item.status}`} key={`${index}-${item.text}`}>
            <button className="todo-icon" key={item.status} title={t(state.label)} aria-label={t(state.label)}>
              <Icon name={state.icon} size={13} />
            </button>
            <span className="todo-text">{item.text}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** 这个会话里正在跑的任务：标题、开始时间，点了滚到那张卡。 */
export type RunningJob = { id: string; title: string; since: string };

function toCard(id: string) {
  document.getElementById(`job-${id}`)?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
}

/**
 * 会话（单聊、综合、话题）里输入框上方那张小卡：这件事做到哪儿了。
 * 左边：助手在忙或有任务在跑时是转着的圈，没人在做时是暂停。中间是正在做的那项，最右边是 k/n 和细进度条。
 * 只有任务、没有待办时，这一条就是那个任务：中间写任务名，右边写用时。两样都没有就不出现。
 * 点开是只读的待办清单和在跑的任务，点任务滚到它的卡。
 */
export function TodoStrip({ items, jobs = [], busy = false }: { items?: TodoItem[]; jobs?: RunningJob[]; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  // 收起时先播完收起的动画再卸掉清单
  const [closing, setClosing] = useState(false);
  const toggle = () => {
    if (!open) { setOpen(true); setClosing(false); return; }
    setClosing(true);
    window.setTimeout(() => { setOpen(false); setClosing(false); }, 260);
  };
  const list = items ?? [];
  const todos = todoUnfinished(list);
  if (!todos && !jobs.length) return null;
  const { done, total } = todoProgress(list);
  const current = todoCurrent(list);
  const ratio = total ? done / total : 0;
  const summary = todos ? t("待办 {done}/{total}", { done, total }) : t("{n} 个任务进行中", { n: jobs.length });
  const one = jobs.length === 1 ? jobs[0] : undefined;
  // 只有一个任务、没有待办：这一条就是那个任务，点了直接到卡
  const direct = !todos && one;
  const moving = busy || jobs.length > 0;
  return (
    <div className={`todostrip${open ? " open" : ""}`}>
      <button className="todobar" aria-expanded={direct ? undefined : open} title={direct ? t("查看任务卡") : summary} onClick={() => (direct ? toCard(one.id) : toggle())}>
        {moving ? <Icon key="spin" name="spin" size={14} w={2.4} className="todobar-ring spin" /> : <Icon key="pause" name="pause" size={14} className="todobar-ring" />}
        {/* 展开时清单里已经有正在做的那项，这一行只写「待办」，不重复 */}
        {(() => {
          const now = todos ? (open ? t("待办") : (current?.text ?? summary)) : one ? one.title : summary;
          // 换到下一项时这一行淡入，不是硬切
          return <span className="todobar-now" key={now}>{now}</span>;
        })()}
        {todos ? (
          <>
            <span className="todobar-count">{done}/{total}</span>
            <span className="todobar-line" aria-hidden="true">
              <i style={{ width: `${Math.round(ratio * 100)}%` }} />
            </span>
          </>
        ) : one ? (
          <span className="todobar-count">{fmtElapsed(one.since)}</span>
        ) : null}
      </button>
      {open && !direct ? (
        <div className={`todostrip-list${closing ? " closing" : ""}`}>
          <TodoList items={todos ? list : []} />
          {jobs.length ? (
            <ul className="todo-jobs">
              {jobs.map((job) => (
                <li key={job.id}>
                  <button onClick={() => toCard(job.id)} title={t("查看任务卡")}>
                    <Icon name="spin" size={14} w={2.4} className="spin" />
                    <span className="todo-text">{job.title}</span>
                    <small>{fmtElapsed(job.since)}</small>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
