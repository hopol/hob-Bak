import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AssistantSummary, GroupSummary } from "../../shared/types.ts";

// 组件只看 store 里的数据；动作换成可断言的空函数（服务端行为另在 topics-mock.test.ts 里测）。
const selected: string[] = [];
const state = vi.hoisted(() => ({ groups: [] as GroupSummary[], assistants: [] as AssistantSummary[], gsel: null as string | null, projects: {}, groupItems: {}, jobs: {} as Record<string, unknown> }));

vi.mock("./store.ts", () => ({
  useApp: () => state,
  selectGroup: async (id: string) => { selected.push(id); },
  openGroupHome: async (id: string) => { selected.push(id); },
  openTopic: async () => null,
  closeTopic: async () => null,
  reopenTopic: async () => null,
  goHome: () => undefined,
  leaveTopicList: () => undefined,
  openKnowledge: () => undefined,
  openSettings: () => undefined,
  openProject: () => undefined,
  openFilePreview: () => undefined,
  openJob: () => undefined,
  startProject: async () => null,
  doneSubtask: async () => null,
  sendProjectNote: async () => null,
}));
vi.mock("react-dom", async (importOriginal) => ({ ...(await importOriginal<typeof import("react-dom")>()), createPortal: (node: unknown) => node }));

import { topicFace, topicGroups, topicPreview, topicStamp, groupSidebarFor, workflowInfo, WORKFLOWS } from "../src/topics.ts";
import { ClosedTopic, GroupSidebar, PlaceJobs, TopicRow } from "./components/Topics.tsx";
import { TopicCard } from "./components/Projects.tsx";

const at = (h: number, m = 0) => new Date(2026, 10, 8, h, m).toISOString();

function asst(id: string, name: string, duty = ""): AssistantSummary {
  return { id, name, duty, sprite: "page", primary: false, pinned: false, hidden: false, notify: false, instructions: "", createdAt: at(8), unread: 0, busy: false };
}

function group(id: string, extra: Partial<GroupSummary> = {}): GroupSummary {
  return {
    id,
    name: id,
    purpose: "这个群负责的事",
    ownerId: "po",
    members: ["po", "dev", "qa"],
    createdAt: at(8),
    unread: 0,
    busy: [],
    ...extra,
  };
}

const assistants = [asst("po", "产品负责人"), asst("dev", "开发"), asst("qa", "测试")];

const host = group("g-topics", { name: "Hob 开发", workflow: "software" });
const doing = group("t-remember", {
  name: "登录页加「记住我」",
  parentId: "g-topics",
  createdBy: "po",
  last: { at: at(9, 50), speaker: "dev", text: "收到，在做了" },
  project: { id: "p-1", title: "登录页加「记住我」", stage: "doing", done: 1, total: 4, waitingUser: false, current: "dev" },
});
const waiting = group("t-export", {
  name: "导出月度报表",
  parentId: "g-topics",
  last: { at: at(9, 31), speaker: "po", text: "有两个问题要你定" },
  unread: 2,
  project: { id: "p-2", title: "导出月度报表", stage: "clarify", done: 0, total: 0, waitingUser: true, current: "po" },
});
const reviewing = group("t-upload", {
  name: "上传大文件失败",
  parentId: "g-topics",
  last: { at: at(9, 47), speaker: "qa", text: "第 3 条在复测" },
  project: { id: "p-3", title: "上传大文件失败", stage: "review", done: 3, total: 3, waitingUser: false, current: "qa" },
});
const closedDone = group("t-export-month", {
  name: "导出加按月筛选",
  parentId: "g-topics",
  closedAt: at(3, 16),
  closeNote: "4 条验收标准都过了，已上线",
  last: { at: at(3, 16), speaker: "po", text: "已上线" },
  project: { id: "p-4", title: "导出加按月筛选", stage: "done", done: 1, total: 1, waitingUser: false },
});
const closedDropped = group("t-colorway", {
  name: "首页配色改版",
  parentId: "g-topics",
  closedAt: at(5, 11),
  closeNote: "你说先不做了",
  project: { id: "p-5", title: "首页配色改版", stage: "dropped", done: 0, total: 0, waitingUser: false },
});

function setState(groups: GroupSummary[], gsel: string | null = null) {
  state.groups = groups;
  state.assistants = assistants;
  state.gsel = gsel;
}

const render = (node: React.ReactElement) => renderToStaticMarkup(node);

