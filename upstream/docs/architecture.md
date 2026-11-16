# Hob 架构（v1，2026-10-31 定）

Hob 是常驻助手。你只跟助手说话；活由后台任务去干，干完明说结果，只在要你拍板时才来找你。

## 两个来源合在一起

| 来源 | 拿来的东西 |
|---|---|
| Grok Bot | 助手 = 名字 + 职责 + **一条连续对话** + 自己的记忆和工作日志 + 定时任务；主助手（Hob）负责协调；审批在对话里做选择题；只在要批准时找你 |
| DeepSeek《Super-agent 设计探索》 | **Router 常驻只分派，Worker 隔离执行**；事件驱动（活干完推事件，不轮询对话）；Inline & Spill（大输出落盘，只把摘要带回对话）；Watchdog（卡住、崩溃、不汇报都要变成可见状态）；实验结论：只靠提示词让单会话去委派，5 次里 0 次委派，所以**委派必须是结构上的，不能靠提示词** |
| 其他常驻助手的教训 | 委派太绕；一轮结束就报"完成"；活在别处看不见；助手亲自干活把上下文撑爆（387MB 会话） |

由此得出 v1 的四条硬规则：

1. **助手对用户负责，任务对一件活负责。** 对话层不动手：跑命令、改用户的文件交给任务；技能归助手，助手能读技能、改正文。定位见 [助手和任务的定位](../.scratch/v2/design-assistant-and-task.md)。
2. **任务必须明说结果。** 任务会话（Worker）结束前必须调用 `report(outcome, summary)`，outcome ∈ 完成 / 卡住 / 等你批。一轮跑完没调用 = 系统追问一次，再不报就记为"卡住：没交代结果"。
3. **结果完整交回。** 事件带前 3,000 字和全文路径；Router 的工具大结果落盘；压缩和任务一样，接近模型上下文上限时才压。
4. **任何时候都看得见。** 正在干的活在右栏“正在做”实时显示（读了什么、跑了什么），任务卡片点开能看完整过程。

提示词只写事实，见 AGENTS.md。

## 进程和底座

- 单个 Node 22 进程：`server/`（Hono + SSE）+ `web/`（Vite + React，构建后由 server 静态托管）。入口是 `server/src/boot.ts`。
- 底座是 pi SDK `@earendil-works/pi-coding-agent@1.3.0`（引擎），在进程内 `createAgentSession`。界面、提示词、错误信息里不出现 pi：用户不需要知道它。
  - 服务商和凭据全归 Hob 自己管：引擎目录是 `HOB_HOME/system/engine`（`authPath` 在这里，模型配置 `modelsPath` 是 `HOB_HOME/system/engine/models.json`），不读不写任何别的工具的配置。
  - 启动时和每次服务商变动，把设置里的服务商套进引擎：内置服务商 `setRuntimeApiKey` / `removeRuntimeApiKey`，兼容接口 `registerProvider` / `unregisterProvider`。
  - 思考档也按 Hob 自己的设置写给引擎（见下文“思考档”）：兼容接口写进模型的 `thinkingLevelMap`，内置服务商写进 `HOB_HOME/system/engine/models.json` 的 `providers.<id>.modelOverrides`，写完 `refresh()` 一次让引擎重读。
  - 会话文件一律放在 `HOB_HOME` 下（不放进引擎目录）。
  - 不加载用户装的扩展、主题、AGENTS.md；技能只加载下文指定的来源。使用自定义 `ResourceLoader`（见 pi 示例 `examples/sdk/12-full-control.ts`）。工具由 Hob 自己给。

### 启动时的环境隔离（`server/src/boot.ts`）

引擎里有模块在加载时就算好目录（`getAgentDir()`：grep / find 的二进制缓存目录、任务 bash 的 PATH 前缀都从它来），传参管不到，只能先改环境变量再加载引擎。所以入口是 `boot.ts`：它只静态导入 node 内置模块和不碰引擎的小工具，定好环境后 `await import("./main.ts")`。

| 变量 | 启动时怎么处理 | 为什么 |
|---|---|---|
| `PI_CODING_AGENT_DIR` | 强制改成 `HOB_HOME/system/engine` | 引擎的 bin（rg / fd）、凭据、资源都在这里；否则会往用户自己的目录里下载和写文件 |
| `PI_MEMORY_DIR` | 强制改成 `HOB_HOME/system/memory` | 本地记忆插件在模块加载时就读它；`createRuntime` 也会再指一次 |
| `LORE_HOME` | 强制改成 `HOB_HOME/system/lore` | Lore 插件读写自己的连接配置 |
| `LORE_BASE_URL`、`LORE_API_TOKEN`、`API_TOKEN`、`LORE_CLIENT_TYPE`、`LORE_SKILLS_ENABLED` | 删掉 | 从 shell 继承的可能是用户别的客户端；Hob 只用自己的配置，也免得任务里的 bash 读到用户的 Token |
| `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`GEMINI_API_KEY`、`GOOGLE_API_KEY`、`DEEPSEEK_API_KEY`、`OPENROUTER_API_KEY`、`XAI_API_KEY`、`GROQ_API_KEY`、`MISTRAL_API_KEY`、`CLAUDECODE`、`CLAUDE_CODE_*` | 删掉（`CLAUDE_CODE_` 按前缀删） | 从启动终端继承的是用户别的客户端的模型凭据，任务里跑的命令能直接读到；Hob 的服务商 Key 只来自自己的 `secrets.json`，删掉后模型列表、服务商、任务都照常 |
| `HOB_LOCAL_PI_DIR`、`HOB_LOCAL_LORE_HOME` | 记下原值（原 `PI_CODING_AGENT_DIR` / `LORE_HOME`，没设就是 `~/.pi/agent` 和 `~/.lore`；用户自己设了这两个就尊重） | 「从本机导入」要读的目录，只记路径、不记密钥 |

结果：任务里跑 pi 命令用的是 Hob 的引擎目录，子进程继承的是 Hob 的变量，没有任何外部客户端的凭据。
- 数据目录 `HOB_HOME`（默认 `~/.hob`），按归属放：系统的东西在 `system/`，能重建的在 `cache/`，助手自己的东西在 `assistants/<id>/`。全部是 JSON / JSONL 文件，原子写（写临时文件再 rename）：

```
~/.hob/
  layout.json                {"version": 2}：有它说明已经是这个布局（迁移最后一步才写）
  rules.json                 全局规则 Rule[]（首次启动或升级时初始化；空数组保留）
  system/                    配置、凭据和引擎内部状态：/api/files 和读文件工具整个挡住
    config.json              启动项：端口、host、密码哈希、cookie 签名密钥（0600）
    settings.json            界面可改的设置（主题、时区、关于你、服务商、模型、并发、卡住判定、推送邮箱），带 revision，写入走 CAS
    secrets.json             密钥（0600，原子写），接口只写不读回：provider:<id>、imageApiKey
    push.json                Web Push：VAPID 密钥 + 订阅设备（0600，原子写）
    seeded.json              首次启动建过的内置内容（devTeam: true = 敏捷团队已建）
    engine/                  引擎目录：auth.json（引擎写的凭据）、models.json（Hob 写给引擎的内置服务商思考档）、mcp.json（MCP 服务配置，设置 → MCP 写）、bin（rg / fd）、资源
    lore/                    Lore 连接（config.json，格式 { base_url, api_token }，0600、原子写）
    memory/                  本地记忆（捆绑的本地记忆插件）
    moves.json               v1 → v2 迁移记下的「旧路径 → 新路径」；会话里的老路径按最长前缀解析
    migrations/v2-<时间>.log 迁移日志：每项搬了什么、归属怎么判的、改写和核对结果
  cache/                     删了能重建
    thumbs/                  对话图片的缩略图
    previews/                设置 → 图像生成「生成测试图片」生成的图
    github/                  GitHub 抓取缓存
    usage-prices.json        models.dev 拉下来的模型单价和上次更新的时间（一天最多更新一次）
  knowledge/                 知识库（几个助手共用）：entries.json、collections.json、blobs/、pages/、text/、index/
  skills/                    全局技能（来源标签 hob）
  assistants/<id>/
    profile.json             Assistant（名字、职责、头像、置顶、通知…）
    rules.json               Rule[]   要先问你 / 规矩
    worklog.jsonl            WorklogEntry 每行一条
    router.jsonl             该助手唯一的对话（pi 会话文件）
    state.json               未读位置
    todos.json               单聊的待办 TodoItem[]，按做的先后
    skills/                  本助手的技能（含 .history/、.archive/、skills.json）
    spill/                   对话里大工具结果的全文
    approvals.json           这个助手提的审批 Approval[]
    routines.json            这个助手的定时定义 Routine[]
    routines/<rid>/          定时检查脚本的工作目录
    jobs/<jobId>/            这个助手的任务
      job.json               Job
      worker.jsonl           任务会话（pi 会话文件）
      report.md              完整报告（Spill）
      steps/                 过程里超长输出的全文
      work/                  默认工作目录（screenshots/ 在它下面）
    files/
      uploads/  images/  pages/  screenshots/   输入框上传、对话生图、展示页面、助手截图
  assistants/hob/drafts.json     Draft[]（新助手草稿，只有主助手会提议）
  assistants/hob/delegations.json Delegation[]（主助手转交记录）
  groups/<gid>/
    group.json                 Group（名字、负责什么、群主、成员）；话题的是另一个 groups/<tid>/，里面只放话题自己的字段
    rules.json                 本群规则，话题共用
    routines.json              本群定时，groupId 指定结果发到群或话题
    routines/<rid>/            群定时检查脚本的工作目录
    skills/                    本群技能及其版本、归档，话题共用
    timeline.jsonl             群里的条目，追加写；同 id 后写的覆盖前面的
    state.json                 已读到哪条
    members/<aid>.jsonl        成员在这个群里的会话（pi 会话文件）
    members/<aid>-spill/       这个群会话里大工具结果的全文
    files/uploads/             群里上传的文件
    todos.json                 这个会话（综合或话题）的待办 TodoItem[]，同一个话题里的成员共用一份
  archive/assistants/<id>-<时间>/  归档的助手：整个目录原样移到这里（档案、规则、对话、定时、审批、任务、文件都跟着走）
  archive/groups/<gid>-<时间>/     归档的群：整个群目录原样移过来，各话题在它的 topics/<tid>/ 下
