import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateCard } from "../src/cards.ts";
import { markdownToCard } from "../src/card-markdown.ts";

const SAME_MARKDOWN = `# 预订会议室
选好时间和人数，我去订

::: columns{weights="2 1"}
**可用会议室**
A101、B203
+++
**本周剩余**
6 个时段
:::

![楼层平面图](https://example.com/rooms.png)

:::form{name=booking}
::input[会议主题]{name=topic placeholder="例如：季度复盘" required}
::date[日期]{name=day required}
::time[开始时间]{name=start required}
::select[时长]{name=len options="30 分钟|60 分钟|90 分钟" default="60 分钟"}
::input[人数]{name=people type=number min=2 max=20}
::multiselect[需要的设备]{name=gear options="投影|白板|视频会议" default="白板"}
::input[备注]{name=note type=multiline}
::checkbox[开会前 15 分钟提醒参会人]{name=remind checked}
::button[提交]{submit primary}
:::

---

::button[打开会议室日历]{url=https://example.com/rooms}
::button[取消预订]{danger}

<details><summary>使用规则</summary>

- 超过 2 小时要主管批准
- 取消请提前 1 小时
</details>`;

const SAME_JSON = {
  schema: "2.0",
  header: { title: "预订会议室", subtitle: "选好时间和人数，我去订" },
  body: {
    elements: [
      {
        tag: "column_set",
        columns: [
          { weight: 2, elements: [{ tag: "markdown", content: "**可用会议室**\nA101、B203" }] },
          { weight: 1, elements: [{ tag: "markdown", content: "**本周剩余**\n6 个时段" }] },
        ],
      },
      { tag: "img", src: "https://example.com/rooms.png", alt: "楼层平面图" },
      {
        tag: "form",
        name: "booking",
        elements: [
          { tag: "input", name: "topic", label: "会议主题", placeholder: "例如：季度复盘", required: true },
          { tag: "date_picker", name: "day", label: "日期", required: true },
          { tag: "picker_time", name: "start", label: "开始时间", required: true },
          {
            tag: "select_static",
            name: "len",
            label: "时长",
            options: [
              { text: "30 分钟", value: "30 分钟" },
              { text: "60 分钟", value: "60 分钟" },
              { text: "90 分钟", value: "90 分钟" },
            ],
            initial_option: "60 分钟",
          },
          { tag: "input", name: "people", label: "人数", input_type: "number", min: 2, max: 20 },
          {
            tag: "multi_select_static",
            name: "gear",
            label: "需要的设备",
            options: [
              { text: "投影", value: "投影" },
              { text: "白板", value: "白板" },
              { text: "视频会议", value: "视频会议" },
            ],
            initial_options: ["白板"],
          },
          { tag: "input", name: "note", label: "备注", input_type: "multiline_text" },
          { tag: "checker", name: "remind", text: "开会前 15 分钟提醒参会人", checked: true },
          { tag: "button", text: "提交", type: "primary_filled", form_action_type: "submit" },
        ],
      },
      { tag: "hr" },
      { tag: "button", text: "打开会议室日历", behaviors: [{ type: "open_url", default_url: "https://example.com/rooms" }] },
      { tag: "button", text: "取消预订", type: "danger" },
      {
        tag: "collapsible_panel",
        expanded: false,
        header: { title: "使用规则" },
        elements: [{ tag: "markdown", content: "- 超过 2 小时要主管批准\n- 取消请提前 1 小时" }],
      },
    ],
  },
};