describe("话题的数据", () => {
  it("按关没关分组：进行中最近有消息的在前，关了的最近关的在前", () => {
    const { active, closed } = topicGroups([host, doing, waiting, reviewing, closedDone, closedDropped], "g-topics");
    expect(active.map((g) => g.id)).toEqual(["t-remember", "t-upload", "t-export"]);
    expect(closed.map((g) => g.id)).toEqual(["t-colorway", "t-export-month"]);
    // 群自己的那条不算话题
    expect(topicGroups([host], "g-topics")).toEqual({ active: [], closed: [] });
  });

  it("状态标签：等你回答最要紧，没关的按阶段写，关了的写已完成或已放弃，没事项不写", () => {
    expect(topicStamp(waiting)).toEqual({ text: "等你回答", tone: "ask" });
    expect(topicStamp(doing)).toEqual({ text: "执行 1/4", tone: "stage" });
    expect(topicStamp(reviewing)).toEqual({ text: "验收", tone: "stage" });
    expect(topicStamp({ ...doing, project: { ...doing.project!, stage: "clarify" } })).toEqual({ text: "需求澄清", tone: "stage" });
    expect(topicStamp({ ...doing, project: { ...doing.project!, stage: "plan", done: 0, total: 0 } })).toEqual({ text: "拆分", tone: "stage" });
    expect(topicStamp({ ...doing, project: { ...doing.project!, stage: "plan", done: 0, total: 2, waitingUser: true } })).toEqual({ text: "等你开始", tone: "ask" });
    expect(topicStamp(closedDone)).toEqual({ text: "已完成", tone: "done" });
    expect(topicStamp(closedDropped)).toEqual({ text: "已放弃", tone: "dropped" });
    expect(topicStamp(group("t-plain", { parentId: "g-home", closedAt: at(1) }))).toBeNull();
    expect(topicStamp(group("t-plain", { parentId: "g-home" }))).toBeNull();
  });

  it("头像按说明的顺序取：项目轮到谁、最后一条是助手说的、群主", () => {
    expect(topicFace(doing)).toBe("dev");
    expect(topicFace({ ...doing, project: undefined })).toBe("dev");
    expect(topicFace({ ...doing, project: undefined, last: { at: at(9), speaker: "user", text: "我说的" } })).toBe("po");
    expect(topicFace({ ...doing, project: undefined, last: undefined })).toBe("po");
  });

  it("预览：关了的先写关闭时留的结论", () => {
    expect(topicPreview(closedDone, assistants)).toBe("4 条验收标准都过了，已上线");
    expect(topicPreview({ ...closedDone, closeNote: undefined }, assistants)).toBe("产品负责人：已上线");
    expect(topicPreview(doing, assistants)).toBe("开发：收到，在做了");
  });

  it("工作方式：软件开发有那串阶段，「无」提示去群设置里选", () => {
    expect(workflowInfo("software").label).toBe("软件开发");
    expect(workflowInfo("software").flow).toBe("需求澄清 → 需求说明 → 拆分 → 执行 → 验收");
    expect(workflowInfo(undefined).label).toBe("无");
    expect(workflowInfo(undefined).flow).toBe("在群设置里选");
    expect(WORKFLOWS[0].id).toBeNull();
  });

  it("左栏进不进二级页：选中话题时是它所属的群，返回首页时不是", () => {
    const groups = [host, doing];
    expect(groupSidebarFor("t-remember", false, groups)?.id).toBe("g-topics");
    expect(groupSidebarFor("g-topics", false, groups)?.id).toBe("g-topics");
    expect(groupSidebarFor("g-topics", true, groups)).toBeUndefined();
    expect(groupSidebarFor(null, false, groups)).toBeUndefined();
    expect(groupSidebarFor("hob", false, groups)).toBeUndefined();
  });
});

