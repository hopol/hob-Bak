import { describe, expect, it } from "vitest";
import type { Approval } from "../../shared/types.ts";
import {
  approvalAnswerFromAction,
  approvalToCard,
  approvalToCardRecord,
  CUSTOM_OPTION_VALUE,
} from "../src/approval-card.ts";

const base: Approval = {
  id: "q-1",
  assistantId: "hob",
  title: "清理旧构建缓存吗？",
  detail: "清理后会释放约 4 GB 空间，下次构建需要重新下载依赖。",
  options: [
    { key: "A", label: "清理" },
    { key: "B", label: "保留" },
  ],
  recommended: "A",
  status: "pending",
  source: "router",
  createdAt: "2026-11-25T00:00:00.000Z",
};

describe("approvalToCard & approvalToCardRecord", () => {
  it("translates a single-question approval with recommended primary button and no free-text input", () => {
    const card = approvalToCard(base);
    expect(card.schema).toBe("2.0");
    expect(card.header).toEqual({ title: base.title });
    expect(card.body.elements).toEqual([
      { tag: "markdown", content: base.detail },
      {
        tag: "button",
        element_id: "opt-A",
        text: "清理",
        type: "primary_filled",
        behaviors: [{ type: "callback", value: { kind: "option", key: "A" } }],
      },
      {
        tag: "button",
        element_id: "opt-B",
        text: "保留",
        type: "default",
        behaviors: [{ type: "callback", value: { kind: "option", key: "B" } }],
      },
    ]);

    expect(approvalAnswerFromAction(base, { action: { kind: "option", key: "A" } })).toEqual({ key: "A" });
  });

  it("includes remember option as a button on single-question approval", () => {
    const withRemember: Approval = {
      ...base,
      ruleText: "清理构建缓存",
      options: [
        { key: "A", label: "清理" },
        { key: "B", label: "保留" },
        { key: "C", label: "以后「清理构建缓存」直接执行", always: true },
      ],
    };
    const card = approvalToCard(withRemember);
    const buttons = card.body.elements.filter((el) => el.tag === "button");
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toMatchObject({ text: "清理", type: "primary_filled" });
    expect(buttons[2]).toMatchObject({
      text: "以后「清理构建缓存」直接执行",
      type: "default",
      behaviors: [{ type: "callback", value: { kind: "option", key: "C" } }],
    });
  });

  it("translates multi-question approval with choices, all five fill-in-the-blank types, and why hints", () => {
    const multi: Approval = {
      id: "q-multi",
      assistantId: "hob",
      title: "活动安排确认",
      detail: "填好后我统一发邀请。",
      options: [],
      questions: [
        {
          title: "活动形式",
          why: "决定预订哪类场地。",
          options: [{ key: "A", label: "线下沙龙" }, { key: "B", label: "线上分享" }],
          recommended: "A",
        },
        { title: "主题名称", options: [], input: "text", placeholder: "例如：秋季读书会" },
        { title: "内容简介", why: "会放进通知正文。", options: [], input: "multiline", placeholder: "写两句介绍" },
        { title: "预计人数", options: [], input: "number", placeholder: "填数字" },
        { title: "活动日期", options: [], input: "date" },
        { title: "开始时间", options: [], input: "time" },
      ],
      status: "pending",
      source: "router",
      createdAt: "2026-11-25T00:00:00.000Z",
    };

    const card = approvalToCard(multi);
    expect(card.body.elements[0]).toEqual({ tag: "markdown", content: "填好后我统一发邀请。" });
    const form = card.body.elements[1];
    expect(form?.tag).toBe("form");
    if (form?.tag !== "form") throw new Error("expected form");
    expect(form.elements).toEqual([
      {
        tag: "select_static",
        name: "q0",
        label: "活动形式",
        hint: "决定预订哪类场地。",
        options: [{ text: "线下沙龙", value: "A" }, { text: "线上分享", value: "B" }],
        initial_option: "A",
        required: true,
        allow_custom: true,
        custom_placeholder: "自己写这个问题的答案",
      },
      { tag: "input", name: "q1", label: "主题名称", placeholder: "例如：秋季读书会", input_type: "text", required: true },
      { tag: "input", name: "q2", label: "内容简介", hint: "会放进通知正文。", placeholder: "写两句介绍", input_type: "multiline_text", required: true },
      { tag: "input", name: "q3", label: "预计人数", placeholder: "填数字", input_type: "number", required: true },
      { tag: "date_picker", name: "q4", label: "活动日期", required: true },
      { tag: "picker_time", name: "q5", label: "开始时间", required: true },
      {
        tag: "button",
        text: "提交",
        type: "primary_filled",
        form_action_type: "submit",
        behaviors: [{ type: "callback", value: { kind: "questions" } }],
      },
    ]);

    expect(
      approvalAnswerFromAction(multi, {
        action: { kind: "questions" },
        form_value: {
          q0: CUSTOM_OPTION_VALUE,
          q0__custom: "混合形式",
          q1: "秋季读书会",
          q2: "聊两本新书",
          q3: 18,
          q4: "2026-11-28",
          q5: "14:30",
        },
      }),
    ).toEqual({
      answers: [
        { text: "混合形式" },
        { text: "秋季读书会" },
        { text: "聊两本新书" },
        { text: "18" },
        { text: "2026-11-28" },
        { text: "14:30" },
      ],
    });
  });

  it("locks answered single-question and multi-question approvals with result values", () => {
    const answeredSingle = approvalToCardRecord({ ...base, status: "answered", chosen: "B" });
    expect(answeredSingle.status).toBe("done");
    expect(answeredSingle.result?.buttonText).toBe("保留");

    const answeredCustom = approvalToCardRecord({ ...base, status: "answered", answerText: "保留最近两次" });
    expect(answeredCustom.status).toBe("done");
    expect(answeredCustom.result?.buttonText).toBe("保留最近两次");

    const answeredMulti = approvalToCardRecord({
      id: "q-done",
      assistantId: "hob",
      title: "排期确认",
      options: [],
      questions: [
        { title: "渠道", options: [{ key: "A", label: "邮件" }, { key: "B", label: "群消息" }], recommended: "A" },
        { title: "发送日期", options: [], input: "date" },
      ],
      answers: [{ key: "B" }, { text: "2026-12-01" }],
      answerText: "上午优先",
      status: "answered",
      source: "router",
      createdAt: "2026-11-25T00:00:00.000Z",
    });
    expect(answeredMulti.status).toBe("done");
    expect(answeredMulti.result?.fields).toEqual({
      q0: "群消息",
      q1: "2026-12-01",
      补充: "上午优先",
    });
  });

  it("marks expired approvals as done with unavailable text", () => {
    const expired = approvalToCardRecord({ ...base, status: "expired" });
    expect(expired.status).toBe("done");
    expect(expired.feedback?.unavailable).toBe("已结束");
    expect(expired.result).toBeUndefined();
  });

  it("handles legacy choice-only questions without input field and job approvals", () => {
    const legacy: Approval = {
      id: "q-legacy",
      assistantId: "hob",
      title: "旧版多问题",
      options: [],
      questions: [
        { title: "格式", options: [{ key: "A", label: "PDF" }, { key: "B", label: "Markdown" }] },
      ],
      status: "pending",
      source: "router",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const form = approvalToCard(legacy).body.elements[0];
    expect(form?.tag).toBe("form");
    if (form?.tag === "form") {
      expect(form.elements[0]).toMatchObject({ tag: "select_static", name: "q0", label: "格式" });
    }

    const jobAsk: Approval = {
      ...base,
      id: "q-job",
      source: "job",
      jobId: "t-123",
      recommended: undefined,
    };
    const jobRecord = approvalToCardRecord(jobAsk);
    expect(jobRecord.status).toBe("open");
    expect(jobRecord.card.body.elements.filter((el) => el.tag === "button")).toHaveLength(2);
  });
});
