import type { Card, CardRecord } from "../../shared/types.ts";

/**
 * ?mock=1&scene=cards-gallery：卡片每种组件和常见组合各来一张，排在一个对话里，
 * 用来对照样式是否协调（浅色、深色、手机）。内容都是现编的通用例子。
 */
type Entry = { label: string; card: Card; patch?: Partial<CardRecord>; plugin?: { id: string; name: string } };

const opts = (...texts: string[]) => texts.map((text) => ({ text, value: text }));
const md = (content: string) => ({ tag: "markdown" as const, content });

export const GALLERY: Entry[] = [
  { label: "只有标题和一段文字", card: { schema: "2.0", header: { title: "备份已完成" }, body: { elements: [md("昨晚的备份用时 18 分钟，比平时多 4 分钟，原因是新增了 3.2 GB 的照片。")] } } },
  { label: "标题、副标题，正文里有小标题、列表、加粗、行内代码和代码块", card: { schema: "2.0", header: { title: "本周运营周报", subtitle: "11 月第 3 周 · 三个渠道合并" }, body: { elements: [
    md("## 二级小标题\n本周订单 **412 单**，比上周多 12.9%。\n\n### 需要关注\n- **支付失败率**升到 2.1%，集中在周三晚上\n- 两个工单超过 48 小时没回复\n  - 一个是退款\n  - 一个是改地址\n\n1. 先查支付通道\n2. 再补回复\n\n#### 四级小标题\n配置在 `config/pay.yaml` 里：\n\n```yaml\nretry: 3\ntimeout: 15s\n```\n\n> 引用：上周同期失败率是 0.8%。"),
  ] } } },
  { label: "分栏：三栏关键数字", card: { schema: "2.0", header: { title: "本月开销", subtitle: "11 月 1 日到 25 日" }, body: { elements: [
    { tag: "column_set", columns: [
      { weight: 1, elements: [md("**支出**\n14,860 元")] },
      { weight: 1, elements: [md("**预算**\n13,000 元")] },
      { weight: 1, elements: [md("**超出**\n1,860 元")] },
    ] },
    md("外卖比上月多 620 元，新报的数学班 2,400 元是主要增量。"),
  ] } } },
  { label: "分栏：四栏、数字带说明（长短不齐）", card: { schema: "2.0", header: { title: "网店周报" }, body: { elements: [
    { tag: "column_set", columns: [
      { weight: 1, elements: [md("**412 单**\n上周 365，+12.9%")] },
      { weight: 1, elements: [md("**58,340 元**\n上周 51,200")] },
      { weight: 1, elements: [md("**4.2%**\n转化率")] },
      { weight: 1, elements: [md("**2.2%**\n退款率，共 9 单，其中 5 单是同一款")] },
    ] },
  ] } } },
  { label: "分栏：两栏、宽度 2:1、栏里有列表", card: { schema: "2.0", header: { title: "两个方案" }, body: { elements: [
    { tag: "column_set", columns: [
      { weight: 2, elements: [md("**方案一：自建**\n- 一次投入 2 万\n- 每月维护 2 小时\n- 数据在自己手里")] },
      { weight: 1, elements: [md("**方案二：订阅**\n- 每月 99 元\n- 不用维护")] },
    ] },
  ] } } },
  { label: "表格：短表", card: { schema: "2.0", header: { title: "各渠道新增" }, body: { elements: [
    { tag: "table", columns: [{ name: "a", display_name: "渠道" }, { name: "b", display_name: "新增" }, { name: "c", display_name: "环比" }], rows: [{ a: "搜索", b: "560", c: "+8%" }, { a: "直播", b: "410", c: "+21%" }, { a: "老客推荐", b: "270", c: "-3%" }] },
  ] } } },
  { label: "表格：列多、单元格文字长", card: { schema: "2.0", header: { title: "候选人对比" }, body: { elements: [
    { tag: "table", columns: [{ name: "n", display_name: "姓名" }, { name: "y", display_name: "经验" }, { name: "s", display_name: "长处" }, { name: "w", display_name: "顾虑" }, { name: "p", display_name: "期望" }, { name: "t", display_name: "到岗" }], rows: [
      { n: "林同学", y: "5 年", s: "React 熟练，做过大型后台", w: "系统设计一般", p: "32k", t: "下月" },
      { n: "周同学", y: "3 年", s: "手写代码最好，沟通清楚", w: "主要用 Vue，要适应", p: "25k", t: "2 个月后" },
      { n: "吴同学", y: "7 年", s: "带过 4 人小组，技术面深", w: "超预算 5k", p: "40k", t: "随时" },
    ] },
  ] } } },
  { label: "表格：带开关值和空值", plugin: { id: "cloudflare", name: "Cloudflare" }, card: { schema: "2.0", header: { title: "解析记录" }, body: { elements: [
    { tag: "table", columns: [{ name: "t", display_name: "类型" }, { name: "n", display_name: "名称" }, { name: "c", display_name: "内容" }, { name: "p", display_name: "代理" }], rows: [{ t: "A", n: "@", c: "203.0.113.10", p: true }, { t: "CNAME", n: "blog", c: "example.pages.dev", p: false }, { t: "MX", n: "@", c: "mx.mail.example.net" }] },
  ] } } },
  { label: "折叠：收起和展开，里面有表格和分栏", card: { schema: "2.0", header: { title: "期中成绩" }, body: { elements: [
    md("总分比上次少 9 分，主要丢在数学应用题。"),
    { tag: "collapsible_panel", header: { title: "各科明细" }, expanded: true, elements: [
      { tag: "table", columns: [{ name: "s", display_name: "科目" }, { name: "x", display_name: "分数" }, { name: "a", display_name: "班级平均" }], rows: [{ s: "语文", x: "92", a: "85" }, { s: "数学", x: "78", a: "82" }, { s: "英语", x: "95", a: "87" }] },
    ] },
    { tag: "collapsible_panel", header: { title: "老师评语" }, expanded: false, elements: [md("数学计算粗心，应用题审题不仔细；英语口语进步明显。")] },
    { tag: "collapsible_panel", header: { title: "和上次比" }, expanded: true, elements: [{ tag: "column_set", columns: [{ weight: 1, elements: [md("**排名**\n12 / 45")] }, { weight: 1, elements: [md("**上次**\n7 / 45")] }] }] },
  ] } } },
  { label: "分割线和图片", card: { schema: "2.0", header: { title: "三天行程", subtitle: "12 月 6–8 日 · 2 大 1 小" }, body: { elements: [
    { tag: "img", src: "https://picsum.photos/seed/hob-lake/800/360", alt: "景区地图" },
    md("**第一天**\n上午到站寄存行李，下午科技馆，晚上老街。"),
    { tag: "hr" },
    md("**第二天**\n湖边骑行，中午湖鲜餐厅，下午游船。"),
    { tag: "hr" },
    md("**第三天**\n上午植物园，14:05 返程。"),
  ] } } },
  { label: "按钮：表单外的一排（主、普通、危险、打开网址）", card: { schema: "2.0", header: { title: "江南小馆" }, body: { elements: [
    md("本帮菜，人均 160，评分 4.7，步行 8 分钟，有包间。"),
    { tag: "button", text: "去订位", type: "primary_filled", behaviors: [{ type: "open_url", default_url: "https://book.example.com/r/1182" }] },
    { tag: "button", text: "换一家" },
    { tag: "button", text: "不去了", type: "danger" },
  ] } } },
  { label: "按钮：每一项各配一组（分栏里放按钮）", card: { schema: "2.0", header: { title: "3 个退款申请" }, body: { elements: [
    { tag: "column_set", columns: [{ weight: 3, elements: [md("**订单 1042** · 保温杯 79 元\n杯盖漏水，附了视频")] }, { weight: 2, elements: [{ tag: "button", text: "同意", type: "primary_filled" }, { tag: "button", text: "拒绝", type: "danger" }] }] },
    { tag: "column_set", columns: [{ weight: 3, elements: [md("**订单 1057** · 收纳盒 96 元\n不想要了，已签收 9 天")] }, { weight: 2, elements: [{ tag: "button", text: "同意", type: "primary_filled" }, { tag: "button", text: "拒绝", type: "danger" }] }] },
    { tag: "column_set", columns: [{ weight: 3, elements: [md("**订单 1063** · 台灯 159 元\n颜色和图片不一样")] }, { weight: 2, elements: [{ tag: "button", text: "同意", type: "primary_filled" }, { tag: "button", text: "拒绝", type: "danger" }] }] },
  ] } } },
  { label: "可点的行（插件列表）", plugin: { id: "github", name: "GitHub" }, card: { schema: "2.0", header: { title: "等你审的合并请求", subtitle: "acme/notes-app" }, body: { elements: [
    { tag: "interactive_container", elements: [{ tag: "div", text: "修复同步时偶尔丢失最后一条笔记\n#128 · 小林 · 2 小时前" }, { tag: "div", text: "✓ 已合并" }] },
    { tag: "interactive_container", elements: [{ tag: "div", text: "笔记列表支持按标签筛选\n#131 · 阿周 · 昨天" }, { tag: "button", text: "合并" }] },
    { tag: "collapsible_panel", header: { title: "其余开着的 2" }, expanded: true, elements: [
      { tag: "interactive_container", elements: [{ tag: "div", text: "导出时保留图片尺寸\n#133 · 小林 · 3 天前" }, { tag: "button", text: "合并" }] },
      { tag: "interactive_container", elements: [{ tag: "div", text: "设置页加深色模式开关\n#135 · 阿周 · 上周" }, { tag: "button", text: "合并" }] },
    ] },
  ] } } },
  { label: "表单：所有输入（文字、一段话、数字、日期、时间、日期时间、开关）", card: { schema: "2.0", header: { title: "读书会报名", subtitle: "周六下午 · 名额 20" }, body: { elements: [{ tag: "form", name: "signup", elements: [
    { tag: "input", name: "name", label: "姓名", placeholder: "怎么称呼你", required: true },
    { tag: "input", name: "book", label: "想分享的书", input_type: "multiline_text", placeholder: "书名和一两句推荐理由" },
    { tag: "input", name: "friends", label: "带几个朋友", input_type: "number", min: 0, max: 3, default_value: 0 },
    { tag: "date_picker", name: "day", label: "到场日期", required: true },
    { tag: "picker_time", name: "time", label: "到场时间" },
    { tag: "picker_datetime", name: "back", label: "最晚离开" },
    { tag: "checker", name: "remind", text: "开始前一天提醒我", checked: true },
    { tag: "checker", name: "photo", text: "同意拍照" },
    { tag: "button", text: "报名", type: "primary_filled", form_action_type: "submit" },
  ] }] } } },
  { label: "表单：单选和多选（选项少摆出来、选项多收进下拉）", card: { schema: "2.0", header: { title: "会议室预订" }, body: { elements: [{ tag: "form", name: "room", elements: [
    { tag: "select_static", name: "len", label: "时长", options: opts("30 分钟", "60 分钟", "90 分钟"), initial_option: "60 分钟", required: true },
    { tag: "select_static", name: "room", label: "会议室（选项长）", options: opts("A101 · 6 人 · 有投影", "B203 · 12 人 · 有视频会议", "C305 · 20 人 · 有白板和音响") },
    { tag: "multi_select_static", name: "gear", label: "需要的设备", options: opts("投影", "白板", "视频会议"), initial_options: ["白板"] },
    { tag: "multi_select_static", name: "files", label: "要删的文件（8 个）", options: opts("系统安装镜像.iso", "会议录像.mp4", "设计素材包.zip", "游戏安装包.exe", "照片备份.zip", "虚拟机快照.vmdk", "课程视频.zip", "旧手机备份.tar"), initial_options: ["系统安装镜像.iso", "设计素材包.zip"] },
    { tag: "select_static", name: "floor", label: "楼层（7 个选项）", options: opts("1 层", "2 层", "3 层", "4 层", "5 层", "6 层", "7 层") },
    { tag: "button", text: "取消", form_action_type: "reset" } as any,
    { tag: "button", text: "提交", type: "primary_filled", form_action_type: "submit" },
  ] }] } } },
  { label: "表单：两个日期并排、按钮在分栏下", card: { schema: "2.0", header: { title: "请假" }, body: { elements: [{ tag: "form", name: "leave", elements: [
    { tag: "column_set", columns: [{ weight: 1, elements: [{ tag: "date_picker", name: "from", label: "开始", required: true }] }, { weight: 1, elements: [{ tag: "date_picker", name: "to", label: "结束", required: true }] }] },
    { tag: "input", name: "why", label: "原因", input_type: "multiline_text" },
    { tag: "button", text: "存草稿" },
    { tag: "button", text: "提交", type: "primary_filled", form_action_type: "submit" },
  ] }] } } },
  { label: "混合：数字 + 表格 + 折叠 + 按钮", card: { schema: "2.0", header: { title: "婚礼筹备", subtitle: "距婚礼 46 天" }, body: { elements: [
    { tag: "column_set", columns: [{ weight: 1, elements: [md("**已定**\n3 项")] }, { weight: 1, elements: [md("**进行中**\n3 项")] }, { weight: 1, elements: [md("**预算已用**\n8.2 / 15 万")] }] },
    md("### 这周要定的\n- 请柬设计稿第 3 版\n- 主持人，两个人选周五前定"),
    { tag: "table", columns: [{ name: "a", display_name: "事项" }, { name: "b", display_name: "状态" }, { name: "c", display_name: "备注" }], rows: [{ a: "酒店", b: "已定", c: "定金 2 万已付" }, { a: "请柬", b: "进行中", c: "第 3 版待确认" }, { a: "婚车", b: "没开始", c: "" }] },
    { tag: "collapsible_panel", header: { title: "预算明细" }, expanded: false, elements: [md("酒店 6 万、摄影 1.2 万、婚纱 1 万……")] },
    { tag: "button", text: "打开筹备清单", behaviors: [{ type: "open_url", default_url: "https://example.com/wedding" }] },
  ] } } },
  { label: "已提交：显示填了什么", card: { schema: "2.0", header: { title: "会议室预订" }, body: { elements: [{ tag: "form", name: "room", elements: [
    { tag: "input", name: "topic", label: "会议主题" }, { tag: "date_picker", name: "day", label: "日期" }, { tag: "multi_select_static", name: "gear", label: "设备", options: opts("投影", "白板") }, { tag: "button", text: "提交", type: "primary_filled", form_action_type: "submit" },
  ] }] } }, patch: { status: "done", result: { action: { tag: "button" }, buttonText: "提交", fields: { 会议主题: "季度复盘", 日期: "2026-12-02", 设备: ["投影", "白板"] } } } },
  { label: "点了按钮之后", card: { schema: "2.0", header: { title: "订单 1042 退款" }, body: { elements: [md("保温杯 79 元，杯盖漏水。"), { tag: "button", text: "同意", type: "primary_filled" }, { tag: "button", text: "拒绝", type: "danger" }] } }, patch: { status: "done", result: { action: { tag: "button" }, buttonText: "同意" } } },
  { label: "已结束（不可用）", card: { schema: "2.0", header: { title: "保存登录信息" }, body: { elements: [md("Bitwarden 暂时无法使用，请稍后再试。")] } }, plugin: { id: "bitwarden", name: "Bitwarden" }, patch: { feedback: { unavailable: "已结束" } } },
];

export function galleryRecords(now: string): CardRecord[] {
  return GALLERY.map((entry, index) => ({
    id: `gallery-${index}`,
    owner: entry.plugin ? { type: "plugin", pluginId: entry.plugin.id, assistantId: "hob" } : { type: "assistant", assistantId: "hob" },
    ...(entry.plugin ? { plugin: { service: entry.plugin.id, callbackTool: "callback", pluginName: entry.plugin.name } } : {}),
    card: entry.card,
    status: "open",
    createdAt: now,
    ...entry.patch,
  }) as CardRecord);
}