describe("左栏二级页", () => {
  it("列出综合、进行中的话题和数量、已关闭的数量", () => {
    setState([host, doing, waiting, reviewing, closedDone], "t-remember");
    const html = render(<GroupSidebar />);
    expect(html).toContain("Hob 开发");
    expect(html).toContain("3 位成员 · 软件开发");
    expect(html).toContain("综合");
    expect(html).toContain("进行中 3");
    expect(html).toContain("已关闭 1");
    for (const name of ["登录页加「记住我」", "导出月度报表", "上传大文件失败", "导出加按月筛选"]) expect(html).toContain(name);
    // 选中的话题高亮，返回按钮在头部
    expect(html).toMatch(/class="list-row home-row topic-row sel"/);
    expect(html).toContain("返回首页");
    expect(html).toContain("开新话题");
  });

  it("超过五个已关闭的先列五个，给一个查看全部的入口", () => {
    const many = Array.from({ length: 7 }, (_, i) => group(`c-${i}`, { name: `关掉的 ${i}`, parentId: "g-topics", closedAt: at(1, 7 - i) }));
    setState([host, ...many], "g-topics");
    const html = render(<GroupSidebar />);
    expect(html).toContain("已关闭 7");
    expect(html).toContain("查看全部已关闭的话题");
    expect(html).toContain("关掉的 0");
    expect(html).not.toContain("关掉的 6");
  });

  it("「无」工作方式的群，头部只写人数", () => {
    setState([group("g-home", { name: "家里机器", members: ["hob", "house"] })], "g-home");
    const html = render(<GroupSidebar />);
    expect(html).toContain("2 位成员");
    expect(html).not.toContain("软件开发");
  });
});

describe("话题行和话题卡", () => {
  it("行里写状态标签、预览和未读数", () => {
    setState([host, waiting], "g-topics");
    const html = render(<TopicRow g={waiting} />);
    expect(html).toContain("导出月度报表");
    expect(html).toContain("等你回答");
    expect(html).toContain("产品负责人：有两个问题要你定");
    expect(html).toContain(">2<");
    const doingHtml = render(<TopicRow g={doing} />);
    expect(doingHtml).toContain("执行 1/4");
    expect(doingHtml).toContain("开发");
  });

  it("已关闭的行灰一些，标签是已完成或已放弃", () => {
    setState([host, closedDone, closedDropped], "g-topics");
    const done = render(<TopicRow g={closedDone} />);
    expect(done).toContain("topic-row closed");
    expect(done).toContain("已完成");
    expect(done).toContain("4 条验收标准都过了，已上线");
    expect(render(<TopicRow g={closedDropped} />)).toContain("已放弃");
  });

  it("话题卡显示名字、阶段条、最后一条和「进入话题」，关了的写已关闭和结论", () => {
    setState([host, doing], "g-topics");
    selected.length = 0;
    const html = render(<TopicCard topicId="t-remember" fresh={false} itemId="gt-6" />);
    expect(html).toContain("登录页加「记住我」");
    expect(html).toContain("进入话题");
    expect(html).toContain("执行 1/4");
    expect(html).toContain("开发：收到，在做了");
    setState([host, waiting], "g-topics");
    expect(render(<TopicCard topicId="t-export" fresh={false} itemId="gt-2" />)).toContain("去回答");
    setState([host, closedDone], "g-topics");
    const closed = render(<TopicCard topicId="t-export-month" fresh={false} itemId="gt-9" />);
    expect(closed).toContain("已关闭");
    expect(closed).toContain("4 条验收标准都过了，已上线");
    expect(closed).not.toContain("进入话题");
  });

  it("话题已经不在了：卡片写一句，不给入口", () => {
    setState([host], "g-topics");
    const html = render(<TopicCard topicId="t-gone" fresh={false} itemId="gt-9" />);
    expect(html).toContain("话题已不在");
    expect(html).not.toContain("进入话题");
  });

  it("右栏「正在做」：群和各话题里没结束的任务都列出来，写清在哪", () => {
    setState([host, doing], "g-topics");
    const job = (id: string, groupId: string, status: string, title: string) => ({ id, assistantId: "dev", groupId, status, title, instruction: "", createdAt: at(9), startedAt: at(9), stats: { reads: 0, commands: 0, edits: 0 }, activity: [] });
    state.jobs = { a: job("a", "g-topics", "running", "查日志"), b: job("b", "t-remember", "queued", "实现「记住我」"), c: job("c", "t-remember", "done", "定方案") };
    const html = render(<PlaceJobs ids={["g-topics", "t-remember"]} />);
    state.jobs = {};
    expect(html).toContain("正在做 · 2");
    expect(html).toContain("开发 · 综合");
    expect(html).toContain("开发 · 「登录页加「记住我」」");
    expect(html).not.toContain("定方案");
  });
});

describe("关了的话题", () => {
  it("没有输入框，写清已关闭和结论，给一个重新打开", () => {
    setState([host, closedDone], "t-export-month");
    const html = render(<ClosedTopic g={closedDone} />);
    expect(html).toContain("这个话题已关闭");
    expect(html).toContain("4 条验收标准都过了，已上线");
    expect(html).toContain("重新打开");
    expect(html).not.toContain("<textarea");
  });
});
