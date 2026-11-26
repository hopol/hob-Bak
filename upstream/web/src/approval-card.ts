import { t } from "../../shared/i18n.ts";
import type {
  AnswerApprovalBody,
  Approval,
  ApprovalAnswer,
  ApprovalOption,
  ApprovalQuestion,
  Card,
  CardActionRequest,
  CardElement,
  CardRecord,
} from "../../shared/types.ts";

/** 多问题选择题切换到「自己写」时的内部选项值。 */
export const CUSTOM_OPTION_VALUE = "__custom__";

function questionElement(question: ApprovalQuestion, index: number): CardElement {
  const name = `q${index}`;
  const label = question.title;
  const hint = question.why ? { hint: question.why } : {};
  const placeholder = question.placeholder ? { placeholder: question.placeholder } : {};

  if (question.input === "text") {
    return { tag: "input", name, label, ...hint, ...placeholder, input_type: "text", required: true };
  }
  if (question.input === "multiline") {
    return { tag: "input", name, label, ...hint, ...placeholder, input_type: "multiline_text", required: true };
  }
  if (question.input === "number") {
    return { tag: "input", name, label, ...hint, ...placeholder, input_type: "number", required: true };
  }
  if (question.input === "date") {
    return { tag: "date_picker", name, label, ...hint, ...placeholder, required: true };
  }
  if (question.input === "time") {
    return { tag: "picker_time", name, label, ...hint, ...placeholder, required: true };
  }

  return {
    tag: "select_static",
    name,
    label,
    ...hint,
    options: question.options.map((option) => ({ text: option.label, value: option.key })),
    ...(question.recommended ? { initial_option: question.recommended } : {}),
    required: true,
    allow_custom: true,
    custom_placeholder: t("自己写这个问题的答案"),
  };
}

/**
 * 纯函数：把提问卡（Approval）翻译成 252 卡片 JSON。
 * 不改变 Approval 存储和提交路径，只复用卡片的组件来渲染。
 */
export function approvalToCard(approval: Approval): Card {
  const elements: CardElement[] = [];
  if (approval.detail) {
    elements.push({ tag: "markdown", content: approval.detail });
  }

  const questions = approval.questions?.length ? approval.questions : undefined;
  if (questions) {
    elements.push({
      tag: "form",
      name: "questions",
      elements: [
        ...questions.map((question, index) => questionElement(question, index)),
        {
          tag: "button",
          text: t("提交"),
          type: "primary_filled",
          form_action_type: "submit",
          behaviors: [{ type: "callback", value: { kind: "questions" } }],
        },
      ],
    });
  } else {
    for (const option of approval.options) {
      elements.push({
        tag: "button",
        element_id: `opt-${option.key}`,
        text: option.label,
        type: option.key === approval.recommended ? "primary_filled" : "default",
        behaviors: [{ type: "callback", value: { kind: "option", key: option.key } }],
      });
    }
    // 不另放输入框：想说别的，用户直接在对话框里写，发出去这张卡就结束
  }

  return {
    schema: "2.0",
    header: { title: approval.title },
    body: { elements },
  };
}

/** 把提问卡（含待答、已答、已结束状态）包成 CardView 可直接渲染的 CardRecord。 */
export function approvalToCardRecord(approval: Approval): CardRecord {
  const card = approvalToCard(approval);
  const base: CardRecord = {
    id: approval.id,
    owner: { type: "assistant", assistantId: approval.assistantId },
    ...(approval.groupId ? { groupId: approval.groupId } : {}),
    card,
    status: approval.status === "pending" ? "open" : "done",
    createdAt: approval.createdAt,
    ...(approval.answeredAt ? { updatedAt: approval.answeredAt } : {}),
  };

  if (approval.status === "expired") {
    return {
      ...base,
      feedback: { unavailable: t("已结束") },
    };
  }

  if (approval.status === "answered") {
    const questions = approval.questions?.length ? approval.questions : undefined;
    if (questions) {
      const fields: Record<string, unknown> = {};
      questions.forEach((question, index) => {
        const reply = approval.answers?.[index];
        if (question.input) {
          fields[`q${index}`] = reply?.text ?? "";
        } else if (reply?.key) {
          fields[`q${index}`] = question.options.find((option) => option.key === reply.key)?.label ?? reply.key;
        } else {
          fields[`q${index}`] = reply?.text ?? "";
        }
      });
      if (approval.answerText) {
        fields[t("补充")] = approval.answerText;
      }
      return {
        ...base,
        result: { action: { kind: "questions" }, buttonText: t("提交"), fields },
      };
    }

    const chosen = approval.chosen ? approval.options.find((option) => option.key === approval.chosen) : undefined;
    const answerLabel = chosen ? chosen.label : approval.answerText ?? approval.chosen ?? "";
    return {
      ...base,
      result: {
        action: approval.chosen ? { kind: "option", key: approval.chosen } : { kind: "other" },
        buttonText: answerLabel,
      },
    };
  }

  return base;
}

/** 把 CardView 回调的提交参数转成 POST /api/approvals/:id 所需的 AnswerApprovalBody。 */
export function approvalAnswerFromAction(approval: Approval, request: CardActionRequest): AnswerApprovalBody | undefined {
  const action = request.action ?? {};
  const formValue = request.form_value ?? {};
  const questions = approval.questions?.length ? approval.questions : undefined;

  if (questions) {
    const answers: ApprovalAnswer[] = questions.map((question, index) => {
      const key = `q${index}`;
      const raw = formValue[key];
      if (question.input) {
        return { text: raw === undefined || raw === null ? "" : String(raw).trim() };
      }
      if (raw === CUSTOM_OPTION_VALUE) {
        return { text: String(formValue[`${key}__custom`] ?? "").trim() };
      }
      return { key: raw as ApprovalOption["key"] };
    });
    return { answers };
  }

  if (action.kind === "option" && (action.key === "A" || action.key === "B" || action.key === "C")) {
    return { key: action.key };
  }

  return undefined;
}
