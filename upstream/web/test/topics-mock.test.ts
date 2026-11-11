import { describe, expect, it } from "vitest";
import type { HobEvent } from "../../shared/types.ts";
import { createMock } from "../src/mock.ts";

/** 假后端里和话题有关的几条行为（真服务端是票 151）。 */
function mock(scene: Parameters<typeof createMock>[0] = "topics") {
  const api = createMock(scene);
  const events: HobEvent[] = [];
  api.events({ onEvent: (event) => events.push(event) });
  return { api, events };
}

const error = async (work: () => Promise<unknown>) => {
  try {
    await work();
    return null;
  } catch (e) {
    return (e as { message: string }).message;
  }
};

describe("mock：话题和工作方式", () => {
  it("topics 场景：软件开发群，三个进行中的话题和两个关了的", async () => {
    const { api } = mock("topics");
    const groups = await api.groups();
    const host = groups.find((g) => g.id === "g-topics")!;
    expect(host.name).toBe("Hob 开发");
    expect(host.workflow).toBe("software");
    const topics = groups.filter((g) => g.parentId === "g-topics");
    expect(topics.map((t) => t.name)).toEqual(["导出月度报表", "登录页加「记住我」", "上传大文件失败", "导出加按月筛选", "首页配色改版"]);
    expect(topics.filter((t) => !t.closedAt)).toHaveLength(3);
    expect(topics.filter((t) => t.closedAt)).toHaveLength(2);
    // 话题的成员、群主、负责什么和工作方式都跟群一样
    for (const topic of topics) {
      expect(topic.members).toEqual(host.members);
      expect(topic.ownerId).toBe(host.ownerId);
      expect(topic.workflow).toBe("software");
    }
    // 话题带自己的未读和事项摘要
    expect(topics.find((t) => t.id === "t-export")!.unread).toBe(2);
    expect(topics.find((t) => t.id === "t-remember")!.project).toMatchObject({ stage: "doing", done: 1, total: 4, current: "dev" });
  });

  it("topics-plain 场景：「无」工作方式的群，两个进行中的话题", async () => {
    const { api } = mock("topics-plain");
    const groups = await api.groups();
    expect(groups.find((g) => g.id === "g-home")!.workflow).toBeUndefined();
    const topics = groups.filter((g) => g.parentId === "g-home");
    expect(topics.filter((t) => !t.closedAt).map((t) => t.name)).toEqual(["换新硬盘", "相册备份出错"]);
    expect(topics.every((t) => t.project === undefined)).toBe(true);
  });

  it("开话题：综合里落一张话题卡，话题带群的工作方式", async () => {
    const { api, events } = mock("topics");
    const topic = await api.createTopic("g-topics", { title: "发布前的检查" });
    expect(topic.parentId).toBe("g-topics");
    expect(topic.createdBy).toBe("user");
    expect(topic.workflow).toBe("software");
    const items = await api.groupItems("g-topics");
    expect(items.items.at(-1)).toMatchObject({ kind: "topic", topicId: topic.id });
    expect(events.some((event) => event.type === "group-item")).toBe(true);
    expect(events.some((event) => event.type === "group" && event.group.id === topic.id)).toBe(true);

    expect(await error(() => api.createTopic("g-topics", { title: "  " }))).toContain("话题名不能为空");
    expect(await error(() => api.createTopic(topic.id, { title: "话题里再开一个" }))).toContain("话题里不能再开话题");
  });

  it("关闭话题：里没结束的事项按放弃处理，关了以后发消息报错；重新打开能再发", async () => {
    const { api } = mock("topics");
    const closed = await api.closeTopic("t-remember", { note: "先不做了" });
    expect(closed.closedAt).toBeTruthy();
    expect(closed.closeNote).toBe("先不做了");
    // 综合里那条话题卡跟着变：阶段变成已放弃
    const groups = await api.groups();
    expect(groups.find((g) => g.id === "t-remember")!.project).toMatchObject({ stage: "dropped" });
    expect(await error(() => api.sendGroupMessage("t-remember", { text: "在吗" }))).toBe("这个话题已关闭，重新打开后才能发消息");

    const reopened = await api.reopenTopic("t-remember");
    expect(reopened.closedAt).toBeUndefined();
    expect(reopened.closeNote).toBeUndefined();
    const sent = await api.sendGroupMessage("t-remember", { text: "在吗" });
    expect(sent?.item.text).toBe("在吗");
  });

  it("工作方式：改成无要先没有没结束的事项；话题只能改名字", async () => {
    const { api } = mock("topics");
    expect(await error(() => api.patchGroup("g-topics", { workflow: null }))).toContain("没结束的事项");
    const saved = await api.patchGroup("g-topics", { workflow: "software" });
    expect(saved.workflow).toBe("software");
    // 换一个没有事项的群，就能改成无
    const plain = await api.patchGroup("g-dev", { workflow: null });
    expect(plain.workflow).toBeUndefined();
    expect(await error(() => api.patchGroup("t-remember", { purpose: "改负责什么" }))).toBe("话题只能改名字。");
    const renamed = await api.patchGroup("t-remember", { name: "换掉的名字" });
    expect(renamed.name).toBe("换掉的名字");
  });

  it("建群带上工作方式，照着群建的两个群工作方式一致", async () => {
    const { api } = mock("s1");
    const created = await api.createGroup({ name: "Pix 开发", purpose: "Pix 仓库的事", ownerId: "hob", members: ["hob"], workflow: "software" });
    expect(created.workflow).toBe("software");
    const plain = await api.createGroup({ name: "家里", purpose: "", ownerId: "hob", members: ["hob"], workflow: null });
    expect(plain.workflow).toBeUndefined();
  });

  it("归档群时，每个话题各发一个 group_removed", async () => {
    const { api, events } = mock("topics");
    events.length = 0;
    await api.archiveGroup("g-topics");
    const removed = events.flatMap((event) => (event.type === "group_removed" ? [event.id] : []));
    expect(removed).toContain("g-topics");
    expect(removed.filter((id) => id.startsWith("t-"))).toHaveLength(5);
  });
});