```

目录（路径具体到哪个助手）在 `server/src/config.ts` 里有一组 helper，迁移和恢复在 `server/src/layout.ts`。任务按 jobId 找目录：启动时扫一遍 `assistants/*/jobs/` 和 `archive/assistants/*/jobs/` 在内存里建映射，新建任务时登记，不另存索引文件（免得和实际目录对不上）。

### 数据目录迁移（v1 → v2）

老布局是按「东西是什么」平铺（`jobs/`、`pages/`、`images/`、`uploads/` 各一个目录，几个 json 放在根上），v2 按归属放。启动时在设置引擎环境变量之前自动跑一次，旧数据不丢：

1. **要不要迁**：有 `layout.json` 且 `version: 2` 就跳过；根上没有老布局的东西就是全新安装，直接建好目录写 `layout.json`。
2. **空间**：可用空间不够「数据大小 + 64 MB 余量」就拒绝启动，报错写清需要多少、现在剩多少，数据一个字节不动。
3. **完整备份**：把整个 `HOB_HOME` 复制到 `HOB_HOME/backup-v1-<时间>/`（排除它自己），保留权限（0600 文件仍是 0600）、符号链接和修改时间；逐个文件核对大小和 sha256，对不上就删掉这份备份并拒绝启动。
4. **搬**：同盘用 `rename`；遇到 `EXDEV` 就复制、核对、再删原文件。
   - 任务的归属看 `job.json` 的 `assistantId`，审批和定时看记录里的 `assistantId`，定时工作目录看 `routines.json`。
   - 页面、图片、上传的归属：在各助手的 `router.jsonl` 和各任务的 `job.json` 里找它的完整路径，第一个提到它的助手就是主人；都没提到就归主助手。归属写进迁移日志。
   - 归档助手的东西（含它原来在根 `jobs/` 里的任务）进对应的归档目录；助手既不在了也没归档的（孤儿）进 `archive/assistants/<id>-orphan/`，日志里列出来，不丢。
5. **改写结构化 JSON**：只改 `job.json` 里的绝对路径（`cwd`、`reportPath`、`files`、`inputs`、`rounds[].reportPath`、`rounds[].files`）和 `knowledge/entries.json` 的 `path` / `sourceKey` / `versions[].path`，原子写。会话文件（`router.jsonl`、`worker.jsonl`、`report*.md`、`steps/*.txt`）是只追加的正文，一个字节都不改。
6. **写 `system/moves.json`（旧路径 → 新路径），最后写 `layout.json`**。
7. **断电恢复**：启动时看到有 `backup-v1-*` 却没有 `layout.json`，说明上次没迁完 —— 先从备份恢复（清掉除备份以外的东西再复制回来并核对），然后重新迁移。备份写完之后才写 `.hob-backup.json` 标记；没有标记的半份备份直接删掉重来（数据还没动过）。

老路径怎么活：会话和卡片里写的还是 v1 的绝对路径，`GET /api/files`、`/api/files/meta` 和助手的 `read` 工具（都走 `files.ts` 的 `lookupFile`）在路径不存在时按 `moves.json` 最长前缀换到新位置；界面打开旧链接、助手读旧路径、`send_file` 发老路径都靠这一层。换位置是悄悄的：工具结果和界面输出里不提示“已经搬到新位置”，迁移是 Hob 自己的事，不让模型和用户去适应。任务自己用 bash 读旧路径的读不到，这是接受的。

命令行入口：`npm run layout -- --dry-run` 只打印计划什么也不动，`npm run layout -- --restore` 从备份恢复成老布局。备份**不自动删**：确认新布局没问题后自己删 `backup-v1-*`（里面有整份凭据，删之前先想好）。降级要把数据整体退回老布局：旧版本不认识新布局，不能新旧版本同时写同一份数据。

## 核心对象（契约在 `shared/types.ts`，前后端共用，改它要两边一起改）

- **Assistant（助手）**：主助手 `id = "hob"` 唯一内置，首次启动自动创建；其余都是用户数据。首次启动另外带上「敏捷团队」：5 个收起的助手（产品负责人、架构师、开发、测试、发布）和一个默认群，只建一次，标记写在 `system/seeded.json`，用户删了、归档了都不补回来；这 5 个是 `hidden`（收起的助手），老用户已经占了同名 id（`po`、`dev`…）就换一个不冲突的，不覆盖原来的助手。`duty` 是职责简介，`dutyLong` 是详细职责；创建助手时从草稿复制，旧助手启动时从对应的已创建草稿幂等回填。长期记忆不属于某个助手（见下文“记忆”），助手需要知道的专属事实写在 `instructions`（补充说明）里。
- **Item（对话条目）**：对话 = 有序的 Item 列表。用户消息、助手回复从 pi 会话的消息得出；卡片类（question / job / draft / note / file）用 pi 的自定义条目 `customType: "hob.item"` 存在同一个 `router.jsonl` 里，**不进模型上下文**。卡片的可变状态（审批是否已选、任务进度、草稿是否已建）在 approvals.json / jobs / drafts.json 里，条目只存 id 引用，渲染时合并。老数据里还有 `todos` 条目（以前收起的一份待办），现在不再写入、界面也不显示。
- **Job（任务）**：一次隔离执行 = Hob 进程里的一个 Worker pi 会话（`cwd` 给了就在那个目录干，不给就用 `HOB_HOME/assistants/<助手id>/jobs/<id>/work`）。任务记录带干活用的 `model` / `thinking`、`usage`（token 和花费）、`durationMs`；过程从 `worker.jsonl` 推导成 JobStep 列表（`server/src/transcript.ts`），实时动作走 `job_step` 事件。`assistantName` 记下建任务时的助手名，助手归档后任务详情照样显示。结束的任务可以接着做（续做）：上一轮结束时的状态、原因、用时存进 `rounds`，对话里再放一张带 `round`（第几轮）的任务卡。界面上同一个任务只显示最新一轮那张卡（`Items.tsx` 的 `visibleItems`），它跟着任务实时变；前几轮按 `rounds` 在任务详情里切换着看。
- **Approval（审批）**：选择题卡片。来源可以是 Router（不阻塞，答案作为下一条用户消息回到 Router）或旧数据中的 Worker 提问（新任务只向助手提问，不生成用户审批卡）。带 `always` 的选项（"以后这类直接…"）选中后自动写一条 `mode: "allow"` 的 Rule，并在对话里出一行"已记进 X 的规矩 · …"。审批仍属于提问的助手；转交回合中助手提出的审批，也在主助手的委派卡内展示同一条审批，两处调用同一答复接口。
- **Routine（定时）**：cron 表达式（`croner` 库）。单聊定时到点为所属助手开 local Job，结果作为带「⏱ 名字」标签的助手消息回到对话；群定时由群主负责，到点在目标群或话题留下记录并交给群主处理，检查脚本的 notify 输出直接发送。群主变化时定时跟随变更，技能不可用时解除绑定。运行记录包括任务和交给群主的记录。助手用工具建、改定时任务时，存下「要做的事」是谁写的（`instructionBy`：用户自己写的，还是哪个助手）和建它、改它那一轮用户的原话（`userWords`，留最近 3 条）；到点时原话和助手的转述分开给出来，用户自己写的直接标明。
- **Draft（新助手草稿）**：Hob 提议分出助手时生成。点"创建"才真正建助手，并把草稿里的补充说明写进新助手的 `instructions`、在新助手对话开头写一行"X月X日 由 Hob 创建"。

## 归档助手

助手可以收起，也可以归档（`POST /api/assistants/:id/archive`）。归档不往主助手转任何东西。

- 拒绝：主助手（"主助手不能归档"）、助手不存在、这个助手还有进行中 / 排队 / 等待确认的任务（"请等任务结束后再归档"）。
- 这个助手还没答复的审批记为 `expired`，卡片不再挂着。
- 整个助手目录（档案、规则、对话、技能、审批、定时、任务、上传和生图）用同盘 rename 移进 `HOB_HOME/archive/assistants/<id>-<时间>/`，不复制、不删除，任务和文件都跟着助手走；它的定时先停掉并从还在的助手的列表里拿掉（推 `routine_removed`），定义还留在归档目录里。`Job.assistantName` 补上当时的助手名，任务详情里不会因为助手不在了而报错。
- 然后推 `assistant_removed`：前端从列表移除，正看着它的切到主助手，草稿卡里指向它的"已创建 · 查看"变成"已归档"且不能再点。

## Router（对话层）

每个助手一个常驻的 pi 会话（懒加载，空闲 30 分钟释放内存，下次用再从 `router.jsonl` 打开）。

- 系统提示词：身份和回复规格、可用及未开的能力、事件信任边界、用户信息、全局规则和助手规则、补充说明、记忆、定时，以及其他助手和群（仅 Hob；群只列群主和成员，不列话题）。每次开新一轮前重建，全局规则列在助手规则之前。
- 模型：设置 → 模型里的对话模型（没选就没有，回复时出一条说明提示去配服务商）。
- 工具（全部是 Hob 自定义工具，无 pi 内置工具）：

| 工具 | 作用 |
|---|---|
| `start_job(title, note?, cwd?, expect_minutes?, after?)` | 开任务，立即返回 jobId；对话里出任务卡片。`cwd` 指定工作目录；`after` 要等哪些任务做完 |
| `check_job(jobId)` | 查看任务状态、过程、结果和所用技能；主助手可看所有任务，其余助手只看自己的 |
| `update_todos(items)` | 列一份待办，整份替换：每项只有 `text` 和 `status`（todo / doing / done）。单聊存 `assistants/<id>/todos.json`，群的综合和话题存 `groups/<gid>/todos.json`；同一份清单谁后写以谁为准。每轮开头把当前这份带给模型；全做完、清掉、话题关了、搁久了就收进时间线（见下文「待办」） |
| `save_job_as_skill(jobId, into?, general?, note?)` | 让已完成的原任务在自己的会话里新建或修补技能，进度和结果显示在原任务上；`general: true` 新建在 `HOB_HOME/skills`（所有助手都能用），填了 `into` 改的就是那份、不看它 |
| `reply_job(jobId, text)` / `stop_job(jobId)` | 给在跑的任务补话 / 停掉 |
| `ask_user(title, detail?, options[]?, questions[])` | 出选择题卡片（不阻塞）；`options` 最多 3 个，可标 `always`；一张卡问几个问题用 `questions`（每个问题 2 到 3 个选项，可标推荐哪个），用户答完答案一起回来 |
| `set_rule(text, mode)` / `remove_rule(ruleId)` | 改要先问你；对话里出"已记进 X 的规矩 · …"。主助手多一个可选 `assistantId`，改那个助手的 |
| `create_routine` / `update_routine` / `delete_routine` | 改定时；对话里出"新增定时 · 名字 · 时间"。主助手多一个可选 `assistantId` |
| `create_assistant(..., facts)` | 仅 Hob：存草稿、落助手卡，然后立刻按草稿建好（卡片直接是「已创建」）；建失败把原因返回，草稿留着让用户在卡上点。facts 写专属事实并存为补充说明（sprite 可填 custom + prop_art 自画一件道具） |
| `show_assistant(assistantId?, query?, page?)` | 仅 Hob：不填 id 列出全部助手（含收起的、按左栏顺序），填了看完整资料（说明、模型、能力、知识库、规则、定时、技能）。每页 20 条 |
| `update_assistant(assistantId, ...)` | 仅 Hob：改别的资料（名字、职责、说明、模型、能力、知识库、置顶、收起、通知），只改填了的项；和 `PATCH /api/assistants/:id` 共用 `updateAssistant()`。换头像不在这里，用 `set_avatar` |
| `show_group(groupId?, query?, page?)` | 仅 Hob：不填 id 列出全部群（群主、成员、进行中的话题数），填了看群或话题的详情和消息，带 query 在消息里找。每页 20 条 |
| `create_group(name, purpose, members, ownerId)` / `update_group(groupId, ...)` | 仅 Hob：走 `groups.create` / `groups.update`；成员用加、减两个列表 |
| `manage_topic(action, groupId?, topicId?, title?, note?)` | 仅 Hob：开、关、重开、改名任何一个群的话题，不要求是群主；开出来的话题是空的 |
| `edit_skill(name, edits?, general?, assistantId?)` / `delete_skill(name, replaced_by?, assistantId?)` | 替换技能正文，保留 frontmatter、旧版和附件；`general` 换它给谁用（true 换成通用的，false 收回本群 / 自己的）。删除会检查任务和定时绑定，可改绑。主助手多一个可选 `assistantId`，改那个助手的 |
| `set_avatar(sprite, color?, prop_art?, assistant?)` | 换头像：内置道具/颜色，或 custom（+ prop_art 自画）；主助手可传 assistant 给其他助手换；成功后推 assistant 事件，对话里出一行「已换头像」 |
| `overview(sinceHours = 24)` | 仅 Hob：只读，各助手这段时间的工作日志、结束的任务、在跑的任务、未答审批（写早报/汇总用） |
| `message_assistant(assistantId, text)` | 仅 Hob：创建持久化委派卡并在目标对话显示「转自 Hob」，目标回合及关联任务结束后只向 Hob 回流一次结果，本轮结束 |
| `message_group(groupId, title, note?)` | 仅 Hob：把一件事交给群：在群里开一个话题，把用户原话、前面几句对话和备注转进去，叫醒群主接；这个话题的结论回到 Hob 的对话 |
| `hand_back_to_hob(text, reason)` | 仅非主助手：不归自己职责的事交回 Hob；普通回合在双方对话中留下可互相定位的条目，转交回合则退回委派，本轮结束 |
| `edit_notes(edits, group?)` | 仅非主助手：改自己的补充说明（一段原文换新文字，old 空串是接在最后），走 `updateAssistant`，对话里出一行「修改了自己的补充说明」。群主在群里多一个 `group`，填 true 改本群的（话题改所属群的，走 `groups.update`），出一行「修改了本群的补充说明」 |
| `send_file(path)` | 把任务产出的文件作为文件卡片发到对话 |
| `generate_image(prompt, size?, refs?)` | 配置图像生成且助手能力开启时可直接生图，结果自动显示在对话 |
| `show_page(title, summary, html)` | 助手写正文 HTML 片段，Hob 套上自带样式（亮暗跟随）和离线 CSP 存为单页，发页面卡后结束本轮；对话生成时通过实时事件展示草稿；通用设置可关闭 |
| `web_search(query, depth?, max?)` / `web_fetch(url, raw?)` | 已启用联网搜索时可直接搜索或读取网页，搜索服务商按设置的优先级使用 |

- 事件消息（任务结束、定时结果、别的助手回复、审批答案）以用户角色进入 Router 上下文，但前缀固定的标记 `[hob-event]`，**不渲染成用户气泡**。
- 事件那一轮可以不说话：模型最后一段回 `NO_REPLY`（`shared/no-reply.ts`），这一轮写的字一段都不给用户看，卡片、文件、提示行照常。确认语和开场白多半写在调工具之前，所以事件那一轮的文字不边写边推，到这一轮结束、或者用户插话进来（模型读到用户消息）时才出；单聊刷新后由 `walk` 按同样的分界推导，群里由 `GroupManager.settleEventTurn` 写进时间线。什么时候回 `NO_REPLY` 由提示词讲、模型判断；这个词本身任何一轮都不显示。
- 对话按“同一次回复”分组：组内条目贴着，组间拉开。事件之后的第一条带 `lead`（由会话条目推导，实时推送的条目算法相同）；任务提问和文件先交给助手，助手决定如何呈现。
- 出卡片的工具（`start_job` / `ask_user` / `message_assistant` / `message_group`）的工具结果带 `terminate: true`：pi 在一批工具结果全部 terminate 时停止本批之后的模型请求，所以出了卡片这一轮就结构上结束，模型不会再补一句“卡在上面了”。同一批里混了别的工具（如 `set_rule`）就不提前结束，这是 pi 的规则。`create_assistant` 出的助手卡不结束本轮：建好之后还要说一句建了什么。
- 主助手的管理工具（上面带「仅 Hob」的几个）单聊和群里都有；每改成功一次，这次说话所在的对话里落一行提示，改到某个群（含话题）的，那个群的时间线里也落一行（"Hob 把写稿搭子拉进敏捷团队"），同一条时间线只落一行。
- Router 正在回复时你又发消息 → `steer`；Router 空闲时来事件 → 直接开新一轮；忙时来事件 → `followUp`。

## 委派给其他助手

- 助手之间是以 Hob 为中心的星形关系，不互相直接调用。Hob 提示词列出其他助手的职责简介、详细职责和需确认规则，供它选择目标。
- 委派记录存入 `delegations.json`。目标对话立即显示转来消息，目标忙时排队处理；仅转交回合创建的任务关联到委派。Router 审批记在委派记录上，Worker 提问先交给目标助手处理。
- 委派卡内的审批与目标对话引用同一审批，答复只提交一次。目标回合和所有关联任务结束且没有待答审批后，服务端同步写入 `reportedAt`，再向 Hob 推一次包含回复和任务报告的事件。转交回合调用 `hand_back_to_hob` 时委派标为 `returned`、记录退回原因，回流事件提醒 Hob 不要再转给同一个助手；不额外生成转来消息。重启时没有在跑任务的未完成委派标为已中断，可从卡片重新转交。

## 群

用户和几个助手在一个长期的地方一起做事（效果和定下来的规则见 `.scratch/v2/design-groups.md`），数据在 `HOB_HOME/groups/<gid>/`（见上文的数据目录）。

- **成员**：一个或几个助手，收起的助手也能进群。同一位助手可以在几个群里，记忆全局共用，助手有自己的技能和规则，群也有自己的技能和规则；各群的对话分开。建群和改群都不接受空成员。
- **话题和综合**：一个群里同时办几件事时，每件事开一个话题，各走各的。群自己的那条时间线叫「综合」，用户和群主都能在综合里开话题。
  - 话题就是挂在群下面的群：带 `parentId` 的 `Group`，存在 `groups/<tid>/`，id 也是 `g-` 开头。时间线、成员各自的会话（`aid@tid`）、轮到谁、任务和提问卡回到哪、已读、事件都复用群的机制。
  - 话题的成员、群主、负责什么只在所属的群上存一份：`groups/<tid>/group.json` 只有 `id`、`parentId`、`name`、`createdAt`、`createdBy`、`closedAt`、`closeNote`，读的时候补上所属群的字段，群改了话题跟着变。
  - 关了的话题不能再发消息，能重新打开；关闭时写的说明在话题卡上。群归档时话题一起搬进 `archive/groups/<gid>-<时间>/topics/`。话题不用归档，用关闭。
  - **主助手交来的话题**：Hob 用 `message_group` 在群里开话题交给群主，话题上记着 `handover`（谁交的、什么时候）。转进去的第一条是用户原话加前面几句对话和备注，`forwardedFrom` 记着它来自 Hob 的对话和那条用户消息，界面上方标「从和 Hob 的对话转来」。Hob 交来的话题关的时候要写结论（`close_topic` 没写报错），关了会送一条系统消息回 Hob 的对话：写了结论的带结论，用户在界面上没写结论关的说明这一点。先记下要送的话再送，送到了才标已送，重启补送没送到的，同一话题只送一次。
- **待办（所有会话通用）**：每个会话（单聊、群的综合、每个话题）一份待办，`TodoItem { text, status }`，`status` 只有 `todo`、`doing`、`done`。存在单聊的 `assistants/<id>/todos.json` 和群（综合、话题）的 `groups/<gid>/todos.json`。待办只归助手，任务没有：交给后台任务的一步就是助手那份里的一项。只有模型调 `update_todos` 改，每次传完整的一份整份替换，同一份谁后写以谁为准；不跟任务状态联动、不自动开任务。
  - **每轮带给模型**：会话里有待办时，这一轮的用户消息里带上「手上的待办 k/n，多久以前更新」和每项做到哪儿（`now.ts`，跟【现在】走同一条路）；没有就不带。还有没做完的项、距上次更新已经好几轮时，后面再接一句「这份待办已经 n 轮没更新了……」；轮数从这个会话的记录里数（上次更新以后的用户消息条数），提醒过以后要再过 `TODO_REMINDER_ROUNDS` 轮才再说。系统提示词里没有这一段（它每轮一样，缓存才命中）。收起的待办不进上下文，所以聊多久也只有当前这一份。
  - **有头有尾**：当前这份遇到五种情况就清空——传进来的每一项都是 `done`（工具返回「待办 n/n，都做完了，已经清掉。」）、传空列表而原来还有没做完的（「待办清掉了。」）、话题关了还有没做完的、超过 24 小时没更新且这个会话里没有在跑的任务、用 `message_assistant` 把整件事转给别的助手而这份还有没做完的（「已经清掉」；没做完的那几项另写进发给接手的助手的内容里）。收起的那些**不再写进时间线、不进对话**：对话里只放用户需要看的东西，清单是助手自己的进度。`TodoArchiveWhy` 和 `kind: "todos"` 条目 只为读老数据保留，不再写入，界面不显示（`Items.tsx` 直接返回 `null`）。「搁久了」在每轮开始前和服务启动时检查，不另起定时器；24 小时是兜底（`todos.ts` 的 `TODOS_STALE_MS`），主要靠模型每轮看到手上的待办自己清。转交时没替接手的助手写它的 `todos.json`。老数据（只有清单的 `todos.json`）照常读成当前那份，更新时间取文件时间。
  - **界面只显示进度**：会话输入框上方一条（正在做的那项、`k/n`、细进度条，点开只读清单），左栏话题行一个 `k/n` 小标签。老数据里时间线那些 `kind: "todos"` 条目不再显示。以前的 `projects/` 老文件不读也不删，时间线里老的 `kind: "project"` 条目不显示。
- **话题的接口**：`GET /api/groups` 返回群和话题（话题带 `parentId`，状态由 `closedAt` 和待办推出）；`POST /api/groups/:gid/topics {title}` 开话题；`POST /api/groups/:tid/close {note?}` 关闭；`POST /api/groups/:tid/reopen` 重新打开；关闭后 `POST /api/groups/:tid/messages` 回 400。`POST /api/groups` 和 `PATCH /api/groups/:id` 忽略传入的旧 `workflow` 字段并保留文件原值，话题只能改名。
- **每个成员一份群会话**：会话键是 `<assistantId>@<gid>`（话题是 `@<tid>`），单聊还是 `assistantId`。文件分别落在 `groups/<gid>/members/<aid>.jsonl` 和 `assistants/<aid>/router.jsonl`，上下文互不搅扰。群会话的工具包括做事和沟通用的工具，以及管理本群规则、定时和技能的工具；主助手在群里还可管理助手、群和话题，改其他助手的规则、定时和技能在单聊里做。展示页面按助手存，进群要另做，先不给（`show_page`）。系统提示词把「一对一」那段换成群里的规矩，群主在综合里能开话题、多一段开话题的说明。话题会话在群那段后面接一句「这里是群「…」的话题「…」」，群名写所属的群。云桌面一个助手只有一个屏幕，单聊和它的群会话共用一个。
- **卡片和结果都留在群里**：`start_job`、`ask_user`、`send_file`、`generate_image` 的卡片进群的时间线（发言人是这个成员），任务卡和提问卡带 `groupId`；任务结果、任务提问、超时提醒、沉淀结果作为事件送进派它的成员在这个群里的会话，由它在群里说，回复里 @ 了别人照常接力。审批答案也回到群会话。群归档了、或者成员已经被移出，卡片和事件落回单聊，不报错。群里派的任务带的是这一轮的来由（见下面「交接」）。
- **谁说话由代码定**：用户的消息 @ 了谁、引用谁的消息，就轮到谁；都没有就轮到群主。成员的回复里 @ 了别的成员，接着轮到他们（被 @ 的本人不算）。没轮到的成员不调模型。同一成员同时被叫两次就排队；排到时它上次之后已经没有新条目（前面那一轮已经带上了要给的），这一轮就不跑、不调模型。一条用户消息引出的助手回合超过 20 个就停，时间线里留一行「群里接力太多次，先停在这里」，并给群主发一个事件。事件送进群会话时也算新的一串回合。
- **用户中途说话插进正在跑的那一轮**：轮到的成员在这个群里正说着（它的群会话在流式），新条目用 `steer` 插进那一轮，不另排一轮；会话刚好跑完（不在流式）就照原来的路子排队。事件那一轮的输入先列它还没见过的群条目、再写 `[hob-event]`，排队期间用户说的话这一轮就看得到。
- **一轮的输入**：这个群时间线里它上次说完以后的条目，按「名字：内容」一行行列出，最后是叫到它的那条；卡片写成一句事实。给到哪一条记在 `state.json` 的 `seen`（只调了工具没说话的回合也不重复给）。单聊那套转交接管和「过期待答提问」不跑（那是单聊的）。
- **交接**：一件事从一个会话交给下一个会话（定时 → 综合 → 话题 → 任务）时，带什么、归谁、给对方看什么，各只有一处定义：
  - **来由**：触发这一轮的那条消息，用户的消息（文字、引用、附件），或者定时到点的记录连同到点时交给群主的全文（记在记录的 `request` 上，界面不显示）。事件回合取时间线上最近的一条。唯一入口是 `GroupManager.requestItem`，文字用 `requestText`；派任务（`Router.originalWords`）、开话题都从它取。定时触发的，不带「最近的对话」。
  - **出处**：任务和提问卡属于开它的会话（`groupId`，没有就是单聊），结果回到那里。给模型看的地方，不是这个会话开的都写明在哪（`origin.ts` 的 `sessionOrigin`：单聊、综合、话题「…」、群「…」）。每条消息前的【现在】只在「进行中」「等用户选」「最近结束」里列这个会话自己的，别处的另起「别处进行中」「别处等用户选」两行，范围和它管得了的任务一致（群和话题里是同一个群，单聊里是全部）。`check_job`、`reply_job`、`stop_job` 碰到别处开的任务，返回和停止原因里带出处。
  - **原样的事实**：给模型看的任务过程（`jobProcessLines`）用命令原文，不用界面的摘要（`commandSummary` 会删掉开头的 `cd`）。指定了 `cwd` 的任务，提示词里同时写指定的目录和任务自己的目录。
  - **交接时带什么**：每个交接点交给下一处的东西只有一处定义，都从 `Router.originalWords(…, recent, …)` 来（单聊和群各一支，群里的表头写明在哪个群或话题里）：

    | 交接点 | 用户这句 | 前面几句 | 备注 | 附件 |
    |---|---|---|---|---|
    | 开任务 `start_job` | 带（原话、引用） | 带，最近 6 条 | 带 | 带 |
    | 转交给助手 `message_assistant` | 带（原话、引用） | 带，最近 6 条 | 带 | 带 |
    | 交给群 `message_group`（票 183） | 带（原话、引用） | 带，最近 6 条 | 带 | 带 |
    | 开话题 `open_topic` | 转进话题的那一条只有触发这一轮的那条；交给话题里群主的系统消息带原话 | 带，最近 6 条（定时来由不带） | 带 | 话题条目带，系统消息里列路径 |
    | 定时到点 | 带记录的全文（`request`） | 不带（到点前群里聊的多半是别的事） | 带 | 不带 |

    以后新加的交接点照这一节办。
- **条目**：`GroupItem` 在 `Item` 上加发言人，id 是 `g-<序号>`（按群递增）；流式时先写一条 `streaming` 的条目，说完按同一个 id 再写一行完整正文，读的时候后者覆盖前者；卡片状态变了也按同一个 id 再写一行。进程重启时看到的 `streaming` 条目不续，收尾后补一行「服务重启，这一轮中断了」。
- **事件**：`group`（群或话题新建、变化，带 `last` / `unread` / `busy` / `todos`）、`group_removed`（群和它的每个话题各发一次）、`group-item`、`group-delta`、`group-activity`。`busy` 是正在说话或有任务在跑的成员。
- 归档助手时从它所在的群里移出（群主换剩下的第一个成员）；群里没人了就一起归档。群会话的用量记在对应助手名下的「对话」里。

## Worker（任务层）


- 每个 local Job 一个独立 pi 会话，cwd 默认 `HOB_HOME/assistants/<助手id>/jobs/<jobId>/work`（启动时建好；`start_job` 显式给了 cwd 才用给的）。产出文件约定放在这个目录，读可以读任何地方；工作目录是约定，不是强制边界，v1 不拦截命令和文件写入。要给用户看的文件用 `report` 的 files 交回（落盘后 `/api/files` 能读）。
- 工具：任务没有展示页面工具，结果写成 report 的 Markdown，必要的产物文件放进 files，怎么展示给用户由助手决定；启用联网搜索时有 `web_search`、`web_fetch`；pi 内置 `read, bash, edit, write, grep, find, ls`（内置工具自带截断并把完整输出写进临时文件 = Spill），加 Hob 的 `report(outcome, result, files?)`、`ask_user(title, detail?, options[])`（阻塞等助手回复，助手自行回答或询问用户后用 `reply_job` 回复）；主助手的任务（定时就是它）另有只读的 `overview(sinceHours = 24)`，用来写早报/汇总；配了图像生成且该助手开着图像生成时再加 `generate_image(prompt, size?, refs?)`（见下文“图像生成”）。
- 系统提示词：任务身份和目录、交付与如实报告、用户信息、全局「一律照做」规则、全局和助手的执行前确认事项、补充说明和记忆；确认事项通过 `ask_user` 询问，结果通过 `report` 提交。
- 模型：设置 → 模型里的任务执行模型（没选就退到对话模型，还没有就用模型列表里第一个可用的，思考 `high`）。
- 并发：同时最多 `settings.work.maxJobs`（默认 2）个任务，多的排队（状态 `queued`），改设置立即生效。
- 预计用时：派任务时可由助手估计，未填和续做均为 10 分钟；定时任务取最近最多 5 次已完成用时的中位数，没记录则为 10 分钟。从本轮开始运行计时，任务等待助手回答不计入；达到预计用时的 1、2、4、8……倍时通知所属助手，定时中位数则在 1.5、3、6、12……倍时通知。通知附最近 10 条过程，不附指令。
- 活动流：从 Worker 的工具事件生成 ActivityLine（`读 路径` / `跑 命令` / `改 路径` / `搜 模式`），统计 reads / commands / edits，实时推给前端，Job 里保留最近 200 行。
- report 的 summary 进卡片和 Router 事件（≤ 600 字）；完整的最后一条回复和 summary 写 `report.md`。
- Watchdog：
  - `settings.work.jobStallMinutes`（默认 15 分钟）没有任何事件 → `stuck`（原因"N 分钟没动静"），不杀，推事件；
  - 一轮结束没 report → 自动追问一次，再不报 → `stuck`（"没交代结果"）；
  - 进程重启时还在 running/queued/waiting 的 Job → `failed`（"Hob 重启，任务中断"）。

## 记忆（长期记忆）

记忆是所有助手共用的一份（关于用户的事实、偏好、约定），不属于某个助手；助手的专属事实放在补充说明里，做事方式放在规则或技能里。

- 设置 → 记忆三选一：**本地记忆**（捆绑 `pi-memory` 0.4.2）/ **Lore**（捆绑 Lore 的 pi 插件正式版）/ **关闭**。两个插件随 Hob 固定版本，绝不安装任何东西，**绝不同时加载**（加载时断言）。
  - `pi-memory` 在 package.json 钉死版本。
  - Lore 插件只发在 GitHub Release（`lore-pi.zip`），不在 npm 上。`vendor/lore-pi-extension/` 里放的是某个正式版的原样内容，按路径加载，不手改。换版本用 `npm run update-lore -- <版本号>`（`scripts/update-lore.mjs` 下载那一版的 `lore-pi.zip` 换进来），测试通过后随 Hob 一起发布。当前版本在设置 → 记忆里显示（`GET /api/memory` 的 `lorePlugin`）。
- 加载方式：Router 和 Worker 会话各开一份 pi 会话时，`PiHost` 用 `DefaultResourceLoader` 只挂当前提供者的那一个插件入口（`noExtensions: true`，用户自己装的扩展一份都不加载），工具放行按插件工具名（`memory_*` / `scratchpad` / `lore_*`）。本地记忆强制 `PI_MEMORY_EXIT_SUMMARY=0`，`memory_search` 在注册前过滤掉（没带 qmd，只会报错）。本地记忆目录是 `HOB_HOME/system/memory`（插件在模块加载时就读 `PI_MEMORY_DIR`，所以 `createRuntime` 在打开任何会话之前把它指好）。
- 缺省解析：从没选过时，看 Hob 自己的 `HOB_HOME/system/lore/config.json`（启动时 `LORE_HOME` 指到这里，插件读的也是它）——地址和 Token 都有 → Lore，否则本地记忆；选过就按选过的。存在 `settings.json` 的顶层 `memory.provider`。
- Lore 连接只读写 `HOB_HOME/system/lore/config.json`（0600、原子写、保留不认识的键），不读环境变量、不碰其他 Lore 客户端的配置；函数显式收 `home`。Token 只写不读，接口只报 `tokenConfigured`；换地址不换 Token 时旧 Token 清掉。明文 http 只允许本机 / 局域网 / Tailscale / IPv6 ULA 与 link-local / `.local`，公网必须 https。
- 选 Lore 但连接没配好 → 接口 400（fail-closed），**绝不静默回退到本地记忆**。连不上也不回退，测试连接把原因（地址无效 / 公网用了 http / 缺 Token / Token 被拒 / 连不上）原样显示。
- 切换生效：新会话立即生效；空闲的 Router 立刻释放，在回复的等这一轮跑完再释放，下一轮按新提供者重新打开。
- 提示词里的「记忆」一节按当前提供者逐轮生成（本地记忆讲 `memory_read`/`memory_write`，Lore 讲在 Lore 里查/记），关闭时不出这一节。
- 写成功：对话里不出提示行。记下了什么只给模型；对话里只放用户要看的东西（老数据里的「记忆已更新」行前端滤掉，见 `Items.tsx` 的 `visibleItems`）。
- 老数据：启动时发现 `assistants/<id>/memories.json`，把每条作为一行追加进该助手的 `instructions`，然后删掉文件（一次性，不是兼容层）。

## 技能

技能按「谁能用」分三档，一个助手看得到哪些只在一处算（`skills.ts` 的 `visibleSkills`）：

| 范围 | 谁能用 | 放在哪 |
|---|---|---|
| 通用 | 所有助手 | `HOB_HOME/skills`（能改的那一档）；Lore 的、本机 `~/.agents/skills` 的只读 |
| 本群 | 这个群的成员，在这个群里（含话题，用所属群的） | `groups/<群>/skills` |
| 助手自己 | 这个助手，单聊和它在的群里都能用 | `assistants/<id>/skills` |

同名时按本群 → 助手自己 → `HOB_HOME/skills` → Lore → `~/.agents/skills` 取第一份，被盖住的不出现；设置里停用的通用技能不出现（`settings.skills.disabled`，键是 `hob:名字` / `lore:名字` / `common:名字`）。本群和自己的技能停用后还在清单里（带 `enabled`），只是不加载、不进提示词，能改、能删、能重新开。

- **只读的两类**：Lore 的技能库是所有 agent 共用的，本机 `~/.agents/skills` 是别的工具共用的，Hob 改了会影响到外面。这两类只能照着用；助手要改它们时，工具照实说它在哪、去哪改，或者让任务另存一份 Hob 的技能。
- **能改的三档同一套**：`skills.json` 记索引（版本、标题、时间、用量、开关），旧版在 `.history/<版本>`（最多 5 版），换范围时连同历史一起搬，删了移到 `.archive`。`HOB_HOME/skills` 也一样，所以助手能改、能删、能回退、能新建在这里。
- **导入格式的兼容**：`HOB_HOME/skills` 里可能放着从别处来的技能（目录名和 frontmatter 的 name 不同、说明超过 120 字、没有 `metadata.title`、顶层多几个文件）。启动时和导入后给没登记的目录补索引（第 1 版、标题取 `metadata.title` 没有就用名字、时间取 SKILL.md 的修改时间），目录名和 name 不同的把目录改名成 name（索引、版本历史、改删都对得上这个名字；已经有同名目录的跳过并记日志）。改正文、回退、沉淀改已有的，都原样保留 frontmatter（包括 Hob 不认识的字段）和目录里的其他文件。
- **给任务**：任务带上它能用的全部技能（任何一档），看得到名字、说明和位置，对得上才读正文（`Job.skillsUsed` 记下真正读过的；能改的那几档同时记用量）。任务这一轮、沉淀那一轮和续做都按开会话时启用的技能加载；只读的 Lore 那份由 Lore 插件发现，不重复给。引擎的默认技能目录与项目技能不加载。
- **给对话层**：提示词列出看得到的技能（本群、你的、通用能改的、通用只读的），带标题、版本、更新时间和文件路径，助手可读取并修改正文；「你手里有什么」不再单列通用技能。
- **定时任务**：绑定的技能（任一档，含只读的）写进任务说明，让任务先读它。
- 一份技能读不了（比如 SKILL.md 坏了）只跳过那一份并记日志，其他技能照常可用。

设置页可从 pi、Claude Code、Codex 的本机技能目录复制到 Hob，限制大小并跳过越界链接；覆盖已存在的同名技能算一次新版本（旧的进历史）。设置页删除和助手删技能一样移到归档。

任务完成后不自动沉淀；助手判断事情定下来后，用 `save_job_as_skill` 让原任务沉淀一次，也可从任务详情手动触发（不带 `into` 时默认改这个任务沉淀出来的那份）。新建归这个助手（群里归本群），`general` 填 true 就新建在 `HOB_HOME/skills`；填了 `into` 改的是那份，它在哪就在哪。

沉淀就是任务的又一轮：在任务自己的会话（`worker.jsonl`）里接着发一条沉淀消息，模型、思考档位、系统提示词、技能、工具和自定义工具都和正常一轮一样，另外一定带上 `write`、`edit`。任务直接改目标技能目录里的文件，最后照常 `report`；群任务默认写本群技能，指定 `into` 时先找群技能再找成员技能。任务状态一直是已完成，不算新的一轮，不改 `rounds`，不推 `jobEnded`、`jobResumed`，不触发依赖、排队、看门狗和超时提醒，也不标助手忙；这一轮的用量和过程照常记在任务上（进度走 `job_step`，沉淀消息在过程里显示成「沉淀技能」）。开始沉淀时在 `jobs/<id>/sediment-base/` 记下目标归属，并按目标技能目录排队；轮到后把目录（每个技能目录不含 `.history`，加上 `skills.json`）复制到底稿，重启按记录的目标恢复。从拍底稿到对账或恢复结束，这个技能目录只归这一轮：设置里的导入、`edit_skill`、`delete_skill`、回滚、界面上删技能这期间都报错，写明是哪个助手或群在沉淀（`assistant-skills.ts` 的 `lockSkillsDir` / `assertSkillsDirFree`）。用量计数和启用开关只改 `skills.json` 里的两个字段，照旧能记。

收尾时 `report` 不走普通收尾，改为拿技能目录和底稿对账：跑脚本留下的 `__pycache__` 直接删掉；已有技能变了就照底稿把旧版放进 `.history/<旧版本号>`（最多留 5 版）、版本号加一、记上 `fromJobId`，新目录（底稿里没有的都是这一轮建的）登记第 1 版，标题和说明以 SKILL.md 开头为准；底稿里有、现在没了的技能照底稿放回去。`skills.json` 以底稿和这一轮的结果重写：模型自己写进去的条目和字段不算，只有用量计数和启用开关照现在的留。校验不过时 `report` 返回 `isError` 和原因，这一轮接着做，改完再交。校验通过、有改动时定时任务还没绑技能就绑上新建的那份，任务上记 `saved`（任务卡上显示沉淀状态，对话里不另落一行，技能页看得到版本）（`into` 那份变了就记它，否则记第一份）；没有改动就记 `empty`，原因取 `report` 的 result。这两种都不发结果事件给助手。没交 `report` 就停下时先提醒一次，还不交就按交了处理（result 用最后一段话），校验仍不过就把技能照底稿恢复、任务记 `failed`。

校验规则分两种。改已有的技能只查底线：有 SKILL.md、`name` 和目录名对得上、有 `description`、没有符号链接、SKILL.md 20000 字以内、`scripts/` 和 `references/` 里的附件每个 200 KB 以内。新建的再加 Hob 自己的约定：目录名 `^[a-z0-9][a-z0-9-]{1,47}$`、`description` 120 字以内、`metadata.title`（不空，带不带引号都认）、顶层只能有 `SKILL.md`、`scripts/`、`references/`（和 `.history`）、附件最多 20 个。导入的技能多半不合 Hob 的格式，改它们时不能用 Hob 的约定把它们挡住。

沉淀这一轮里 `ask_user` 不出卡片、不改任务状态，直接回一句「沉淀时不用问」。沉淀中有人接着说（用户在任务卡片上补充、助手 `reply_job`）：中断沉淀会话，等它停下，照底稿把技能改回去，清掉任务上的沉淀状态（不留记录），再照常开新一轮；沉淀那段对话留在会话里。进程重启时沉淀中的任务同样照底稿恢复、记 `failed`。沉淀结果跟着那一轮记（`JobRound.sediment`），续做后前面的卡片各显示各的。只有沉淀失败才通知助手，`saved`、`empty` 不通知。技能删除前检查正在使用的任务与定时任务，归档并可改绑定时任务。

## MCP

任务可以调用 [MCP](https://modelcontextprotocol.io) 服务提供的工具（本地命令 stdio / 远程地址 streamable HTTP）；对话层不执行东西，不加载 MCP。全局一份配置，所有助手派出的任务共用；不做按助手开关。

- **配置位置**：`HOB_HOME/system/engine/mcp.json`，就是引擎自己读的那份（`mcpServers` 格式，与其他 MCP 客户端一致）。Hob 不读用户的 `~/.pi/agent/mcp.json`，除非在「从本机导入」里明确导入（来源只读，同名跳过；也支持从 Claude Code 的 `~/.claude.json` 顶层和 Cursor 的 `~/.cursor/mcp.json` 导入）。写入：同目录临时文件 + rename，新建 0600，只改目标条目，其它键原样保留；文件坏了（JSON 解析失败）读的时候报错，不当成空列表。
- **只给任务**：Worker 会话打开时若配置里有启用中的服务，加载引擎的 MCP 扩展和 tool_search 扩展，会话启动时后台连服务；工具白名单追加 `mcp__*` 和 `tool_search`。Router 会话不加载。改了配置：之后新开的任务生效，正在跑的任务不受影响（不重连）。
- **提供方式**：每个服务选「直接提供」（`exposure: direct`，默认，工具直接声明给模型）或「按需搜索」（`deferred`，模型先搜索再调用，适合工具多的服务）。不提供 codemode（不加载 codemode 扩展，写文件时顶层 `autoEnableCodemode: false`）。单个工具可以关掉（`toolExposure` 里设 `hidden`）；服务整体可停用（`enabled: false`）。
- **密钥处理**：环境变量和请求头的**值**不回传给前端，接口只报键名和「已设置」；整值 `${VAR}` 引用和 `!command` 不含密钥，原样回显。编辑时逐键「保留 / 替换 / 删除」，未动的值不回传。测试连接时密钥的明文值也会从错误信息和 stderr 里打掉。
- **测试连接**（设置 → MCP → 服务详情）：connect → 列工具 → 关闭，单个服务 15 秒超时，显示错误和 stdio 的 stderr 末尾几行；stdio 子进程一定收掉（关 stdin 后对整个进程组 SIGTERM/SIGKILL）。需要 OAuth 登录的远程服务这版不做登录流程，状态显示「需要登录，暂不支持」。SSE 传输不受支持（填 `/sse` 结尾的地址会给明确提示）。
- **任务过程**：任务详情里 MCP 工具调用显示成「服务名 · 工具名」，不露 `mcp__x__y` 原始名。
- 接口：`GET /api/mcp`、`PUT /api/mcp/:name`、`PATCH /api/mcp/:name`（启用 / 提供方式 / 关掉的工具）、`DELETE /api/mcp/:name`、`POST /api/mcp/:name/test`、`GET|POST /api/mcp/import`，都在登录后；服务端实现 `server/src/mcp.ts`。

## 从本机导入（可选）

用户主动点才导入；只读来源文件，绝不写回、不改它们的权限和时间戳。任何接口都不返回 Key / Token 明文。来源目录是启动时记下的 `HOB_LOCAL_PI_DIR` / `HOB_LOCAL_LORE_HOME`。

- **服务商**（`server/src/imports.ts`）：读 `HOB_LOCAL_PI_DIR/models.json` 和 `auth.json`。
  - `models.json` 的 `providers.<id>` → 兼容接口：回显示名用 id；模型里 `id / name / input / reasoning / contextWindow / maxTokens` 映射成设置的字段，`thinkingLevelMap` 进 Hob 的自定义思考档（`settings.models.thinking[<ref>]`），其它字段（`compat`、`cost`、模型级 `api`…）原样进模型的 `extra`；服务商级的 `compat`、`headers`、`authHeader` 等进 `CustomProviderSettings.extra`，注册进引擎时原样透传（模型级同名字段优先，和引擎的规则一致）。界面不编辑 extra。
  - Key：字面值直接用；值是环境变量引用（`$NAME` / `${NAME}`）时取变量值，变量不存在就不带 Key；`!` 开头的是命令，**不执行**，导入时不带 Key。
  - `auth.json` 里 `type: "api_key"` 的条目 → 内置服务商（引擎认识这个 id 才列出）；`oauth` 的列出来但不可选。
  - 同一 id 只列一次（models.json 先）；导入同 id 覆盖，Key 写进 `secrets.json` 的 `provider:<id>`，然后套进引擎。
- **Lore 连接**：读 `HOB_LOCAL_LORE_HOME/config.json` 的 `base_url` / `api_token`，写进 `HOB_HOME/system/lore/config.json`（和保存 Lore 连接同一条路径），来源文件不动。

## 图像生成

- 设置 → 图像生成二选一：**关闭** / **OpenAI 兼容接口**（服务地址、模型名、默认尺寸）。
- OpenAI 兼容接口的 Key 存 `HOB_HOME/system/secrets.json`（`imageApiKey`），0600、原子写，接口只报 `keyConfigured`，永不回显。
- 没配就没有图像生成能力：Worker 不注册 `generate_image`，提示词里写「不能做：图像生成」；配了且助手的「能力 → 图像生成」开着才注册。
- 生成：`server/src/image.ts` 的 `generateImage`。无参考图打 `POST {baseUrl}/images/generations`（JSON），有参考图打 `POST {baseUrl}/images/edits`（multipart 的 `image` 字段）。返回 `b64_json` 或 `url` 都支持，统一按 MIME 落成 png/jpg/webp/gif。
- 失败给具体原因：连不上（地址不通）、Key 被拒（401/403 带接口原话）、404 提示检查 /v1 和模型名、超时。
- 对话工具 `generate_image(prompt, size?, refs?)`：满足同一门槛时注册，开始即发出生成中图片条目，图片存在 `HOB_HOME/assistants/<助手id>/files/images`，完成或失败以相同 id 追加状态更新并推送；重启时仍在生成的条目标为中断。成功后图片已在对话显示，返回路径可供改图参考。
- 任务工具 `generate_image(prompt, size?, refs?)`：图片存任务工作目录，返回绝对路径；任务要以 `report` 的 `files` 交回才会显示。
- 图片进对话：任务的 `report.files` 先交给助手，由助手决定是否用 `send_file` 发到对话；前端渲染成内联缩略图（最大宽 320、圆角），点开全屏。`GET /api/files` 按扩展名给 content-type。

## 云桌面

可选的 desktopd v2 是独立容器，通过地址和 Bearer 令牌连接。每个助手按 `desktopProfile(assistantId)` 使用独立屏幕和浏览器，公共屏幕固定为 `public`，助手 id 与其冲突时映射成稳定哈希。屏幕按需启动，空闲回收后保留浏览器数据；有观看者或 CDP 连接时不回收。各任务在所属屏幕的浏览器中各开一个标签页，结束时断开连接而不关闭标签页。助手对话也可直接使用浏览器工具，共用所属屏幕和登录状态；任务已连接某屏幕时，助手操作该屏幕会提示等待任务或用 reply_job 沟通，任务不检查助手连接。助手会话释放时断开自己的连接。

设置中的 `desktop.publicAssistants` 默认空，只有选中的助手有 `screen: own | public` 工具参数；公共屏幕由第一个使用它的任务持有至任务结束，其余任务排队最多 10 分钟。接管状态按屏幕隔离。Hob 监听 desktopd 的 `/api/events`，断线时清空快照并退避重连，屏幕变化经 Hob SSE 推送；`GET /api/desktop/screens` 提供快照及助手到屏幕的映射，`POST /api/desktop/screens/:id/start` 只允许已存在助手的屏幕和公共屏幕。VNC 经登录保护的 `/api/desktop/vnc?screen=…&client=…` 代理；只看时过滤键鼠输入。

右栏仅在当前助手的屏幕运行时显示桌面小屏，否则显示任务命令行。桌面视图可切换助手屏幕及公共屏幕，选择未启动的屏幕会先启动。网站登录由用户自己完成；Google 目前会拒绝开启远程调试的浏览器登录。

浏览器和桌面截图保存为 PNG：助手保存在 `HOB_HOME/assistants/<助手id>/files/screenshots/`，任务保存在 `HOB_HOME/assistants/<助手id>/jobs/<任务id>/work/screenshots/`，每个目录最多保留最近 20 张。

桌面文字输入：接管者的输入法提交和粘贴走 `POST /api/desktop/paste`，Hob 校验当前屏幕的接管者后转给 desktopd；desktopd 用 xclip 写入并读回确认 X 剪贴板，再发送 Ctrl+V，同屏提交串行。单次文本上限 512KB，提交会改变远端剪贴板；普通短 ASCII 和控制键仍走 RFB。

## 设置（settings.json / secrets.json）

- 界面能改的东西都在 `HOB_HOME/system/settings.json`：`{ revision, settings: { general, providers, models, image, work } }`。
  - `general`：`theme`（system / light / dark）、`timezone`（默认系统时区）、`aboutYou`（称呼、语言、其他说明）。
  - `models`：`roster`（能用哪些模型 + 每句定位 + 默认思考档）、`conversation` / `work` 两个角色、`thinking`（每个模型的自定义思考档，键是 `"服务商/模型"`；没存就用默认规则，见“思考档”）。
  - `providers`：`ProviderSettings[]`，只有 `kind: "builtin"`（引擎自带服务商，只填 Key）和 `kind: "custom"`（兼容接口：`id` slug、`name`、`api`、`baseUrl`、`models[]`，每个模型可带 `extra` 原样透传给引擎）。Key 在 `secrets.json` 的 `provider:<id>`，接口只给 `keyConfigured`。写入走 `PUT /api/providers/:id`。
  - `search`：联网搜索服务商顺序、开关和服务地址，密钥手动填写并存入 `secrets.json` 的 `search:<name>`。搜索与抓取工具对 Router 和 Worker 可用。
  - `image`：`{ source: "off" }` / `{ source: "openai", baseUrl, model, size? }`，写入走 `PUT /api/image`。
  - `work`：`maxJobs`（1–8）、`jobStallMinutes`、`routerStallMinutes`。
- 全局规则独立存在 `HOB_HOME/rules.json`，`GET /api/rules` 读取，`PUT /api/rules` 整表保存并推送 `rules` 事件；`ask` 表示执行前确认，`allow` 表示一律照做。
- `GET /api/settings` 返回整份（带 revision）；`PUT /api/settings {revision, patch}` 按节合并，revision 不是当前的 → 409，前端重新拉取并提示。
- 改完即生效：时区影响提示词里的“现在时间”和定时调度，并发和卡住判定下一轮/下一次检查就用新值。
- `aboutYou` 进了所有助手的系统提示词（“关于用户”一节：填了哪行出哪行，全空就不出）。
- 密码：`config.json` 只存 scrypt 哈希（带盐）；首次启动时把明文 `password` 或 `HOB_PASSWORD` 转成哈希写回。`POST /api/password {old, new}` 旧的不对 → 403。
- 密钥（服务商 Key、图像生成 Key）存 `HOB_HOME/system/secrets.json`，0600、原子写，接口只写不读回。

## 思考档

思考档（off / minimal / low / medium / high / xhigh / max，界面上是关闭 / 最低 / 低 / 中 / 高 / 很高 / 最高）也是 Hob 自己管的：**只看 Hob 设置，不跟本机 pi 的配置挂钩，引擎模型注册表里自带的 `thinkingLevelMap` 也不用**。本机那份只在「从本机导入」时复制一次进来。

- 规则写在 `shared/thinking.ts` 一处（前后端和演示模式共用）：
  - 默认范围：会推理的模型 off … max；模型 id 含 `gpt`（不分大小写）的只到 xhigh；不推理的只有 off。
  - 默认字符：不填。引擎自己会按各协议的默认值翻译（off 不写才不会发出非法的 `reasoning_effort`，Anthropic 的 minimal 也能翻成 low）。
  - `xhigh` / `max` 是引擎默认不开的两档，要开就得写个值：一般写档名；Google 那套只有 low / medium / high，写档名会被引擎当成不认识的档而抛错，所以写 `high`。
  - 存了自定义档位就按自定义：开了的档（字符可以留空）+ 删掉的档（`null`）；没写到的键按默认范围算。
- 存的位置：`HOB_HOME/system/settings.json` 的 `settings.models.thinking`，键是模型 ref（`"服务商/模型"`），值是档位 → 字符：字符串 = 用户指定的字符，空串 = 开着但按服务商协议默认，`null` = 这一档不要；没这个键就是默认规则。导入时只把本机写明的键原样复制过来，之后和本机无关。
- 写给引擎（`ProviderService.applyTo`）：**稀疏的 `thinkingLevelMap`**，只放需要的键——用户自己填的字符、要开的 `xhigh` / `max`、删掉的档写 `null`。没改过的 off、minimal…high 一律不写（写了引擎就原样发出去，那正是各协议值不一样的坑）。兼容接口进模型的 `thinkingLevelMap`（`engineModels`）；内置服务商写进 `HOB_HOME/system/engine/models.json` 的 `providers.<id>.modelOverrides.<模型 id>.thinkingLevelMap`，写完 `refresh()` 一次引擎配置。
- 一律不拒、只往下收：设置保存和 `start_job` 都只校验档位本身合法（7 个标准档之一）；某个模型没这一档时，默认档和显式填的档都按 `fitThinking` 往下取最近的一档，任务详情显示实际用的档。
- 只能启用/删掉这 7 个标准档，不能造第 8 个档（引擎只认这 7 个）。`off` 可以改字符但不能删。删掉的档不用管协议：不写就是关（xhigh / max 本来就不写就等于关）。
- 编辑：设置 → 服务商 → 服务商详情 → 模型 → 思考档（推理模型才有这一节）。字符去首尾空白、最长 40 字；留空就是服务商协议自己的默认，不合法 400 并说清哪一档。存完 `ModelCatalog.reset()`，下一轮对话 / 下一个任务就用新的档。

## 消耗

不另外记账，直接从会话文件里的 assistant 消息统计（每条 assistant 消息算一次请求，带 `provider`、`model`、`timestamp` 和 `usage` 的 input / output / cacheRead / cacheWrite）：助手自己的对话（`router.jsonl`，含 `archive/assistants/` 里的）算「对话」，任务会话（`worker.jsonl`，按 `job.json` 归到所属助手）算「任务」。花费是按 token 数和单价自己算的，不用会话里的 `usage.cost`（自定义服务商那里都是 0）。

- 统计（`server/src/usage.ts`）：每个会话文件按大小和修改时间缓存；文件变长时只读追加的那一段，规则是会话文件只往后写。第一次扫描是异步流式读，不把几百 MB 的 jobs 目录塞进一次同步读里，服务照常响应。按设置时区把时间戳归到哪一天。
- 价格（`server/src/usage-prices.ts`）：默认单价从 `https://models.dev/api.json` 拉（美元 / 百万 token，四项），存 `HOB_HOME/cache/usage-prices.json`，一天最多更新一次；拉不到就留上次的并在页面写清原因，失败后 10 分钟内不重试（不然每次打开页面都要等一次超时）。服务商 id 是用户自己起的，所以按模型 id 匹配：先找完全一样的，多个服务商都有时优先模型厂商自己那家（`canonical_model_id` 指回自己，或在厂商名单里），再取第一个。匹配不上的记「未定价」，花费不计。
- 自定价格存在 `settings.json` 的 `settings.usage.prices`（键是模型 id），`PUT /api/usage/price` 写一个模型（`price: null` 恢复默认）。用订阅的服务商（如 Claude Code）按 models.dev 的价格算出来是等价的接口价，页面说明里写了以服务商账单为准。

## 对话富文本
对话和任务详情的 Markdown 使用 marked；公式按需动态加载 KaTeX（含本地 CSS 和字体，关闭 trust），代码块支持单独复制。音频在浏览器内解码生成波形，无法解码时显示进度条；视频使用浏览器原生播放器。

## HTTP / 实时

- 登录：`POST /api/login {password}` → HttpOnly cookie（签名随机 token，存内存 + `config.json` 里的 secret）。其余 `/api/*` 都要 cookie。
- REST（详见 `shared/types.ts` 的 `Api` 注释）：
  - `GET /api/bootstrap` → 助手列表（带最后一句、未读、是否在忙）、在跑和最近的任务、定时、未答审批、设置（带 revision）
  - `GET /api/settings` / `PUT /api/settings {revision, patch}` → 读 / 按节合并写设置
  - `GET /api/providers` → 已配的服务商、引擎自带的服务商目录、整份设置，以及每个已配置服务商的模型和思考档（`models`，键是服务商 id；内置服务商列出引擎目录里的全部模型）；`POST /api/providers/test` 测试连接（内置服务商发起少量模型调用，兼容接口访问模型列表，失败不保存配置）
  - `PUT /api/models/thinking {ref, levels}` → 存一个模型的自定义思考档（`null` = 恢复默认），返回新 revision 的整份设置和这个模型现在的思考档、`PUT /api/providers/:id`（新建或改，Key 可选留空沿用）、`DELETE /api/providers/:id`、`POST /api/providers/discover {api, baseUrl, apiKey?, id?}`（从兼容接口拉模型列表）、`GET /api/providers/import`（本机能导入的服务商，不带 Key）、`POST /api/providers/import {ids}`（导入所选，同 id 覆盖）
  - `GET /api/models`（可用模型 + 名单里哪些不可用）
  - `GET /api/usage`、`PUT /api/usage/price {revision, model, price}`（消耗，见下文“消耗”）
  - `POST /api/password {old, new}`、`GET /api/about`（版本、数据目录）
  - `GET /api/assistants/:id/items?before&limit` → 条目 + 引用到的 approvals/jobs/drafts
  - `GET /api/assistants/:id/profile` → 助手 + rules + routines + 最近工作日志
  - `POST /api/assistants/:id/messages {text, quote?, files?}`、`POST /api/assistants/:id/stop`、`POST /api/assistants/:id/read`
  - `GET /api/groups`（群和话题，话题带 `parentId` 和 `todos`）、`POST /api/groups {name, purpose, ownerId, members}`、`PATCH /api/groups/:id`（群忽略旧 `workflow` 字段，话题只能改名）、`POST /api/groups/:id/archive`（群按组归，话题用关闭）、`POST /api/groups/:gid/topics {title}`（开话题）、`POST /api/groups/:tid/close {note?}`、`POST /api/groups/:tid/reopen`
  - `GET /api/groups/:id/items?before&limit` → 群条目 + 引用到的 approvals/jobs；`POST /api/groups/:id/messages`、`POST /api/groups/:id/read`、`POST /api/groups/:id/stop`（停群里正在说话的成员，不停任务）
  - `PATCH /api/assistants/:id`（助手设置或 `{ rule: { id?, text?, mode? } }` 保存规则；不传 id 时必须提供文字和模式并新增，返回规则）、`DELETE /api/assistants/:id/rules/:rid`、`POST /api/assistants/:id/archive`（归档助手，见上文）
  - `GET /api/memory`、`PUT /api/memory {revision, provider}`、`PUT /api/memory/lore {baseUrl, token?}`、`POST /api/memory/lore-test`（记忆提供者与 Lore 连接，见上文“记忆”）、`GET /api/memory/lore/import`（本机的 Lore 连接，不带 Token）、`POST /api/memory/lore/import`（导进 Hob 自己的配置）
  - `GET /api/image`（Key 配没配）、`PUT /api/image {revision, image, apiKey?}`（Key 只写不读，留空 = 沿用）、`POST /api/image/test {image?, apiKey?}`（试一张，失败也是 200，原因在 `error` 里）
  - `GET /api/push`（publicKey + 已订阅设备）、`POST /api/push/subscribe {subscription, label}`、`DELETE /api/push/subscribe {endpoint}`、`POST /api/push/test {endpoint?}`（推送，见下文“PWA 与推送”）
  - `POST /api/visibility {clientId, visible}`（页面在不在前台，只存内存；SSE 断开即视为不可见）
  - `POST /api/delegations/:id/retry`（重新转交已中断的委派）
  - `POST /api/approvals/:id {key}` 或 `{text}`（用户没选选项、自己写的一段，空白和超长都是 400）、`POST /api/drafts/:id/create`、`POST /api/drafts/:id/dismiss`
  - `POST /api/routines`、`PATCH /api/routines/:id`、`DELETE /api/routines/:id`、`POST /api/routines/:id/run`
  - `POST /api/jobs/:id/reply {text}`、`POST /api/jobs/:id/stop`
  - `GET /api/jobs?assistantId&status&before&limit` → 工作记录：全部任务，新的在前，分页
  - `GET /api/jobs/:id/transcript` → 任务过程（步骤列表，从 `worker.jsonl` 推导；单步输出超 20KB 时截断并给出全文路径）
  - `POST /api/uploads?assistantId=`（multipart，存进这个助手的 `files/uploads/`，没传或助手不存在就 400/404）；`POST /api/uploads?groupId=` 存进 `groups/<gid>/files/uploads/`；`GET /api/files?path=`（数据目录里除 `system/` 和 `backup-*` 以外的文件，以及任务工作目录里的文件；符号链接解不开的不给，`.bak`、密钥类文件不给）
- 实时：`GET /api/events`（SSE）。`page-live` 推送对话页面的完整草稿及完成或失败状态；进行中的草稿在内存中，可从对话条目接口恢复。`router-activity` 推送助手对话的思考 / 工具状态和中文标签（思考中的标签是模型当前思考的最后一段，压成一行，节流约 200ms；不进对话记录），文字开始输出、停止或结束时清空；当前状态只存内存，并随助手概要返回供刷新和重连恢复。Worker 的 `activity` 仍是独立的任务活动流。事件类型见 `HobEvent`。前端断线重连后重新拉 bootstrap 和当前对话（EventSource 自带重连）。连接上带 `clientId`，断开时服务端把这台客户端的可见性一起清掉。

## 国际化

- 界面语言保存在 `settings.json` 的 `general.locale`，取值为 `zh-CN` 或 `en`。旧安装已有默认内容时启动补成 `zh-CN`；新安装在登录页按 `localStorage`、浏览器首选语言和登录页切换确定语言，登录后第一次 bootstrap 写入设置，服务端这时才建默认规则、Hob 的职责和敏捷团队。服务端的 `t()` 跟着设置里的语言（启动时和每次改设置时设置）。前端同时保存 `hob.locale`，并同步 `<html lang>`。
- 默认规则、主助手职责和敏捷团队只在语言第一次确定后创建，使用当时的语言；之后切换语言不会改写这些用户数据。老安装已有内容保持原样。
- 翻译使用共享的 `shared/i18n.ts`：中文原文作为键，`t()` 在渲染或调用时执行，英文缺词条时回退中文。英文词条分文件：共用的在 `shared/i18n-en.ts`，前端各区域在 `web/src/i18n/en/`，服务端在 `server/src/i18n/en/`，各自的 `index.ts` 用 `addEnglish()` 并进总表；完整性测试检查词条、可见中文和待翻译名单。日期、时间和 cron 文本按当前语言格式化。

## PWA 与推送

- 可安装：`web/public/manifest.webmanifest`（Hob，standalone）+ `web/public/icons/` 的图标（192 / 512 any、512 maskable、apple-touch-icon 180、favicon 32）。图标由 `node scripts/make-icons.mjs` 把 hob 像素火苗截图生成，出图提交进仓库。
- Service worker（`web/public/sw.js`，手写，无依赖）：导航 network-first（断网回退缓存的 index.html），`/assets/*`、`/icons/*`、`/fonts/*` cache-first，`/api/*` 一律不拦不缓存。只在生产构建里注册（`web/src/pwa.ts`）。新版本装好不自动接管，页面提示「有新版本 · 刷新」，点了才 `skipWaiting`。
- iOS：`env(safe-area-inset-*)` 给列表页、对话页输入框、全屏页头部留出安全区。
- Web Push：`web-push`，VAPID 密钥首次用时生成，和订阅一起存 `HOB_HOME/system/push.json`（0600、原子写）；subject 是 `mailto:` + 设置 → 通知里填的邮箱，没填用 Hob 的项目主页（Apple 不认 `mailto:…@localhost`）。推送在出审批（该助手开了“需要我拍板时通知我”）和任务卡住/失败时发出，标题是助手名，点开跳 `/?a=<助手id>`；群里提的问题和群里开的任务跳群聊页 `/#/group/<gid>`。只要有一个可见的页面客户端就不推；推送服务回 404/410 或 Apple 的 `VapidPkHashMismatch`（订阅用的是旧密钥）的订阅自动删掉，其他失败写日志，「发送测试通知」如实显示原因；页面开推送时浏览器里现有订阅的公钥对不上，先退掉再重订。页面里不再用浏览器 `Notification` 提醒。

## 前端

- 照 `docs/design/v2/index.html` 做（那是唯一的视觉真相源：CSS 变量、尺寸、组件都直接搬）。截图 `s1~s6.png` 是验收对照。
- 头像：都是 Hob 的像素小火苗，换一种颜色、带一件职责道具（安全帽、放大镜、Wi-Fi…），数据和画法在 `shared/sprites.ts`，前端画成 SVG。sprite 记成「道具」或「道具:颜色」；库里没有贴合职责的道具时，AI 可以自己画一件：sprite 记成 `custom` 或 `custom:颜色`，画法存在 `Assistant.prop`（`{ art, pal, dx }`，格式和 PROPS 里的一项相同；校验在 `shared/sprites.ts` 的 `validateCustomProp`，前后端共用，最多 16 行 × 16 字符、最多 6 种颜色、不能动火苗的 o y e 和描边 k、不能盖住眼睛、至少 6 个像素），草稿同样能带一份；自画道具在头像选择器里排第一个，换成内置道具后画法保留、能换回来；建助手时模型按职责挑道具（道具表同时生成提示词里的那行说明），和已有助手撞了就自动换颜色（自画的图案各不相同，不算撞）；助手设置里可以换道具和颜色。
- 桌面三栏：左栏助手（置顶大头像可按住拖动换位置，先后存助手的 pinOrder，下面是分组列表、收起的助手、底部设置）、中间对话、右栏（正在做 + 定时 / 定时编辑 / 助手设置，可收起）。设置是整页：桌面左侧分栏导航 + 右侧内容，手机先列表再进入。
- 设置页：通用、服务商、模型、记忆、图像生成、联网搜索、技能、MCP、任务、消耗、通知、关于都是真页面。
- 手机（宽 < 768px）：列表页（顶部在跑的任务行 + 助手）和对话页两级。
- 浅色为主，深色按系统或设置切换（index.html 里的 `.dark` 变量）。
- 不用 UI 组件库、不用 CSS 框架；React + 手写 CSS。

## 不做（v1）

多用户、事件型触发（邮件/Webhook）、表情回应、助手之间群聊、终端命令硬拦截（审批靠规矩 + ask_user）。