describe("markdownToCard", () => {
  describe("基础语法与组件", () => {
    it("解析标题和副标题，块级语法开头的不当副标题", () => {
      const withSub = markdownToCard("# 周报汇总\n本周完成 3 项\n\n正文内容");
      expect(withSub.warnings).toEqual([]);
      expect(withSub.errors).toEqual([]);
      expect(withSub.card).toEqual({
        schema: "2.0",
        header: { title: "周报汇总", subtitle: "本周完成 3 项" },
        body: { elements: [{ tag: "markdown", content: "正文内容" }] },
      });

      const noSub = markdownToCard("# 周报汇总\n- 第一项\n- 第二项");
      expect(noSub.card).toEqual({
        schema: "2.0",
        header: { title: "周报汇总" },
        body: { elements: [{ tag: "markdown", content: "- 第一项\n- 第二项" }] },
      });
    });

    it("解析分割线 hr、独立一行图片 img 与 GFM 表格 table", () => {
      const md = [
        "前一段",
        "",
        "---",
        "",
        "![架构图](https://example.com/arch.png)",
        "",
        "| **服务** | `状态` | *延迟* |",
        "| --- | :---: | ---: |",
        "| 网关 | **正常** | `12ms` |",
        "| 缓存 | 正常 | 3ms |",
      ].join("\n");
      const { card, warnings, errors } = markdownToCard(md);
      expect(warnings).toEqual([]);
      expect(errors).toEqual([]);
      expect(card.body.elements).toEqual([
        { tag: "markdown", content: "前一段" },
        { tag: "hr" },
        { tag: "img", src: "https://example.com/arch.png", alt: "架构图" },
        {
          tag: "table",
          columns: [
            { name: "c0", display_name: "服务" },
            { name: "c1", display_name: "状态" },
            { name: "c2", display_name: "延迟" },
          ],
          rows: [
            { c0: "网关", c1: "正常", c2: "12ms" },
            { c0: "缓存", c1: "正常", c2: "3ms" },
          ],
        },
      ]);
      expect(validateCard(card).ok).toBe(true);
    });

    it("解析分栏和权重", () => {
      const { card, warnings, errors } = markdownToCard([
        '::: columns{weights="3 1"}',
        "左栏内容",
        "+++",
        "右栏内容",
        ":::",
      ].join("\n"));
      expect(warnings).toEqual([]);
      expect(errors).toEqual([]);
      expect(card.body.elements).toEqual([
        {
          tag: "column_set",
          columns: [
            { weight: 3, elements: [{ tag: "markdown", content: "左栏内容" }] },
            { weight: 1, elements: [{ tag: "markdown", content: "右栏内容" }] },
          ],
        },
      ]);
    });

    it("解析折叠面板（默认收起与 open 默认展开）", () => {
      const { card, warnings, errors } = markdownToCard([
        "<details><summary>展开详情</summary>",
        "默认收起的内容",
        "</details>",
        "",
        "<details open>",
        "<summary>默认打开</summary>",
        "已展开的内容",
        "</details>",
      ].join("\n"));
      expect(warnings).toEqual([]);
      expect(errors).toEqual([]);
      expect(card.body.elements).toEqual([
        {
          tag: "collapsible_panel",
          expanded: false,
          header: { title: "展开详情" },
          elements: [{ tag: "markdown", content: "默认收起的内容" }],
        },
        {
          tag: "collapsible_panel",
          expanded: true,
          header: { title: "默认打开" },
          elements: [{ tag: "markdown", content: "已展开的内容" }],
        },
      ]);
    });

    it("解析表单以及全部交互组件和属性", () => {
      const md = [
        ":::form{name=order}",
        '::input[姓名]{name=user placeholder="请输入姓名" default="张三" required}',
        '::input[说明]{name=desc type=multiline placeholder="补充细节"}',
        '::input[件数]{name=qty type=number default="2" min=1 max=99}',
        '::select[配送]{name=ship options="标准|加急" default="加急" required}',
        '::multiselect[配件]{name=extras options="支架|数据线|保护壳" default="支架|保护壳" required}',
        "::date[发货日]{name=day required}",
        "::time[联系时间]{name=clock required}",
        "::datetime[预约时段]{name=slot required}",
        "::checkbox[需要电子发票]{name=invoice checked}",
        "::button[确认下单]{primary submit}",
        ":::",
        "::button[查看条款]{url=https://example.com/terms}",
        "::button[撤回]{danger}",
        "::button[稍后再说]",
      ].join("\n");
      const { card, warnings, errors } = markdownToCard(md);
      expect(warnings).toEqual([]);
      expect(errors).toEqual([]);
      expect(card.body.elements).toEqual([
        {
          tag: "form",
          name: "order",
          elements: [
            { tag: "input", name: "user", label: "姓名", placeholder: "请输入姓名", default_value: "张三", required: true },
            { tag: "input", name: "desc", label: "说明", placeholder: "补充细节", input_type: "multiline_text" },
            { tag: "input", name: "qty", label: "件数", default_value: 2, input_type: "number", min: 1, max: 99 },
            {
              tag: "select_static",
              name: "ship",
              label: "配送",
              options: [{ text: "标准", value: "标准" }, { text: "加急", value: "加急" }],
              initial_option: "加急",
              required: true,
            },
            {
              tag: "multi_select_static",
              name: "extras",
              label: "配件",
              options: [
                { text: "支架", value: "支架" },
                { text: "数据线", value: "数据线" },
                { text: "保护壳", value: "保护壳" },
              ],
              initial_options: ["支架", "保护壳"],
              required: true,
            },
            { tag: "date_picker", name: "day", label: "发货日", required: true },
            { tag: "picker_time", name: "clock", label: "联系时间", required: true },
            { tag: "picker_datetime", name: "slot", label: "预约时段", required: true },
            { tag: "checker", name: "invoice", text: "需要电子发票", checked: true },
            { tag: "button", text: "确认下单", type: "primary_filled", form_action_type: "submit" },
          ],
        },
        { tag: "button", text: "查看条款", behaviors: [{ type: "open_url", default_url: "https://example.com/terms" }] },
        { tag: "button", text: "撤回", type: "danger" },
        { tag: "button", text: "稍后再说" },
      ]);
      expect(validateCard(card).ok).toBe(true);
    });

    it("全角｜保留在选项和默认值文字里，只按半角 | 切分", () => {
      const md = [
        '::select[套餐]{name=plan options="基础版｜月付 29 元|专业版｜月付 99 元" default="专业版｜月付 99 元"}',
        '::multiselect[时段]{name=slots options="上午｜9:00-12:00|下午｜14:00-18:00" default="上午｜9:00-12:00|下午｜14:00-18:00"}',
      ].join("\n");
      const { card, warnings, errors } = markdownToCard(md);
      expect(warnings).toEqual([]);
      expect(errors).toEqual([]);
      expect(card.body.elements).toEqual([
        {
          tag: "select_static",
          name: "plan",
          label: "套餐",
          options: [
            { text: "基础版｜月付 29 元", value: "基础版｜月付 29 元" },
            { text: "专业版｜月付 99 元", value: "专业版｜月付 99 元" },
          ],
          initial_option: "专业版｜月付 99 元",
        },
        {
          tag: "multi_select_static",
          name: "slots",
          label: "时段",
          options: [
            { text: "上午｜9:00-12:00", value: "上午｜9:00-12:00" },
            { text: "下午｜14:00-18:00", value: "下午｜14:00-18:00" },
          ],
          initial_options: ["上午｜9:00-12:00", "下午｜14:00-18:00"],
        },
      ]);
      expect(validateCard(card).ok).toBe(true);
    });

    it("same.json 里的卡片 Markdown 翻译结果与手写 JSON 逐字相同", () => {
      const { card, warnings, errors } = markdownToCard(SAME_MARKDOWN);
      expect(warnings).toEqual([]);
      expect(errors).toEqual([]);
      expect(JSON.stringify(card)).toBe(JSON.stringify(SAME_JSON));
      expect(validateCard(card).ok).toBe(true);

      const sameFile = ".scratch/v2/eval/card-md/same.json";
      if (existsSync(sameFile)) {
        const fixture = JSON.parse(readFileSync(sameFile, "utf8")) as Array<{ json: unknown }>;
        expect(JSON.stringify(card)).toBe(JSON.stringify(fixture[0]!.json));
      }
    });
  });

  describe("补好后提醒（warnings）", () => {
    it("分栏未闭合与空栏会补好并提醒", () => {
      const { card, warnings, errors } = markdownToCard([
        "::: columns",
        "第一栏",
        "+++",
        "",
        "+++",
        "第三栏",
      ].join("\n"));
      expect(errors).toEqual([]);
      expect(warnings).toContain("分栏没有用 ::: 闭合，已按到结尾处理");
      expect(warnings).toContain("分栏里有空栏，已去掉");
      expect(card.body.elements).toEqual([
        {
          tag: "column_set",
          columns: [
            { weight: 1, elements: [{ tag: "markdown", content: "第一栏" }] },
            { weight: 1, elements: [{ tag: "markdown", content: "第三栏" }] },
          ],
        },
      ]);
    });

    it("表单缺 name、字段缺 name、name 重复、缺 submit 按钮、未闭合都会补好并提醒", () => {
      const { card, warnings, errors } = markdownToCard([
        ":::form",
        "::input[姓名]",
        "::input[邮箱]{name=contact}",
        "::input[备用邮箱]{name=contact}",
      ].join("\n"));
      expect(errors).toEqual([]);
      expect(warnings).toEqual([
        "表单没写 name，用了 form1",
        "「姓名」没写 name，用了 f2",
        "表单没有用 ::: 闭合，已按到结尾处理",
        "表单里 name「contact」重复，后一个改成 contact_3",
        "表单里没有 submit 按钮，用户交不回来；已在最后加一个「提交」",
      ]);
      expect(card.body.elements).toEqual([
        {
          tag: "form",
          name: "form1",
          elements: [
            { tag: "input", name: "f2", label: "姓名" },
            { tag: "input", name: "contact", label: "邮箱" },
            { tag: "input", name: "contact_3", label: "备用邮箱" },
            { tag: "button", text: "提交", type: "primary_filled", form_action_type: "submit" },
          ],
        },
      ]);
      expect(validateCard(card).ok).toBe(true);
    });

    it("嵌套表单当作同一个表单并提醒", () => {
      const { card, warnings, errors } = markdownToCard([
        ":::form{name=outer}",
        ":::form{name=inner}",
        "::input[字段]{name=a}",
        "::button[交回]{submit}",
        ":::",
      ].join("\n"));
      expect(errors).toEqual([]);
      expect(warnings).toContain("表单里又写了表单，里面那层当作同一个表单");
      expect(card.body.elements).toHaveLength(1);
      expect(card.body.elements[0]).toMatchObject({ tag: "form", name: "outer" });
      expect(validateCard(card).ok).toBe(true);
    });

    it("select/multiselect 默认值不在 options 里时去掉并提醒", () => {
      const { card, warnings, errors } = markdownToCard([
        '::select[优先级]{name=p options="高|中|低" default="紧急"}',
        '::multiselect[标签]{name=tags options="前端|后端" default="前端|测试"}',
      ].join("\n"));
      expect(errors).toEqual([]);
      expect(warnings).toEqual([
        "「优先级」的 default「紧急」不在 options 里，已去掉",
        "「标签」的 default「测试」不在 options 里，已去掉",
      ]);
      expect(card.body.elements[0]).not.toHaveProperty("initial_option");
      expect(card.body.elements[1]).toMatchObject({ initial_options: ["前端"] });
      expect(validateCard(card).ok).toBe(true);
    });

    it("不认识的 input type 按一行文字处理并提醒", () => {
      const { card, warnings, errors } = markdownToCard("::input[邮箱]{name=mail type=email}");
      expect(errors).toEqual([]);
      expect(warnings).toEqual(["「邮箱」的 type「email」不认识，按一行文字处理"]);
      expect(card.body.elements[0]).toEqual({ tag: "input", name: "mail", label: "邮箱" });
    });

    it("button 的非法 url 和表单外的 submit 都会处理并提醒", () => {
      const { card, warnings, errors } = markdownToCard([
        "::button[打开]{url=javascript:alert(1)}",
        "::button[提交]{submit}",
      ].join("\n"));
      expect(errors).toEqual([]);
      expect(warnings).toEqual([
        "按钮「打开」的 url 不是 http(s) 网址，已去掉",
        "按钮「提交」写了 submit 但不在表单里，按普通按钮处理",
      ]);
      expect(card.body.elements).toEqual([
        { tag: "button", text: "打开" },
        { tag: "button", text: "提交" },
      ]);
    });

    it("折叠缺 summary、未闭合、嵌套折叠都会补好并提醒", () => {
      const { card, warnings, errors } = markdownToCard([
        "<details>",
        "外层内容",
        "<details><summary>内层</summary>",
        "内层内容",
      ].join("\n"));
      expect(errors).toEqual([]);
      expect(warnings).toEqual([
        "折叠没有写 <summary> 标题，用了「详情」",
        "折叠里又套了折叠，里面那层按普通文字显示",
        "折叠没有用 </details> 闭合，已按到结尾处理",
      ]);
      expect(card.body.elements[0]).toMatchObject({
        tag: "collapsible_panel",
        expanded: false,
        header: { title: "详情" },
      });
    });

    it("不认识的块、多余分隔线与未闭合代码块都会提醒", () => {
      const unknown = markdownToCard(":::callout\n提示\n:::");
      expect(unknown.warnings).toContain("块「:::callout」不认识，按普通文字显示");
      expect(unknown.warnings).toContain("多出来一行「:::」，按普通文字显示");

      const stray = markdownToCard("文字\n+++");
      expect(stray.warnings).toContain("多出来一行「+++」，按普通文字显示");

      const unclosedFence = markdownToCard("```ts\nconst x = 1;");
      expect(unclosedFence.warnings).toContain("代码块没有闭合");
    });
  });

  describe("错误（errors）", () => {
    it("不认识的组件名报错并提示正确写法", () => {
      const { errors } = markdownToCard("::number[人数]{name=people min=1}");
      expect(errors).toEqual([
        "组件「::number」不认识：能用的是 input、select、multiselect、date、time、datetime、checkbox、button（数字输入框写 ::input[…]{type=number}）",
      ]);
    });

    it("select 和 multiselect 缺少 options 报错", () => {
      const single = markdownToCard("::select[时长]{name=len}");
      expect(single.errors).toEqual(['「::select[时长]」没写 options：写成 options="选项1|选项2"']);

      const multi = markdownToCard("::multiselect[设备]{name=gear}");
      expect(multi.errors).toEqual(['「::multiselect[设备]」没写 options：写成 options="选项1|选项2"']);
    });

    it("保留 type=password 交给 validateCard 拦截", () => {
      const { card, warnings, errors } = markdownToCard("::input[密码]{name=pwd type=password}");
      expect(warnings).toEqual([]);
      expect(errors).toEqual([]);
      expect(card.body.elements[0]).toMatchObject({ tag: "input", input_type: "password" });
      expect(validateCard(card)).toMatchObject({
        ok: false,
        error: { error: "卡片不能有 input_type 为 password 的输入框：密码这类值要交给插件的卡片，不经过你。" },
      });
    });
  });
});
