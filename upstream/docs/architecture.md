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
3. **结果完整交回。** 事件带前 3,000 字和全文路径；Router 上下文有预算，工具大结果落盘，约 10 万 token 时压缩。
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
  archive/assistants/<id>-<时间>/  归档的助手：整个目录原样移到这里（档案、规则、对话、定时、审批、任务、文件都跟着走）
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

- **Assistant（助手）**：主助手 `id = "hob"` 唯一内置，首次启动自动创建；其余都是用户数据，不写死任何角色。`duty` 是职责简介，`dutyLong` 是详细职责；创建助手时从草稿复制，旧助手启动时从对应的已创建草稿幂等回填。长期记忆不属于某个助手（见下文“记忆”），助手需要知道的专属事实写在 `instructions`（补充说明）里。
- **Item（对话条目）**：对话 = 有序的 Item 列表。用户消息、助手回复从 pi 会话的消息得出；卡片类（question / job / draft / note / file）用 pi 的自定义条目 `customType: "hob.item"` 存在同一个 `router.jsonl` 里，**不进模型上下文**。卡片的可变状态（审批是否已选、任务进度、草稿是否已建）在 approvals.json / jobs / drafts.json 里，条目只存 id 引用，渲染时合并。
- **Job（任务）**：一次隔离执行 = Hob 进程里的一个 Worker pi 会话（`cwd` 给了就在那个目录干，不给就用 `HOB_HOME/assistants/<助手id>/jobs/<id>/work`）。任务记录带干活用的 `model` / `thinking`、`usage`（token 和花费）、`durationMs`；过程从 `worker.jsonl` 推导成 JobStep 列表（`server/src/transcript.ts`），实时动作走 `job_step` 事件。`assistantName` 记下建任务时的助手名，助手归档后任务详情照样显示。结束的任务可以接着做（续做）：上一轮结束时的状态、原因、用时存进 `rounds`，对话里再放一张带 `round`（第几轮）的任务卡；前面几张卡按 `rounds` 显示那一轮的结果、不带按钮，只有最后一张跟着任务实时变。
- **Approval（审批）**：选择题卡片。来源可以是 Router（不阻塞，答案作为下一条用户消息回到 Router）或旧数据中的 Worker 提问（新任务只向助手提问，不生成用户审批卡）。带 `always` 的选项（"以后这类直接…"）选中后自动写一条 `mode: "allow"` 的 Rule，并在对话里出一行"已记进 X 的规矩 · …"。审批仍属于提问的助手；转交回合中助手提出的审批，也在主助手的委派卡内展示同一条审批，两处调用同一答复接口。
- **Routine（定时）**：cron 表达式（`croner` 库）。到点 = 为所属助手开一个 local Job，结果作为带"⏱ 名字"标签的助手消息回到对话。运行记录 = 该定时产生的 Job 列表。
- **Draft（新助手草稿）**：Hob 提议分出助手时生成。点"创建"才真正建助手，并把草稿里的补充说明写进新助手的 `instructions`、在新助手对话开头写一行"X月X日 从 Hob 分出 · 带走 N 段对话"。

## 归档助手

助手可以收起，也可以归档（`POST /api/assistants/:id/archive`）。归档不往主助手转任何东西。

- 拒绝：主助手（"主助手不能归档"）、助手不存在、这个助手还有进行中 / 排队 / 等待确认的任务（"请等任务结束后再归档"）。
- 这个助手还没答复的审批记为 `expired`，卡片不再挂着。
- 整个助手目录（档案、规则、对话、技能、审批、定时、任务、上传和生图）用同盘 rename 移进 `HOB_HOME/archive/assistants/<id>-<时间>/`，不复制、不删除，任务和文件都跟着助手走；它的定时先停掉并从还在的助手的列表里拿掉（推 `routine_removed`），定义还留在归档目录里。`Job.assistantName` 补上当时的助手名，任务详情里不会因为助手不在了而报错。
- 然后推 `assistant_removed`：前端从列表移除，正看着它的切到主助手，草稿卡里指向它的"已创建 · 查看"变成"已归档"且不能再点。

## Router（对话层）

每个助手一个常驻的 pi 会话（懒加载，空闲 30 分钟释放内存，下次用再从 `router.jsonl` 打开）。

- 系统提示词：身份和回复规格、可用及未开的能力、事件信任边界、用户信息、全局规则和助手规则、补充说明、记忆、定时及其他助手名单（仅 Hob）。每次开新一轮前重建，全局规则列在助手规则之前。
- 模型：设置 → 模型里的对话模型（没选就没有，回复时出一条说明提示去配服务商）。
- 工具（全部是 Hob 自定义工具，无 pi 内置工具）：

