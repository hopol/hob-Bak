import { describe, expect, it } from "vitest";
import { cardTitle, validateCard } from "../src/cards.ts";

describe("card JSON validation", () => {
  it("accepts the supported display and interaction elements", () => {
    const result = validateCard({
      schema: "2.0",
      config: { summary: { content: "旅行安排" } },
      header: { title: "旅行安排", subtitle: { content: "先收集偏好" } },
      body: {
        elements: [
          { tag: "markdown", content: "请填写下面几项" },
          { tag: "img", src: "data:image/png;base64,AA==", alt: "示意图" },
          { tag: "form", name: "trip", elements: [
            { tag: "input", name: "place", label: "目的地", required: true },
            { tag: "select_static", name: "style", label: "风格", options: [{ text: "舒适", value: "comfort" }], initial_option: "comfort" },
            { tag: "button", text: "提交", form_action_type: "submit", behaviors: [{ type: "callback", value: { action: "submit" } }] },
          ] },
          { tag: "table", columns: [{ name: "name", display_name: "名称" }], rows: [{ name: "第一项" }] },
        ],
      },
    });
    expect(result).toMatchObject({ ok: true, value: { interactive: true, componentCount: 7, title: "旅行安排" } });
    if (result.ok) expect(cardTitle(result.value.card)).toBe("旅行安排");
  });

  it("reports the exact form component for a missing or duplicate name", () => {
    expect(validateCard({ body: { elements: [{ tag: "form", name: "profile", elements: [{ tag: "input", label: "用户名" }] }] } })).toMatchObject({
      ok: false,
      error: { error: "卡片 body里的第 1 个组件「profile」里的第 1 个组件缺 name" },
    });
    expect(validateCard({ body: { elements: [{ tag: "form", name: "profile", elements: [{ tag: "input", name: "user" }, { tag: "checker", name: "user", text: "启用" }] }] } })).toMatchObject({
      ok: false,
      error: { error: "卡片 body里的第 1 个组件「profile」里的第 2 个组件的 name「user」重复" },
    });
  });

  it("rejects unsupported tags, unsafe URLs, bad ids, and assistant passwords", () => {
    expect(validateCard({ body: { elements: [{ tag: "slider" }] } })).toMatchObject({ ok: false, error: { error: "卡片 body里的第 1 个组件的 tag「slider」不支持" } });
    expect(validateCard({ body: { elements: [{ tag: "img", src: "javascript:alert(1)", alt: "x" }] } })).toMatchObject({ ok: false, error: { error: "卡片 body里的第 1 个组件的 src 只支持 https:// 或 data:image/" } });
    expect(validateCard({ body: { elements: [{ tag: "button", element_id: "1bad", text: "点我" }] } })).toMatchObject({ ok: false, error: { error: expect.stringContaining("element_id 无效") } });
    expect(validateCard({ body: { elements: [{ tag: "input", input_type: "password" }] } })).toMatchObject({ ok: false, error: { error: "卡片不能有 input_type 为 password 的输入框：密码这类值要交给插件的卡片，不经过你。" } });
    expect(validateCard({ body: { elements: [{ tag: "button", text: "打开", behaviors: [{ type: "open_url", default_url: "javascript:alert(1)" }] }] } })).toMatchObject({ ok: false, error: { error: expect.stringContaining("只支持 http:// 或 https://") } });
    expect(validateCard({ body: { elements: [{ tag: "select_static", name: "s", options: [{ text: "甲", value: "a" }], display: "list" }] } })).toMatchObject({ ok: false, error: { error: "卡片 body里的第 1 个组件的 display 无效" } });
  });

  it("accepts the Hob extensions on select_static and div", () => {
    expect(validateCard({ body: { elements: [{ tag: "select_static", name: "s", options: [{ text: "甲", value: "a" }], display: "dropdown" }, { tag: "div", icon: "check", text: "已保存" }] } })).toMatchObject({ ok: true, value: { componentCount: 2 } });
    expect(validateCard({ body: { elements: [{ tag: "select_static", name: "s", options: [{ text: "甲", value: "a" }], display: "chips" }] } })).toMatchObject({ ok: true });
  });

  it("allows plugin cards to omit unknown components and reports how many were hidden", () => {
    const result = validateCard({ body: { elements: [{ tag: "unknown_widget" }, { tag: "div", text: "仍然显示" }] } }, { mode: "plugin" });
    expect(result).toMatchObject({ ok: true, value: { unsupportedCount: 1, componentCount: 1, card: { body: { elements: [{ tag: "div" }] } } } });
  });

  it("rejects nested forms", () => {
    expect(validateCard({ body: { elements: [{ tag: "form", name: "outer", elements: [{ tag: "form", name: "inner", elements: [] }] }] } })).toMatchObject({ ok: false, error: { error: "卡片 body里的第 1 个组件「outer」里的第 1 个组件里不能嵌套 form" } });
  });
  it("enforces the card and component limits", () => {
    const tooLarge = validateCard({ body: { elements: [{ tag: "div", text: "x".repeat(110_000) }] } });
    expect(tooLarge).toMatchObject({ ok: false, error: { error: "卡片不能超过 100 KB" } });
    const tooMany = validateCard({ body: { elements: Array.from({ length: 201 }, () => ({ tag: "hr" })) } });
    expect(tooMany).toMatchObject({ ok: false, error: { error: expect.stringContaining("超过 200 个组件") } });
  });
});