| 工具 | 作用 |
|---|---|
| `start_job(title, note?, cwd?, skills?, expect_minutes?)` | 开任务，立即返回 jobId；对话里出任务卡片。`cwd` 指定工作目录；`skills` 指定交给任务的本助手启用技能 |
| `check_job(jobId)` | 查看任务状态、过程、结果和所用技能；主助手可看所有任务，其他助手只看自己的 |
| `edit_skill(name, edits)` | 替换本助手技能的正文，保留旧版和附件 |
| `save_job_as_skill(jobId, into?, note?)` | 让已完成的原任务在自己的会话里新建或修补技能，进度和结果显示在原任务上 |
| `delete_skill(name, replaced_by?)` | 归档技能；检查任务和定时绑定，可将定时改绑到接替技能 |
| `reply_job(jobId, text)` / `stop_job(jobId)` | 给在跑的任务补话 / 停掉 |
| `ask_user(title, detail?, options[])` | 出选择题卡片（不阻塞）；options 最多 3 个，可标 `always` |
| `set_rule(text, mode)` / `remove_rule(ruleId)` | 改要先问你；对话里出"已记进 X 的规矩 · …" |
| `create_routine` / `update_routine` / `delete_routine` | 改定时；对话里出"新增定时 · 名字 · 时间" |
| `propose_assistant(..., facts)` | 仅 Hob：出新助手草稿卡，facts 写专属事实并存为补充说明（sprite 可填 custom + prop_art 自画一件道具） |
| `set_avatar(sprite, color?, prop_art?, assistant?)` | 换头像：内置道具/颜色，或 custom（+ prop_art 自画）；主助手可传 assistant 给其他助手换；成功后推 assistant 事件，对话里出一行「已换头像」 |
| `overview(sinceHours = 24)` | 仅 Hob：只读，各助手这段时间的工作日志、结束的任务、在跑的任务、未答审批（写早报/汇总用） |
| `message_assistant(assistantId, text)` | 仅 Hob：创建持久化委派卡并在目标对话显示「转自 Hob」，目标回合及关联任务结束后只向 Hob 回流一次结果，本轮结束 |
| `hand_back_to_hob(text, reason)` | 仅非主助手：不归自己职责的事交回 Hob；普通回合在双方对话中留下可互相定位的条目，转交回合则退回委派，本轮结束 |
| `send_file(path)` | 把任务产出的文件作为文件卡片发到对话 |
| `generate_image(prompt, size?, refs?)` | 配置图像生成且助手能力开启时可直接生图，结果自动显示在对话 |
| `show_page(title, summary, html)` | 助手写正文 HTML 片段，Hob 套上自带样式（亮暗跟随）和离线 CSP 存为单页，发页面卡后结束本轮；对话生成时通过实时事件展示草稿；通用设置可关闭 |
| `web_search(query, depth?, max?)` / `web_fetch(url, raw?)` | 已启用联网搜索时可直接搜索或读取网页，搜索服务商按设置的优先级使用 |

- 事件消息（任务结束、定时结果、别的助手回复、审批答案）以用户角色进入 Router 上下文，但前缀固定的标记 `[hob-event]`，**不渲染成用户气泡**。
- 对话按“同一次回复”分组：组内条目贴着，组间拉开。事件之后的第一条带 `lead`（由会话条目推导，实时推送的条目算法相同）；任务提问和文件先交给助手，助手决定如何呈现。
- 出卡片的工具（`start_job` / `ask_user` / `propose_assistant` / `message_assistant`）的工具结果带 `terminate: true`：pi 在一批工具结果全部 terminate 时停止本批之后的模型请求，所以出了卡片这一轮就结构上结束，模型不会再补一句“卡在上面了”。同一批里混了别的工具（如 `set_rule`）就不提前结束，这是 pi 的规则。
- Router 正在回复时你又发消息 → `steer`；Router 空闲时来事件 → 直接开新一轮；忙时来事件 → `followUp`。

## 委派给其他助手

- 助手之间是以 Hob 为中心的星形关系，不互相直接调用。Hob 提示词列出其他助手的职责简介、详细职责和需确认规则，供它选择目标。
- 委派记录存入 `delegations.json`。目标对话立即显示转来消息，目标忙时排队处理；仅转交回合创建的任务关联到委派。Router 审批记在委派记录上，Worker 提问先交给目标助手处理。
- 委派卡内的审批与目标对话引用同一审批，答复只提交一次。目标回合和所有关联任务结束且没有待答审批后，服务端同步写入 `reportedAt`，再向 Hob 推一次包含回复和任务报告的事件。转交回合调用 `hand_back_to_hob` 时委派标为 `returned`、记录退回原因，回流事件提醒 Hob 不要再转给同一个助手；不额外生成转来消息。重启时没有在跑任务的未完成委派标为已中断，可从卡片重新转交。

## Worker（任务层）

- 每个 local Job 一个独立 pi 会话，cwd 默认 `HOB_HOME/assistants/<助手id>/jobs/<jobId>/work`（启动时建好；`start_job` 显式给了 cwd 才用给的）。产出文件只能写在这个目录，读可以读任何地方；要给用户看的文件用 `report` 的 files 交回（落盘后 `/api/files` 能读）。
- 工具：任务没有展示页面工具，结果写成 report 的 Markdown，必要的产物文件放进 files，怎么展示给用户由助手决定；启用联网搜索时有 `web_search`、`web_fetch`；pi 内置 `read, bash, edit, write, grep, find, ls`（内置工具自带截断并把完整输出写进临时文件 = Spill），加 Hob 的 `report(outcome, summary, files?)`、`ask_user(title, detail?, options[])`（阻塞等助手回复，助手自行回答或询问用户后用 `reply_job` 回复）；主助手的任务（定时就是它）另有只读的 `overview(sinceHours = 24)`，用来写早报/汇总；配了图像生成且该助手开着图像生成时再加 `generate_image(prompt, size?, refs?)`（见下文“图像生成”）。
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
- 写成功：Router 调用 `memory_write` / `lore_create_node` / `lore_update_node` 成功后，对话里出一行「记忆已更新 · 写入内容第一行（服务端最多 80 个字符，前端按宽度省略）」。
- 老数据：启动时发现 `assistants/<id>/memories.json`，把每条作为一行追加进该助手的 `instructions`，然后删掉文件（一次性，不是兼容层）。

## 技能

任务可用的技能来自本助手技能目录、`HOB_HOME/skills`、Lore 插件发现的工作副本以及 `~/.agents/skills`。通用技能照常加载；本助手技能由派活时的 `skills` 指定，任务只加载所选的启用技能，续做沿用。定时任务绑定的技能随任务传入。对话层列出本助手启用技能的名称、标题、版本、更新时间、说明和路径，助手可读取技能并修改正文。引擎的默认技能目录与项目技能不加载。停用状态保存在设置中，不修改技能文件。设置页可从 pi、Claude Code、Codex 的本机技能目录复制到 Hob，限制大小并跳过越界链接；通用技能和 Lore 技能不由 Hob 删除。

任务完成后不自动沉淀；助手判断事情定下来后，可用 `save_job_as_skill` 让原任务回到自己的会话中写技能，也可从任务详情手动触发。`into` 指定修补的已有启用技能，`note` 交代反馈；新建不得重名。一轮内多次保存同一技能只记一版，定时任务尚未绑定技能时自动绑定。任务状态仍为已完成，沉淀状态保存在 Job，步骤通过 `job_step` 实时推送，结束向助手发送事件。技能删除前检查正在使用的任务与定时任务，归档并可改绑定时任务。

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
  - `POST /api/uploads?assistantId=`（multipart，存进这个助手的 `files/uploads/`，没传或助手不存在就 400/404）、`GET /api/files?path=`（数据目录里除 `system/` 和 `backup-*` 以外的文件，以及任务工作目录里的文件；符号链接解不开的不给，`.bak`、密钥类文件不给）
- 实时：`GET /api/events`（SSE）。`page-live` 推送对话页面的完整草稿及完成或失败状态；进行中的草稿在内存中，可从对话条目接口恢复。`router-activity` 推送助手对话的思考 / 工具状态和中文标签（思考中的标签是模型当前思考的最后一段，压成一行，节流约 200ms；不进对话记录），文字开始输出、停止或结束时清空；当前状态只存内存，并随助手概要返回供刷新和重连恢复。Worker 的 `activity` 仍是独立的任务活动流。事件类型见 `HobEvent`。前端断线重连后重新拉 bootstrap 和当前对话（EventSource 自带重连）。连接上带 `clientId`，断开时服务端把这台客户端的可见性一起清掉。

## PWA 与推送

- 可安装：`web/public/manifest.webmanifest`（Hob，standalone）+ `web/public/icons/` 的图标（192 / 512 any、512 maskable、apple-touch-icon 180、favicon 32）。图标由 `node scripts/make-icons.mjs` 把 hob 像素火苗截图生成，出图提交进仓库。
- Service worker（`web/public/sw.js`，手写，无依赖）：导航 network-first（断网回退缓存的 index.html），`/assets/*`、`/icons/*`、`/fonts/*` cache-first，`/api/*` 一律不拦不缓存。只在生产构建里注册（`web/src/pwa.ts`）。新版本装好不自动接管，页面提示「有新版本 · 刷新」，点了才 `skipWaiting`。
- iOS：`env(safe-area-inset-*)` 给列表页、对话页输入框、全屏页头部留出安全区。
- Web Push：`web-push`，VAPID 密钥首次用时生成，和订阅一起存 `HOB_HOME/system/push.json`（0600、原子写）；subject 是 `mailto:` + 设置 → 通知里填的邮箱，没填用 Hob 的项目主页（Apple 不认 `mailto:…@localhost`）。推送在出审批（该助手开了“需要我拍板时通知我”）和任务卡住/失败时发出，标题是助手名，点开跳 `/?a=<助手id>`。只要有一个可见的页面客户端就不推；推送服务回 404/410 或 Apple 的 `VapidPkHashMismatch`（订阅用的是旧密钥）的订阅自动删掉，其他失败写日志，「发送测试通知」如实显示原因；页面开推送时浏览器里现有订阅的公钥对不上，先退掉再重订。页面里不再用浏览器 `Notification` 提醒。

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
