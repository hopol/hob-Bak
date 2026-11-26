# Hob 架构（v1，2026-10-31 定）

Hob 是常驻助手。你只跟助手说话；几步就能完成的事助手自己做，复杂或耗时的活交给后台任务，干完明说结果，只在要你拍板时才来找你。

## 两个来源合在一起

| 来源 | 拿来的东西 |
|---|---|
| Grok Bot | 助手 = 名字 + 职责 + **一条连续对话** + 自己的记忆和工作日志 + 定时任务；主助手（Hob）负责协调；审批在对话里做选择题；只在要批准时找你 |
| DeepSeek《Super-agent 设计探索》 | **Router 常驻只分派，Worker 隔离执行**；事件驱动（活干完推事件，不轮询对话）；Inline & Spill（大输出落盘，只把摘要带回对话）；Watchdog（卡住、崩溃、不汇报都要变成可见状态）；实验结论：只靠提示词让单会话去委派，5 次里 0 次委派，所以**委派必须是结构上的，不能靠提示词** |
| 其他常驻助手的教训 | 委派太绕；一轮结束就报"完成"；活在别处看不见；助手亲自干活把上下文撑爆（387MB 会话） |

由此得出 v1 的四条硬规则：

1. **助手对用户负责，任务对一件活负责。** 助手能执行命令、读取和修改文件，几步就能做完的事自己做；需要摸索、步骤多或耗时的事交给任务。技能归助手，助手能读技能、改正文。定位见 [助手和任务的定位](../.scratch/v2/design-assistant-and-task.md)。
2. **任务必须明说结果。** 任务会话（Worker）结束前必须调用 `report(outcome, summary)`，outcome ∈ 完成 / 卡住 / 等你批。一轮跑完没调用 = 系统追问一次，再不报就记为"卡住：没交代结果"。
3. **结果完整交回。** 事件带前 3,000 字和全文路径；Router 的工具大结果落盘，`read` 和 `show_assistant` 的结果保留全文（后者供助手完整查看说明）；压缩和任务一样，接近模型上下文上限时才压。
4. **任何时候都看得见。** 正在干的活在右栏“正在做”实时显示（读了什么、跑了什么），任务卡片点开能看完整过程。

提示词只写事实，见 AGENTS.md。

## 进程和底座

- 单个 Node 22 进程：`server/`（Hono + SSE）+ `web/`（Vite + React，构建后由 server 静态托管）。入口是 `server/src/boot.ts`。
- 底座是 pi SDK `@earendil-works/pi-coding-agent@1.5.2`（引擎），在进程内 `createAgentSession`。界面、提示词、错误信息里不出现 pi：用户不需要知道它。
  - 服务商和凭据全归 Hob 自己管：引擎目录是 `HOB_HOME/system/engine`（`authPath` 在这里，模型配置 `modelsPath` 是 `HOB_HOME/system/engine/models.json`），不读不写任何别的工具的配置。
  - Hob 为每个 Router 和 Worker 会话显式设置 `cacheWarming: "streaming"`。1.5.1 的默认值改为 `idle`，只对模型声明了 prompt cache 生命周期且预计节省达到阈值的请求生效；Hob 同时维护许多可独立空闲的会话，idle 会在两轮之间额外发刷新请求，因此保留升级前只在活动运行期间预热的行为。
  - 启动时和每次服务商变动，把设置里的服务商套进引擎：内置服务商 `setRuntimeApiKey` / `removeRuntimeApiKey`，兼容接口 `registerProvider` / `unregisterProvider`。
  - 思考档也按 Hob 自己的设置写给引擎（见下文“思考档”）：兼容接口写进模型的 `thinkingLevelMap`，内置服务商写进 `HOB_HOME/system/engine/models.json` 的 `providers.<id>.modelOverrides`，写完 `refresh()` 一次让引擎重读。
  - 会话文件一律放在 `HOB_HOME` 下（不放进引擎目录）。
  - 不加载用户装的扩展、主题；`AGENTS.md` 只在会话绑定了工作目录时读那个目录根上的一份（见下文“工作目录”）；技能只加载下文指定的来源。使用自定义 `ResourceLoader`（见 pi 示例 `examples/sdk/12-full-control.ts`）。工具由 Hob 自己给。

### 工作目录（`server/src/workspace.ts`）

非主助手、群、话题可以在创建时绑一个项目目录（`cwd`），之后不能改。在哪个会话里就用哪个会话的目录，全部经 `resolveWorkspaceCwd` 解析：

- 群和话题：群绑了，群和它所有话题都用群的，话题不能另绑；群没绑，话题用自己的；都没绑就是没绑定。成员助手自己的 `cwd` 在群里不生效。
- 单聊：用助手自己的 `cwd`。
- 没绑定：会话照旧在 `assistants/<id>/work`，任务在自己的目录。

绑定后：会话的命令和文件工具默认在这个目录；会话打开时读一次目录根上的 `AGENTS.md`（没有就读 `CLAUDE.md`，最多 32,000 字），整个会话不变，保住提示词缓存；系统提示词写明绑定目录和助手自己的目录；派出的任务不填 `cwd` 就落在绑定目录，填了只能是它里面的子目录（`jobs.start` 里检查，例如并行任务各用一份 worktree）。绑定目录不能是数据目录、它里面的目录或它的上级；目录后来失效，会话回落到默认目录并在提示词里说明。

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
    settings.json            界面可改的设置（主题、时区、网络代理、不走代理的地址、关于你、服务商、模型、并发、卡住判定、推送邮箱），带 revision，写入走 CAS
    secrets.json             密钥（0600，原子写），接口只写不读回：provider:<id>、imageApiKey
    push.json                Web Push：VAPID 密钥 + 订阅设备（0600，原子写）
    seeded.json              首次启动建过的内置内容（devTeam: true = 敏捷团队已建）
    engine/                  引擎目录：auth.json、models.json、bin（rg / fd）、资源；旧 mcp.json 迁移后保留为 mcp.json.bak
    plugins.json             已装插件、来源、开关、助手范围、工具开关和非敏感配置
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
  plugins/<id>/              已安装插件：plugin.json、mcp.json、图标和可选 skills/
  skills/                    全局技能（来源标签 hob）
  assistants/<id>/
    profile.json             Assistant（名字、职责、头像、置顶、通知…）
    instructions.archived.md  旧补充说明的存档（有内容时才有）
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
    work/                  助手自己的工作目录，跨轮保留
    files/
      uploads/  images/  pages/             输入框上传、对话生图、展示页面
  assistants/hob/drafts.json     Draft[]（新助手草稿，只有主助手会提议）
  assistants/hob/delegations.json Delegation[]（所有助手发起的委派记录，兼容旧数据）
  groups/<gid>/
    group.json                 Group（名字、负责什么、群主、成员）；话题的是另一个 groups/<tid>/，里面只放话题自己的字段
    instructions.archived.md  旧补充说明的存档（有内容时才有）
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

- **Assistant（助手）**：主助手 `id = "hob"` 唯一内置，首次启动自动创建；其余都是用户数据。首次启动另外带上「敏捷团队」：5 个收起的助手（产品负责人、架构师、开发、测试、发布）和一个默认群，只建一次，标记写在 `system/seeded.json`，用户删了、归档了都不补回来；这 5 个是 `hidden`（收起的助手），老用户已经占了同名 id（`po`、`dev`…）就换一个不冲突的，不覆盖原来的助手。`duty` 是职责简介，`dutyLong` 是详细职责；创建助手时从草稿复制，旧助手启动时从对应的已创建草稿幂等回填。长期记忆不属于某个助手（见下文“记忆”）。
- **助手的补充提示词**：`Assistant.instructions` 存在助手的 `profile.json`，用户通过资料面板或 PATCH 修改，主助手可用 `update_assistant` 修改任何助手，普通助手可修改自己；创建助手时草稿 `Draft.instructions` 原样带入。只去首尾空白，空字符串视为没有。原文紧接身份那几句、原样进入单聊、群和话题的系统提示词，不加标题和别的话；任务提示词也带所属助手的补充提示词；其他助手的名单不包含它。助手和草稿的补充提示词在重启时保留，旧群说明仍归档。
- **Item（对话条目）**：对话 = 有序的 Item 列表。用户消息、助手回复从 pi 会话的消息得出；卡片类（question / job / draft / note / file / card）用 pi 的自定义条目 `customType: "hob.item"` 存在同一个 `router.jsonl` 里，**不进模型上下文**。卡片的可变状态（审批是否已选、任务进度、草稿是否已建）在 approvals.json / jobs / drafts.json / cards.json 里，条目只存 id 引用，渲染时合并。老数据里还有 `todos` 条目（以前收起的一份待办），现在不再写入、界面也不显示。
- **卡片**：卡片正文是服务端校验过的声明式 JSON 子集，完整记录按助手或群写在 `cards.json`，时间线只保存 `{ kind: "card", cardId }`。主人有两种：助手卡记 `assistantId`，插件卡同时记插件、服务、回调工具和调起它的助手。助手卡允许展示或交互；交互卡操作后锁成 `done`，结果保存在卡片记录里，并以 `[hob-event]` 系统消息回到原助手。插件卡的表单值只在一次回调调用的内存参数里经过 Hob，卡片记录、时间线、会话文件、模型消息、SSE 和日志都不写这些值；插件可以返回新卡整卡替换、toast、字段错误或文字事件，插件不可用时卡片保留并禁用操作；插件更新到新版本时，它更新前出的、还没处理的卡作废并写明原因（卡片内容是出卡时旧版定下的，字段和回调可能已经变了）。模型后续历史只接收一行标题和摘要（没有摘要时用「表单 N 项」或「表格 N 行」），不接收卡片 JSON。Hob 在飞书子集上加的扩展字段：`input` 的 `min_length`、`generate`（密码框旁的「生成」按钮）；`select_static` 的 `display`（`dropdown` 画成下拉、`chips` 画成圆角小块，不写时选项少画小块、多了画下拉）；`div` 的 `icon`（`file` / `doc` 画成文件行，`check` 画成结果行：勾 + 灰字）。`column_set` 每栏按 `weight` 分宽度。插件卡的来源行用插件自己在 `plugin.json` 里声明的图标，取不到用通用的插件图标。
- **Job（任务）**：一次隔离执行 = Hob 进程里的一个 Worker pi 会话（`cwd` 给了就在那个目录干，不给就用 `HOB_HOME/assistants/<助手id>/jobs/<id>/work`）。任务记录带干活用的 `model` / `thinking`、`usage`（token 和花费）、`durationMs`；过程从 `worker.jsonl` 推导成 JobStep 列表（`server/src/transcript.ts`），实时动作走 `job_step` 事件。`assistantName` 记下建任务时的助手名，助手归档后任务详情照样显示。结束的任务可以接着做（续做）：上一轮结束时的状态、原因、用时存进 `rounds`，对话里再放一张带 `round`（第几轮）的任务卡。界面上同一个任务只显示最新一轮那张卡（`Items.tsx` 的 `visibleItems`），它跟着任务实时变；前几轮按 `rounds` 在任务详情里切换着看。
- **Approval（审批）**：选择题卡片。来源可以是 Router（不阻塞，答案作为下一条用户消息回到 Router）或旧数据中的 Worker 提问（新任务只向助手提问，不生成用户审批卡）。带 `always` 的选项（"以后这类直接…"）选中后自动写一条 `mode: "allow"` 的 Rule，并在对话里出一行"已记进 X 的规矩 · …"。审批仍属于提问的助手；转交回合中助手提出的审批，也在主助手的委派卡内展示同一条审批，两处调用同一答复接口。
- **Routine（定时）**：cron 表达式（`croner` 库）。单聊定时到点先给所属助手送一条事件，由助手自己答复或开 local Job；任务结果作为带「⏱ 名字」标签的助手消息回到对话。群定时由群主负责，到点在目标群或话题留下记录并交给群主处理，检查脚本的 notify 输出直接发送。群主变化时定时跟随变更。运行记录包括任务和交给群主、交给助手的记录。定时任务保存「要做的事」是谁写的（`instructionBy`：用户自己写的，还是哪个助手）；到点时用户自己写的直接标明，助手写的标明助手是谁写的。
- **Draft（新助手草稿）**：Hob 提议分出助手时生成。点"创建"才真正建助手，在新助手对话开头写一行"X月X日 由 Hob 创建"。

## 归档助手

助手可以收起，也可以归档（`POST /api/assistants/:id/archive`）。归档不往主助手转任何东西。

- 拒绝：主助手（"主助手不能归档"）、助手不存在、这个助手还有进行中 / 排队 / 等待确认的任务（"请等任务结束后再归档"）。
- 这个助手还没答复的审批记为 `expired`，卡片不再挂着。
- 整个助手目录（档案、规则、对话、技能、审批、定时、任务、上传和生图）用同盘 rename 移进 `HOB_HOME/archive/assistants/<id>-<时间>/`，不复制、不删除，任务和文件都跟着助手走；它的定时先停掉并从还在的助手的列表里拿掉（推 `routine_removed`），定义还留在归档目录里。`Job.assistantName` 补上当时的助手名，任务详情里不会因为助手不在了而报错。
- 然后推 `assistant_removed`：前端从列表移除，正看着它的切到主助手，草稿卡里指向它的"已创建 · 查看"变成"已归档"且不能再点。

## Router（对话层）

每个助手一个常驻的 pi 会话（懒加载，空闲 30 分钟释放内存，下次用再从 `router.jsonl` 打开）。

- 会话最后一轮结束满 6 小时、当前上下文超过 150,000 token，且这份会话没有正在回复的回合、进行中的任务、转交或待答问题时，Router 会调用引擎的 `session.compact()` 整理一次。6 小时和 150,000 是代码常量，不进入设置；正在做事的会话不因这条规则压缩，引擎原有的接近窗口上限的自动压缩仍照常工作。
- 每约 10 分钟检查一遍所有会话（单聊和各群成员的）。闲置满 6 小时的会话早已从内存释放，所以按会话文件找：文件 6 小时没动的打开检查一次，同一个版本的文件只查一次；一个一个整理。这样整理发生在闲置期间，不让用户隔天的第一句话等它。重启后头 10 分钟内来的消息或事件打开会话时也先检查再处理。整理期间新来的消息等整理完成后进入同一会话，失败只记日志并继续处理。
- `compact()` 只追加引擎的压缩条目，`router.jsonl` 和群成员会话里的原始条目仍完整保留；界面条目和分页接口继续从完整会话记录推导，所以整理不改变聊天记录。

- 系统提示词：身份和回复规格、可用及未开的能力、事件信任边界、用户信息、全局规则和助手规则、记忆、定时，以及其他助手和群（仅 Hob；群只列群主和成员，不列话题）。每次开新一轮前重建，全局规则列在助手规则之前。
- 模型：设置 → 模型里的对话模型（没选就没有，回复时出一条说明提示去配服务商）。
- 工具：Hob 自定义工具，以及引擎的 `read`、`bash`、`edit`、`write`。`read` 总是有，`bash` 受执行命令开关控制，`edit` / `write` 受修改文件开关控制；单聊和群会话都一样。相对路径以 `assistants/<id>/work/` 为准。

| 工具 | 作用 |
|---|---|
| `read` / `bash` / `edit` / `write` | 读取文件、执行命令、修改或写入文件；简单明确的事由助手自己做，复杂或耗时的事交给任务 |
| `start_job(title, note, files?, cwd?, expect_minutes?, after?)` | 开任务，立即返回 jobId；任务看到 `note` 和显式 `files` 的路径，对话里出任务卡片。`cwd` 指定工作目录，不能指定 Hob 数据目录；不填就用任务自己的目录。会话绑定了工作目录时，不填就用绑定目录，填的话只能是它里面的子目录。相对路径以助手工作目录为准；`after` 要等哪些任务做完 |
| `check_job(jobId)` | 查看任务状态、过程、结果和所用技能；主助手可看所有任务，其余助手只看自己的 |
| `update_todos(items)` | 列一份待办，整份替换：每项只有 `text` 和 `status`（todo / doing / done）。单聊存 `assistants/<id>/todos.json`，群的综合和话题存 `groups/<gid>/todos.json`；同一份清单谁后写以谁为准。每轮开头把当前这份带给模型；全做完、清掉、话题关了、手上没活了的就收起（见下文「待办」） |
| `review_job(jobId, note?)` | 让已结束的原任务在自己的会话里回顾，任务用 `save_skill` 保存需要的技能；进度和结果显示在原任务上 |
| `reply_job(jobId, text)` / `stop_job(jobId)` | 给在跑的任务补话 / 停掉 |
| `ask_user(title, detail?, options[]?, questions[])` | 出选择题卡片（不阻塞）；`options` 最多 3 个，可标 `always`；一张卡问几个问题用 `questions`（每个问题 2 到 3 个选项，可标推荐哪个），用户答完答案一起回来 |
| `set_rule(text, mode)` / `remove_rule(ruleId)` | 改要先问你；对话里出"已记进 X 的规矩 · …"。主助手多一个可选 `assistantId`，改那个助手的 |
| `create_routine` / `update_routine` / `delete_routine` | 改定时；对话里出"新增定时 · 名字 · 时间"。主助手多一个可选 `assistantId` |
| `create_assistant(...)` | 所有助手都能用：存草稿、落助手卡，然后立刻按草稿建好（卡片直接是「已创建」）；建失败把原因返回，草稿留着让用户在卡上点。助手管什么、不管什么写在 `dutyLong`（sprite 可填 custom + prop_art 自画一件道具） |
| `show_assistant(assistantId?, query?, page?)` | 所有助手都能用：不填 id 列出全部助手（含收起的、按左栏顺序），填了看完整资料以及这个助手和用户的单聊消息（只读；page 第 1 页是最近的 20 条） |
| `update_assistant(...)` | 主助手可改别的助手资料（名字、职责、详细职责、模型、知识库、置顶、收起、通知），不改能力；普通助手只有不带 assistantId 的自我修改工具，只能改自己的名字、职责和详细职责；和 `PATCH /api/assistants/:id` 共用 `updateAssistant()`。换头像不在这里，用 `set_avatar` |
| `show_group(groupId?, query?, page?)` | 所有助手都能用：不填 id 列出全部群（群主、成员、进行中的话题数），填了看群或话题的详情和消息，带 query 在消息里找。每页 20 条 |
| `create_group(name, purpose, members, ownerId)` | 所有助手都能用：创建群 |
| `update_group(groupId, ...)` / `manage_topic(action, groupId?, topicId?, title?, note?)` | 仅 Hob：改群、开关重命名群话题 |
| `save_skill(name, from?, edits?, general?, assistantId?)` / `delete_skill(name, replaced_by?, assistantId?)` | 助手和任务都用 `save_skill` 从工作目录整份保存技能或替换已有文本；`general` 换范围，主助手单聊可指定 `assistantId`。删除会检查正在使用的任务；`replaced_by` 指定接替的技能 |
| `set_avatar(sprite, color?, prop_art?, assistant?)` | 换头像：内置道具/颜色，或 custom（+ prop_art 自画）；主助手可传 assistant 给其他助手换；成功后推 assistant 事件，对话里出一行「已换头像」 |
| `overview(sinceHours = 24)` | 只读，各助手这段时间的工作日志、结束的任务、在跑的任务、未答审批（写早报/汇总用） |
| `message_assistant(assistantId, note, files?)` | 所有助手都能用：只把助手写的交接说明和显式文件交给另一个助手，创建持久化委派卡并在发起方对话显示转交记录，目标回合及关联任务结束后只向发起方回流一次结果，本轮结束；转交回合中不能再转交；普通助手不能转给主助手（主助手没法再往下转），要交给它用 `hand_back` |
| `message_group(groupId, title, note, files?)` | 所有助手都能用：只把助手写的交接说明和显式文件交给一个群，在群里开话题并由群主接手，结论回到发起方对话 |
| `open_topic(title? / topic?, note, files?)` | 群主在综合里开新话题或转到已有话题；只把助手写的交接说明和显式文件放进话题，本轮结束 |
| `hand_back(text, reason)` | 仅非主助手：别人转来的事交回发起方；用户直接找你的事交回 Hob，由它转给合适的助手；本轮结束 |
| `send_file(path)` | 把文件作为文件卡片发到对话；相对路径以助手工作目录为准。页面只读得到 Hob 自己的目录和任务工作目录，范围外的文件先复制到 `assistants/<id>/files/sent/` 再发；密钥类文件照样拒绝 |
| `generate_image(prompt, size?, refs?)` | 配置图像生成且助手能力开启时可直接生图，结果自动显示在对话 |
| `show_page(title, summary, html)` | 助手写正文 HTML 片段，Hob 套上自带样式（亮暗跟随）和离线 CSP 存为单页，发页面卡后结束本轮；对话生成时通过实时事件展示草稿；通用设置可关闭 |
| `web_search(query, depth?, max?)` / `web_fetch(url, raw?)` | 已启用联网搜索时可直接搜索或读取网页，搜索服务商按设置的优先级使用 |

- 事件消息（任务结束、定时结果、别的助手回复、审批答案）以用户角色进入 Router 上下文，但前缀固定的标记 `[hob-event]`，**不渲染成用户气泡**。
- 事件那一轮可以不说话：模型最后一段回 `NO_REPLY`（`shared/no-reply.ts`），这一轮写的字一段都不给用户看，卡片、文件、提示行照常。确认语和开场白多半写在调工具之前，所以事件那一轮的文字不边写边推，到这一轮结束、或者用户插话进来（模型读到用户消息）时才出；单聊刷新后由 `walk` 按同样的分界推导，群里由 `GroupManager.settleEventTurn` 写进时间线。什么时候回 `NO_REPLY` 由提示词讲、模型判断；这个词本身任何一轮都不显示。
- 对话按“同一次回复”分组：组内条目贴着，组间拉开。事件之后的第一条带 `lead`（由会话条目推导，实时推送的条目算法相同）；任务提问和文件先交给助手，助手决定如何呈现。
- 出卡片的工具（`start_job` / `ask_user` / `send_card` / `message_assistant` / `message_group`）的工具结果带 `terminate: true`：pi 在一批工具结果全部 terminate 时停止本批之后的模型请求，所以出了交互卡片这一轮就结构上结束，模型不会再补一句“卡在上面了”。展示卡片的 `send_card` 不结束本轮；同一批里混了别的工具（如 `set_rule`）就不提前结束，这是 pi 的规则。`create_assistant` 出的助手卡不结束本轮：建好之后还要说一句建了什么。
- 所有助手的单聊都有建助手、建群、查看助手、查看群、overview、转交助手和交给群的工具；主助手能管理其他助手、群和话题，普通助手只能用 update_assistant 改自己的名字、职责和详细职责。群会话工具名单保持现状。每次成功修改资料或群，按原有规则在对话和群里落提示。
- Router 正在回复时你又发消息 → `steer`；Router 空闲时来事件 → 直接开新一轮；忙时来事件 → 排在 Hob 自己的队列里，等这一轮结束再送（不交给引擎的 `followUp` 队列：那样正文在入队时就定死了）。
  - 事件的正文和「现在」那一块在真正送进会话时才生成。任务的事件（结果、提问、超时提醒）带任务的轮次：送的时候任务已经进了下一轮，就只说一句「第 N 轮的结果已经被第 N+1 轮取代，现在：……」；同一个任务排着好几条，只送最新一条。群会话同理，正文在那一轮开始时才取。
  - 排着的事件算这个会话在忙：完成通知、释放会话都等它们送完。点停止、看门狗叫停时先不送，停下来以后照常送；会话挂死被丢掉时，排着的事件换到重新打开的会话里送。
  - 任务收尾不等助手处理结果的那一轮跑完（事件发出去就继续收尾），否则助手在那一轮里 `reply_job` 同一个任务会和收尾互相等。

## 委派给其他助手

- 助手之间以发起方为中心记录委派关系：任何助手都能直接转给别的助手或群，委派结果回到发起方；转交记录存入 `assistants/hob/delegations.json`，旧数据里的 `from: "hob"` 照常读取。目标对话立即显示转来消息，目标忙时排队处理；仅转交回合创建的任务关联到委派。Router 审批记在委派记录上，Worker 提问先交给目标助手处理。
- 委派卡内的审批与目标对话引用同一审批，答复只提交一次。目标回合和所有关联任务结束且没有待答审批后，服务端同步写入 `reportedAt`，再向发起方推一次包含回复和任务报告的事件。转交回合调用 `hand_back` 时委派标为 `returned`、记录退回原因并回流发起方；不额外生成转来消息。用户直接找普通助手时，`hand_back` 把原话转给 Hob。重启时没有在跑任务的未完成委派标为已中断，可从卡片重新转交。

## 群

用户和几个助手在一个长期的地方一起做事（效果和定下来的规则见 `.scratch/v2/design-groups.md`），数据在 `HOB_HOME/groups/<gid>/`（见上文的数据目录）。

- **成员**：一个或几个助手，收起的助手也能进群。同一位助手可以在几个群里，记忆全局共用，助手有自己的技能和规则，群也有自己的技能和规则；各群的对话分开。建群和改群都不接受空成员。
- **话题和综合**：一个群里同时办几件事时，每件事开一个话题，各走各的。群自己的那条时间线叫「综合」，用户和群主都能在综合里开话题。
  - 话题就是挂在群下面的群：带 `parentId` 的 `Group`，存在 `groups/<tid>/`，id 也是 `g-` 开头。时间线、成员各自的会话（`aid@tid`）、轮到谁、任务和提问卡回到哪、已读、事件都复用群的机制。
  - 话题的成员、群主、负责什么只在所属的群上存一份：`groups/<tid>/group.json` 只有 `id`、`parentId`、`name`、`createdAt`、`createdBy`、`closedAt`、`closeNote`，读的时候补上所属群的字段，群改了话题跟着变。
  - 关了的话题不能再发消息，能重新打开；关闭时写的说明在话题卡上。群归档时话题一起搬进 `archive/groups/<gid>-<时间>/topics/`。话题不用归档，用关闭。
  - **主助手交来的话题**：Hob 用 `message_group` 在群里开话题交给群主，话题上记着 `handover`（谁交的、什么时候）。转进去的第一条是 Hob 写的交接说明和附带文件，`forwardedFrom` 记着它来自 Hob，界面上方标「从和 Hob 的对话转来」。Hob 交来的话题关的时候要写结论（`close_topic` 没写报错），关了会送一条系统消息回 Hob 的对话：写了结论的带结论，用户在界面上没写结论关的说明这一点。先记下要送的话再送，送到了才标已送，重启补送没送到的，同一话题只送一次。
- **待办（所有会话通用）**：每个会话（单聊、群的综合、每个话题）一份待办，`TodoItem { text, status }`，`status` 只有 `todo`、`doing`、`done`。存在单聊的 `assistants/<id>/todos.json` 和群（综合、话题）的 `groups/<gid>/todos.json`。待办只归助手，任务没有：交给后台任务的一步就是助手那份里的一项。只有模型调 `update_todos` 改，每次传完整的一份整份替换，同一份谁后写以谁为准；不跟任务状态联动、不自动开任务。
  - **每轮带给模型**：会话里有待办时，这一轮的用户消息里带上「手上的待办 k/n，多久以前更新」和每项做到哪儿（`now.ts`，跟【现在】走同一条路）；没有就不带。还有没做完的项、距上次更新已经好几轮时，后面再接一句「这份待办已经 n 轮没更新了……」；轮数从这个会话的记录里数（上次更新以后的用户消息条数），提醒过以后要再过 `TODO_REMINDER_ROUNDS` 轮才再说。系统提示词里没有这一段（它每轮一样，缓存才命中）。收起的待办不进上下文，所以聊多久也只有当前这一份。
  - **有头有尾**：当前这份遇到这几种情况就清空——传进来的每一项都是 `done`（工具返回「待办 n/n，都做完了，已经清掉。」）、传空列表而原来还有没做完的（「待办清掉了。」）、话题关了还有没做完的、手上没活了（见下一条）、用 `message_assistant` 把整件事转给别的助手而这份还有没做完的（「已经清掉」；没做完的那几项另写进发给接手的助手的内容里）。收起的那些**不再写进时间线、不进对话**：对话里只放用户需要看的东西，清单是助手自己的进度。`TodoArchiveWhy` 和 `kind: "todos"` 条目 只为读老数据保留，不再写入，界面不显示（`Items.tsx` 直接返回 `null`）。转交时没替接手的助手写它的 `todos.json`。老数据（只有清单的 `todos.json`）照常读成当前那份，更新时间取文件时间。
  - **手上没活就收起**：清单只在这一轮还有活的时候存在。查的时机是两个——每一轮结束时（`agent_settled`，用户那一轮、事件那一轮都算）和服务启动时（`main.ts` 里任务和转交都按中断处理过以后）；清空后用和 `update_todos` 清掉时同一条路告诉界面。这个会话里还有下面任意一样就留着：跑着、排着或等着的任务（`busyHere`，状态取 running / queued / waiting）；从这个会话发出、还没结束的转交（running 或 waiting）；交给群、话题还没关的（`message_group` 开出来的话题，关话题才有结论回来）；还在等用户回答的提问卡；群会话里别的成员还在这个会话里跑着一轮（`busyMembers`）。一轮因为调用模型失败结束时不清，留到下一轮；下一轮正常结束再按同样的规则查。逻辑在 `todos.ts` 的 `todosBusy` / `releaseIdleTodos` / `releaseIdleTodosAtStartup`。模型没把最后几项标成 done 也算手上没活：这一轮说完清单就收，下一件事重新列。不另起定时器，也没有按时间的兜底。
  - **界面只显示进度**：会话输入框上方一条（正在做的那项、`k/n`、细进度条，点开只读清单），左栏话题行一个 `k/n` 小标签。老数据里时间线那些 `kind: "todos"` 条目不再显示。以前的 `projects/` 老文件不读也不删，时间线里老的 `kind: "project"` 条目不显示。
- **话题的接口**：`GET /api/groups` 返回群和话题（话题带 `parentId`，状态由 `closedAt` 和待办推出）；`POST /api/groups/:gid/topics {title}` 开话题；`POST /api/groups/:tid/close {note?}` 关闭；`POST /api/groups/:tid/reopen` 重新打开；关闭后 `POST /api/groups/:tid/messages` 回 400。`POST /api/groups` 和 `PATCH /api/groups/:id` 忽略传入的旧 `workflow` 字段并保留文件原值，话题只能改名。
- **每个成员一份群会话**：会话键是 `<assistantId>@<gid>`（话题是 `@<tid>`），单聊还是 `assistantId`。文件分别落在 `groups/<gid>/members/<aid>.jsonl` 和 `assistants/<aid>/router.jsonl`，上下文互不搅扰。群会话的工具包括做事和沟通用的工具，以及管理本群规则、定时和技能的工具；主助手在群里还可管理助手、群和话题，改其他助手的规则、定时和技能在单聊里做。展示页面按助手存，进群要另做，先不给（`show_page`）。系统提示词把「一对一」那段换成群里的规矩，群主在综合里能开话题、多一段开话题的说明。话题会话在群那段后面接一句「这里是群「…」的话题「…」」，群名写所属的群。云桌面一个助手只有一个屏幕，单聊和它的群会话共用一个。
- **卡片和结果都留在群里**：`start_job`、`ask_user`、`send_card`、`send_file`、`generate_image` 的卡片进群的时间线（发言人是这个成员），任务卡、提问卡和助手卡带 `groupId`；插件卡也记录调起它的成员。任务结果、任务提问、超时提醒、沉淀结果作为事件送进派它的成员在这个群里的会话，由它在群里说，回复里 @ 了别人照常接力。审批答案和助手卡答案也回到群会话。群归档了、或者成员已经被移出，卡片和事件落回单聊，不报错。群里派的任务带的是这一轮的来由（见下面「交接」）。
- **谁说话由代码定**：用户的消息 @ 了谁、引用谁的消息，就轮到谁；都没有就轮到群主。成员的回复里 @ 了别的成员，接着轮到他们（被 @ 的本人不算）。没轮到的成员不调模型。同一成员同时被叫两次就排队；排到时它上次之后已经没有新条目（前面那一轮已经带上了要给的），这一轮就不跑、不调模型。一条用户消息引出的助手回合超过 20 个就停，时间线里留一行「群里接力太多次，先停在这里」，并给群主发一个事件。事件送进群会话时也算新的一串回合。
- **用户中途说话插进正在跑的那一轮**：轮到的成员在这个群里正说着（它的群会话在流式），新条目用 `steer` 插进那一轮，不另排一轮；会话刚好跑完（不在流式）就照原来的路子排队。事件那一轮的输入先列它还没见过的群条目、再写 `[hob-event]`，排队期间用户说的话这一轮就看得到。
- **一轮的输入**：这个群时间线里它上次说完以后的条目，按「名字：内容」一行行列出，最后是叫到它的那条；卡片写成一句事实。给到哪一条记在 `state.json` 的 `seen`（只调了工具没说话的回合也不重复给）。单聊那套转交接管和「过期待答提问」不跑（那是单聊的）。
- **交接**：一件事从一个会话交给下一个会话（定时 → 综合 → 话题 → 任务）时，带什么、归谁、给对方看什么，各只有一处定义：
  - **来由**：群里的时间线仍记录用户消息和定时到点记录，供群内轮转使用；交接工具不再从时间线或 Router 推测来由。定时到点记录的全文仍记在记录的 `request` 上，界面不显示。交接内容只来自调用工具时助手填写的 `note` 和显式传入的 `files`。
  - **出处**：任务和提问卡属于开它的会话（`groupId`，没有就是单聊），结果回到那里。给模型看的地方，不是这个会话开的都写明在哪（`origin.ts` 的 `sessionOrigin`：单聊、综合、话题「…」、群「…」）。每条消息前的【现在】只在「进行中」「等用户选」「最近结束」里列这个会话自己的，别处的另起「别处进行中」「别处等用户选」两行，范围和它管得了的任务一致（群和话题里是同一个群，单聊里是全部）。`check_job`、`reply_job`、`stop_job` 碰到别处开的任务，返回和停止原因里带出处。
  - **原样的事实**：给模型看的任务过程（`jobProcessLines`）用命令原文，不用界面的摘要（`commandSummary` 会删掉开头的 `cd`）。指定了 `cwd` 的任务，提示词里同时写指定的目录和任务自己的目录。
  - **交接时带什么**：每个交接工具都把助手写的交接说明和显式附件交给下一处，不自动附带用户消息、引用、最近对话或当前轮的附件。`note` 必填且不能为空，说明里按需写清：要办成什么、背景、用户的要求（引用用户原话）、先问用户的事。

    | 交接工具 | 说明 | 附件 |
    |---|---|---|
    | `start_job` | 必填 `note` | 只有 `files` 参数 |
    | `message_assistant` | 必填 `note` | 只有 `files` 参数 |
    | `message_group` | 必填 `note` | 只有 `files` 参数 |
    | 群主 `open_topic` | 必填 `note` | 只有 `files` 参数 |

    以后新加的交接点照这一节办。
- **条目**：`GroupItem` 在 `Item` 上加发言人，id 是 `g-<序号>`（按群递增）；流式时先写一条 `streaming` 的条目，说完按同一个 id 再写一行完整正文，读的时候后者覆盖前者；卡片状态变了也按同一个 id 再写一行。进程重启时看到的 `streaming` 条目不续，收尾后补一行「服务重启，这一轮中断了」。
- **事件**：`group`（群或话题新建、变化，带 `last` / `unread` / `busy` / `todos`）、`group_removed`（群和它的每个话题各发一次）、`group-item`、`group-delta`、`group-activity`。`busy` 是正在说话或有任务在跑的成员。
- 归档助手时从它所在的群里移出（群主换剩下的第一个成员）；群里没人了就一起归档。群会话的用量记在对应助手名下的「对话」里。

## Worker（任务层）


- 每个 local Job 一个独立 pi 会话，cwd 默认 `HOB_HOME/assistants/<助手id>/jobs/<jobId>/work`（启动时建好；`start_job` 显式给了 cwd 才用给的）。产出文件约定放在这个目录，读可以读任何地方；工作目录是约定，不是强制边界，v1 不拦截命令和文件写入。要给用户看的文件用 `report` 的 files 交回（落盘后 `/api/files` 能读）。
- 工具：任务没有展示页面工具，结果写成 report 的 Markdown，必要的产物文件放进 files，怎么展示给用户由助手决定；启用联网搜索时有 `web_search`、`web_fetch`；pi 内置 `read, bash, edit, write, grep, find, ls`（内置工具自带截断并把完整输出写进临时文件 = Spill），加 Hob 的 `report(outcome, result, files?)`、`ask_user(title, detail?, options[])`（阻塞等助手回复，助手自行回答或询问用户后用 `reply_job` 回复）；云桌面开启时还有整屏 `desktop_screenshot` 和 `desktop_action`；主助手的任务（定时就是它）另有只读的 `overview(sinceHours = 24)`，用来写早报/汇总；配了图像生成且该助手开着图像生成时再加 `generate_image(prompt, size?, refs?)`（见下文“图像生成”）。
- 系统提示词：任务身份和目录、交付与如实报告、用户信息、全局「一律照做」规则、全局和助手的执行前确认事项、记忆；确认事项通过 `ask_user` 询问，结果通过 `report` 提交。
- 模型：设置 → 模型里的任务执行模型（没选就退到对话模型，还没有就用模型列表里第一个可用的，思考 `high`）。
- 并发：同时最多 `settings.work.maxJobs`（默认 2）个任务，多的排队（状态 `queued`），改设置立即生效。
- 预计用时：派任务时可由助手估计，未填和续做均为 10 分钟；定时任务取最近最多 5 次已完成用时的中位数，没记录则为 10 分钟。从本轮开始运行计时，任务等待助手回答不计入；达到预计时间先把提醒送进任务会话，让任务整理并用 `report` 交结果；达到预计的 2、4、8……倍时才通知所属助手。通知附最近 10 条过程，不附指令。
- 任务用 `ask_user` 提问后，问题送到所属助手的会话；助手收到这条提问的那一轮（或之后的某一轮）结束时，如果没有用 `reply_job` 接住，也没有留下 Router 的用户确认或登录卡，就把任务结束为 `stuck`，原因是「提问没有得到答复：问题」。提问卡标为 `expired`，结束事件照常送回助手。助手转问用户时任务继续等；用户答卡后下一轮助手仍未接住，照同一规则结束。单聊、群会话和转交给别的助手的任务都按任务实际回流的会话判断；问题没送到会话时直接结束为受阻，并写清投递失败。
- 活动流：从 Worker 的工具事件生成 ActivityLine（`读 路径` / `跑 命令` / `改 路径` / `搜 模式`），统计 reads / commands / edits，实时推给前端，Job 里保留最近 200 行。
- report 的 summary 进卡片和 Router 事件（≤ 600 字）；完整的最后一条回复和 summary 写 `report.md`。
- 看门狗和工具时限：单聊、群、话题使用 `settings.work.routerStallMinutes`（默认 6 分钟），任务使用 `settings.work.jobStallMinutes`（默认 15 分钟）。一次工具调用到时后中止该调用，把已有输出和中止原因交回模型，继续这一轮；命令显式传了 `timeout` 时按它指定的秒数等待。工具运行期间不按模型无响应计时，任务的工具输出也算活动。模型请求在时限内没有事件时中止该请求并用原上下文重试一次，状态行显示「模型没有响应，正在重试」；再无响应才停下对话并提示可重新发送，或把任务记为 `stuck`，原因是「模型没有响应」。工具等待用户答复时暂停本次工具计时，答复或取消等待后继续计算剩余时间；任务提问和登录交接在等答复时可以一直等。
- Watchdog：
  - 一轮结束没 report → 自动追问一次，再不报 → `stuck`（"没交代结果"）；
  - 进程重启时还在 running/queued/waiting 的 Job → `failed`（"Hob 重启，任务中断"）。

## 记忆（长期记忆）

记忆是所有助手共用的一份（关于用户的事实、偏好、约定），不属于某个助手；助手的职责写在职责和详细职责里，做事方式放在规则或技能里。

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

## 技能

技能按「谁能用」分三档，一个助手看得到哪些只在一处算（`skills.ts` 的 `visibleSkills`）：

| 范围 | 谁能用 | 放在哪 |
|---|---|---|
| 通用 | 所有助手 | `HOB_HOME/skills`（能改的那一档）；Lore、本机 `~/.agents/skills` 和 Hob 自带的 `playwright-cli` 技能只读 |
| 本群 | 这个群的成员，在这个群里（含话题，用所属群的） | `groups/<群>/skills` |
| 助手自己 | 这个助手，单聊和它在的群里都能用 | `assistants/<id>/skills` |

同名时按本群 → 助手自己 → `HOB_HOME/skills` → Lore → `~/.agents/skills` 取第一份，被盖住的不出现；设置里停用的通用技能不出现（`settings.skills.disabled`，键是 `hob:名字` / `lore:名字` / `common:名字`）。本群和自己的技能停用后还在清单里（带 `enabled`），只是不加载、不进提示词，能改、能删、能重新开。

- **只读技能**：Lore 的技能库是所有 agent 共用的，本机 `~/.agents/skills` 是别的工具共用的，Hob 自带的 `playwright-cli` 技能来自已安装的 `playwright-core`。这些只能照着用；助手要改它们时，工具照实说它在哪、去哪改，或者让任务另存一份 Hob 的技能。
- **能改的三档同一套**：`skills.json` 记索引（版本、标题、时间、用量、开关），旧版在 `.history/<版本>`（最多 5 版），换范围时连同历史一起搬，删了移到 `.archive`。`HOB_HOME/skills` 也一样，所以助手能改、能删、能回退、能新建在这里。
- **导入格式的兼容**：`HOB_HOME/skills` 里可能放着从别处来的技能（目录名和 frontmatter 的 name 不同、说明超过 120 字、没有 `metadata.title`、顶层多几个文件）。启动时和导入后给没登记的目录补索引（第 1 版、标题取 `metadata.title` 没有就用名字、时间取 SKILL.md 的修改时间），目录名和 name 不同的把目录改名成 name（索引、版本历史、改删都对得上这个名字；已经有同名目录的跳过并记日志）。改正文、回退、沉淀改已有的，都原样保留 frontmatter（包括 Hob 不认识的字段）和目录里的其他文件。
- **给任务**：任务带上它能用的全部技能（任何一档），看得到名字、说明和位置，对得上才读正文（`Job.skillsUsed` 记下真正读过的；能改的那几档同时记用量）。任务这一轮、沉淀那一轮和续做都按开会话时启用的技能加载；只读的 Lore 那份由 Lore 插件发现，不重复给。引擎的默认技能目录与项目技能不加载。
- **给对话层**：提示词列出看得到的技能（本群、你的、通用能改的、通用只读的），带标题、版本、更新时间和文件路径，助手可读取并修改正文；「你手里有什么」不再单列通用技能。
- **定时任务**：到点交给助手或群主的材料来自定时任务本身和检查脚本输出。助手需要某类做法时，按任务提示词列出的可用技能自行选择。
- 一份技能读不了（比如 SKILL.md 坏了）只跳过那一份并记日志，其他技能照常可用。

设置页可从 pi、Claude Code、Codex 的本机技能目录复制到 Hob，限制大小并跳过越界链接；覆盖已存在的同名技能算一次新版本（旧的进历史）。设置页删除和助手删技能一样移到归档。

任务完成后不自动沉淀；助手判断事情定下来后，用 `review_job` 让原任务回顾，也可从任务详情手动触发。助手自己做成的事也可以直接用 `save_skill` 保存。新建默认归这个助手（群里归本群），`general: true` 存成通用；改已有技能时不填 `general` 就保留原范围。

回顾是任务的又一轮：在任务自己的会话（`worker.jsonl`）接着发回顾消息，模型、思考档位、系统提示词和工具沿用原任务。任务在工作目录写好草稿，用 `save_skill` 整份保存或替换已有文本，每次调用校验后提交一个版本，保留最近五版并记录来源；一次回顾可以保存多份。任务状态、轮次和任务结果不变，过程和用量照常记录。保存时按调用顺序串行提交，同名只读技能不能修改。

回顾里的 `report` 记录结果；保存过技能记 `saved`，没有保存记 `empty`，两者都不叫醒助手。失败才通知助手。中途有人接着说时中断回顾并续做，已提交的版本保留，工作目录里的草稿留在原处；进程重启时回顾停止。助手和任务的 `edit` / `write` 不能直接改 Hob 数据，助手可写自己的工作目录和自己任务的工作目录，任务可写自己的工作目录；路径解析符号链接后检查。bash 不受这项限制。

校验规则分两种。改已有的技能只查底线：有 SKILL.md、`name` 和目录名对得上、有 `description`、没有符号链接、SKILL.md 20000 字以内、`scripts/` 和 `references/` 里的附件每个 200 KB 以内。新建的再加 Hob 自己的约定：目录名 `^[a-z0-9][a-z0-9-]{1,47}$`、`description` 120 字以内、`metadata.title`（不空，带不带引号都认）、顶层只能有 `SKILL.md`、`scripts/`、`references/`（和 `.history`）、附件最多 20 个。导入的技能多半不合 Hob 的格式，改它们时不能用 Hob 的约定把它们挡住。

回顾这一轮里 `ask_user` 不出卡片、不改任务状态，直接回一句「沉淀时不用问」。沉淀结果跟着那一轮记（`JobRound.sediment`），续做后前面的卡片各显示各的。

## 脚本中的工具

助手和任务的 bash、定时检查脚本执行时，Hob 通过 `HOB_TOOLS_URL` 和临时 `HOB_TOOLS_TOKEN` 指向仅监听本机的工具接口，在原有 `NODE_OPTIONS` 后追加 `--import` 预加载文件。预加载只定义 `globalThis.tools`；`await tools.$list()` 返回工具名、标签、说明和参数 schema，`await tools.工具名(参数)` 返回结构化内容（如果工具提供）或文本字符串，工具错误抛出原始错误。没有环境变量和凭据失效分别报明原因。凭据按助手会话里的命令、任务命令或单次定时检查签发，命令或检查结束以及会话释放时作废。

可调用搜索、网页读取、知识库检索和该助手启用的生图工具，按该助手实际可用能力过滤；对话专用工具不提供。另外加上这个助手能用的插件工具（`pluginToolsForAssistant`，按需搜索的插件工具在脚本里也能直接调）。对话调用只更新实时活动（正在做的那一行），不往对话里写行，任务调用写入任务活动，检查调用保存在检查历史。插件令牌不放进脚本环境；脚本和 Hob 同属一个系统用户，能读取的文件与以前相同，这不是新的隔离层。

## 插件和 MCP

插件采用 Agent Plugins 1.0 目录（`plugin.json`、`mcp.json`、可选 `skills/`）；Hob 的图标、发布者和分类在清单 `extensions.com.hob.plugins` 下。官方源是 `https://github.com/FFatTiger/hob-plugins`，用户也可以添加其他 git 仓库或以 `.json` 结尾的 HTTP(S) 索引。git 源浅克隆，可用 `#分支`；JSON 源按索引的 `path` 和 `files` 拉文件，缺少 `files` 时只取两个清单和声明的图标。源配置在 `system/plugin-sources.json`，最近一次成功的快照在 `cache/plugin-sources/<源 id>/`。打开市场时无缓存先等待拉取，有缓存先展示、超过一小时后台更新；失败保留快照并显示原因。禁止越界路径和符号链接，每文件最多 1 MB、每源最多 20 MB；坏插件单独显示原因，不能安装。git 和 HTTP 使用 Hob 的代理设置并设置超时。

插件内容在 `HOB_HOME/plugins/<id>/`，安装状态、源标识及源名、助手范围、工具开关和非敏感配置在 `system/plugins.json`；敏感配置和 OAuth 状态在 `system/secrets.json`，接口只返回是否填写。旧的 `official` 来源仍指官方源；更新从原来源取，源被移除后已安装插件仍可运行但不能更新。同 id 的不同来源分别列出，已安装其中一个时须先卸载才能安装另一个。`search_plugins` 在多源时报告每个结果的来源。

插件可以在 `extensions["com.hob.plugins"].profiles` 声明多套配置，值是 `{ "title": "邮箱" }`；未声明的插件继续使用单份 `plugin.config`。声明后，`system/plugins.json` 使用 `profiles: [{ id, name, config }]`，敏感值放在 `plugin:<id>:profile:<profile id>:config:<key>`，profile id 由 Hob 生成并保持不变。`${hob.profiles}` 在启动插件时替换成 JSON 字符串 `[{ "name": "工作邮箱", "config": { "EMAIL_ADDRESS": "…" } }]`，只包含必填项完整的配置；这类插件不能使用 OAuth，也不能引用 `${user_config.X}`。

插件声明 `userConfig`（`type: "file"` 的配置项在网页里选文件上传，存的是文件的文本内容，最大 64 KB，不是服务器上的路径）；MCP 配置中允许的位置用 `${user_config.KEY}` 引用，普通 `${VAR}` 自动推为必填敏感项。通用路径变量 `${hob.root}` 指 Hob 安装目录，`${hob.plugin_root}` 指已安装的插件目录，`${hob.plugin_data}` 指持久数据目录 `HOB_HOME/plugin-data/<id>`（按需创建）。必填项缺失时服务不连接。启动时将旧 `system/engine/mcp.json` 各服务迁移为自定义插件，完成后原文件改名为 `mcp.json.bak`；迁移失败保留原文件和原因。

「邮箱」插件从 Hob 安装目录的 `server/mcp/email.mjs` 启动自带的 Node MCP 服务；启动时将已安装邮箱插件的旧服务路径迁移到新位置。服务以 IMAP 和 SMTP 连接邮箱；保存的附件位于 `HOB_HOME/plugin-data/email/`。未填写服务器时依次查内置表、域名的 HTTPS 自动配置、Thunderbird 配置库、MX 对应的企业邮箱内置表，最后从 MX 主机逐段去掉前缀，在 Thunderbird 配置库里查剩余域名。识别结果按域名在服务进程内缓存；配置页的选填项收在「更多设置」里。

`PluginHost` 在进程内管理每个已启用服务的连接和状态，助手单聊、群会话和任务共享连接。stdio 服务连续 10 分钟没有工具调用会关闭本地进程并保留上次的工具列表，下次调用时自动重新连接，插件页照样显示「已连接」（停没停是内部省内存的事，不让用户操心）；声明 `extensions.com.hob.plugins.keepAlive: true` 的插件保持运行，远程 MCP 不受这条闲置停止规则影响。工具均从 `pluginToolsForAssistant` 按助手范围取得。助手还可用 `search_plugins` 查询插件市场及已安装的自定义插件：未安装、停用或未分配、缺配置或连接失败、已连接分别报告对应状态；后台任务没有此工具。工具名由插件 id 和服务工具名组成；插件超过 10 个工具时按需搜索（tool_search），否则直接提供；不给用户选。服务报错返回原因，结果经 pi-mcp 限制大小。设置变化重连服务并释放空闲会话，忙的会话在本轮后释放。OAuth 发现授权服务器，令牌保存在密钥文件，浏览器的 Origin 决定回调地址；需要重新授权时显示状态。旧 `/api/mcp*` 接口由 `/api/plugins*` 取代。

- **工具插件登录（`_meta["hob/login"]`）**：工具插件可在 MCP 服务中放置对模型不可见的工具（`_meta.ui.visibility: ["app"]`），并以 `_meta["hob/login"]` 标明用途：`status`（返回 `{ signedIn, optional?, account?, detail? }`，`detail` 支持 Markdown 链接；`optional: true` 表示不登录也能用，比如已经填了令牌，这时登录只是附加选项，不显示「未登录」，登录按钮变成一行里的文字按钮，按钮上的字可以用 `startLabel` 给）、`start`（返回 `{ kind: "device_code", url, userCode, expiresAt?, interval? }` 或 `{ kind: "done" }`）、`poll`（返回 `{ state: "pending" | "done" | "error", message? }`）、`logout`。令牌由插件自行存在 `${hob.plugin_data}`（建议 0600）并自行续期，Hob 不经手令牌。`PluginHost` 在服务连接后查询初始 `status` 并随 `PluginView.login` 暴露；HTTP 接口为 `GET /api/plugins/:id/login/status` 与 `POST /api/plugins/:id/login/{start,poll,logout}`，插件返回的报错原样透传。插件列表对声明登录但 `signedIn` 为 `false` 的插件显示「未登录」（与「待配置」并列）；详情页在配置项上方显示登录状态行，设备码登录直接复用供应商插件的 `DeviceCodeLoginCard`。
- **插件自带命令与 `hob/command`**：插件可在 `plugin.json` 的 `extensions["com.hob.plugins"].bin` 声明插件内的相对目录（禁止越界与符号链接）。从 git 源、JSON 源或随包目录安装时均确保命令目录内文件具备可执行权限。插件启用且分配给该助手时，该目录进入该助手单聊与群会话 `bash`、后台任务 `bash` 以及定时检查脚本的 `PATH`，顺序为 Hob 自带命令目录（`engineDir/bin`）→ 已启用且分配的插件命令目录（按安装顺序）→ 原有 `PATH`；停用或取消分配后下一条命令不再带入。插件令牌和配置不放进命令环境变量；命令需要向插件取凭据或调用内部能力时，使用这条命令的 `HOB_TOOLS_URL` 与临时 `HOB_TOOLS_TOKEN` 调脚本工具本地接口：标了 `_meta["hob/command"]: true` 的隐藏工具允许命令调用（不出现在 `tools.$list()` 中，对模型不可见），未标的隐藏工具命令也调不到；凭据在命令结束或会话释放时作废。
- **默认自带插件**：随 Hob 默认发布的官方插件由 `scripts/update-default-plugins.mjs` 从官方源拷入 `vendor/default-plugins/<id>/`（随 npm 包与 Docker 镜像一起分发，当前含 `github`）。启动时 `seedDefaultPlugins` 对列表中未记录且未安装同 id 插件的条目离线安装并启用，来源记为 `official`（后续照常从官方源检查更新）；状态写入 `system/seeded.json` 的 `plugins` 字段，用户卸载后记为 `uninstalled` 不再自动装回，已从任意来源安装同 id 插件时不改动。

## 带模型的插件

带模型的插件把「模型供应商」作为插件的一种贡献能力（兼容 OpenCode V1 函数式供应商插件及 Magpie 扩展），而不是单独的插件类型：同一个插件可以只带工具（`mcp.json`）、只带模型（`providers`），或两样都带，共用插件目录、配置和状态。

- **清单与元数据**：在 `plugin.json` 的 `extensions["com.hob.plugins"]` 下声明 `providers: [{ package, version, integrity, export?, defaultConfig? }]`（`integrity` 为 `sha512-…` SRI），同时可声明 `maintainer`、`sourceUrl`、`riskNotice`、`permissions`（如 `network`、`subprocess`、`local-auth`、`bun-runtime`）及 `categories`（带 `providers` 的插件在目录里自动带上 `providers` 分类和 `hasProviders: true`）。
- **权限变化重确认**：安装时记住已批准的清单能力（`approvedPermissions`、`approvedProviders`）；更新插件后若新增了权限或变更了供应商包名，自动停用插件并置 `needsApproval: true`、`capabilityChanges`，在用户调用 `POST /api/plugins/:id/approve` 确认前禁止启用。
- **按需下载 Bun 与包校验（`server/src/bun-runtime.ts`）**：首次安装带模型的插件时，按平台下载固定版本 Bun（`BUN_VERSION = 1.4.2`）到 `HOB_HOME/runtime/bun/<version>/bin/bun`，内置官方 `SHASUMS256.txt` 的 SHA-256 哈希，校验通过后再解压；没装这类插件时不下载。随后用该 Bun 在 `HOB_HOME/plugins/<id>/providers-runtime/` 下按固定版本安装 npm 包（`--ignore-scripts`），从 npm registry 下载对应 tarball 核对 `integrity`（SHA-512），不通过就回滚并报错。安装期间通过 SSE 推送 `plugin-install` 进度事件。
- **共享 Bun 宿主进程（`server/src/provider-plugin-host.ts`、`server/src/provider-host.mjs`）**：所有启用的带模型插件共用一个 Bun 子进程，通过 stdio 上的行分隔 JSON-RPC 通信（请求/响应、流式 chunk、abort、反向回调）。首次用到才启动，之后一直运行、不因闲置退出：插件把对话会话放在宿主进程里，停掉后下一轮要整段重发、缓存全丢（设了 `HOB_PROVIDER_HOST_IDLE_MS` 才按这个毫秒数闲置退出），崩溃后标记 `crashed` 并在下次使用时自动重启。宿主子进程环境变量清掉 Hob 自身的密钥和 `HOB_PASSWORD`，只传每个插件自己的 `HOB_HOME/plugin-data/<id>`；插件代码仍以当前系统用户身份运行，不是沙箱隔离。
- **兼容面（OpenCode V1 + Magpie 扩展）**：支持插件导出的 `config`、`auth`（`methods`、`prompts`、`loader` 返回的 `baseURL`/`apiKey`/`headers`/`fetch`、`refresh`/`refreshLead`、`usage`、`single`、`cli`、`icon`、`keyless`）、`provider.models`、`chat.headers`；向插件提供 `client`（`auth.set`）、`directory`、`worktree`、`serverUrl` 和 `Bun`。
- **内部代理端点与模型注册（`server/src/provider-plugins.ts`）**：`ProviderPluginManager` 启动一个只监听 `127.0.0.1` 随机端口的 HTTP 服务，每次启动生成 32 字节随机令牌，拒绝缺少或错误 `Authorization: Bearer <token>` 及非本机来源的请求。每个已启用且有在用账号的插件供应商以 `plugin-<pluginId>`（单供应商）或 `plugin-<pluginId>-<providerId>` 注册进 pi 的 `ModelRegistry`（OpenAI Chat / OpenAI Responses / Anthropic Messages 三种协议），请求指向内部端点 `http://127.0.0.1:<port>/p/<pluginId>/<providerId>/*`，流式响应原样透传，浏览器/助手中止时一路 abort 到插件的 `fetch`；请求前按 `refreshLead` 自动刷新快过期的 OAuth 令牌，刷新失败标为 `expired`。
- **思考档映射**：插件模型声明的 `variants` 键（`minimal` / `low` / `medium` / `high` / `xhigh` / `max`）映射为 Hob 的思考档，与 `off` 组合；插件未声明 `variants` 时默认不提供思考档（仍可在模型思考档设置里自定义）。
- **凭据、多账号与模型缓存**：
  - 账号元数据、当前在用账号（`activeAccountId`）和按账号缓存的模型列表保存在 `HOB_HOME/system/provider-plugins.json`；拉取模型失败保留上次成功的模型列表并在 `modelsError` 写原因，不以空数组冒充成功。
  - 账号凭据（API Key 或 OAuth `access`/`refresh`/`expires`）按 `plugin:<pluginId>:provider:<providerId>:account:<accountId>` 存在 `HOB_HOME/system/secrets.json`（0600），不进日志、SSE 事件、对话或其它文件，只在需要时经内存传给宿主。
  - 一个供应商默认支持多账号登录并切换「在用」账号；插件声明 `single: true` 时覆盖唯一账号。
- **五种登录流程**：
  1. **填密钥 / 免登录**（`api` / `keyless`）：按需执行 `prompts`，提交后保存账号并拉取模型；`keyless` 免输入密钥。
  2. **设备码**（`device_code`）：从插件 `instructions` 提取用户码，前端展示网址与验证码，后台持续执行 `callback` 直到成功/取消/过期。
  3. **服务端轮询**（`server_poll`）：前端打开插件给出的授权网址，宿主后台轮询厂商接口直到成功。
  4. **本机回调粘贴**（`loopback_paste`）：检测授权链接里的 `localhost` / `127.0.0.1` 回调端口，浏览器与 Hob 不在同一台机器时，用户把浏览器最终停住的地址粘贴给服务端；服务端严格校验协议为 `http:`、主机为本机 loopback、端口属于本次登录会话允许的端口，在本机以 `redirect: "manual"` 单次回放 GET（绝不跟随跨主机跳转），拒绝一切其他地址。
  5. **本机客户端**（`local_cli`）：通过插件 `auth.cli` 检测跑 Hob 这台机器上 CLI 是否安装，支持触发插件自带的 `install()` 或展示手动安装说明。
- **HTTP 接口（均需登录 cookie；契约类型见 `shared/types.ts`）**：
  - `GET /api/plugins` → 除已有字段外，每个 `PluginView` 带 `hasProviders`、`providers`（清单项）、`providerStates`（`PluginProviderStateView[]`）、`maintainer`、`sourceUrl`、`riskNotice`、`permissions`、`needsApproval`、`capabilityChanges`；顶层额外返回 `providerHost: ProviderHostStatusView`。
  - `GET /api/providers` → 除 `providers` / `catalog` / `settings` / `models` 外，额外返回 `pluginProviders: PluginProviderSummary[]`，供设置 → 服务商页展示「来自插件 XXX」并跳回插件页；已登录插件的模型照常出现在 `models` 和 `GET /api/models`。
  - `GET /api/plugins/provider-host` → 返回 `ProviderHostStatusView`（`status`: `stopped | starting | running | crashed`，`bunVersion`、`bunInstalled`、`pid?`、`error?`、`idleMs`）。
  - `POST /api/plugins/:id/approve` → 确认更新后的权限/包变更并重新启用插件，返回 `PluginView`。
  - `GET /api/plugins/:id/providers?load=1` → 返回 `{ providers: PluginProviderStateView[], providerHost }`；默认返回缓存状态，带 `load=1` 按需启动宿主加载插件元信息和登录方法。
  - `POST /api/plugins/:id/providers/:providerId/models/refresh` `{ accountId? }` → 刷新指定（或在用）账号的模型列表，返回 `{ models, plugin }`。
  - `GET /api/plugins/:id/providers/:providerId/usage?accountId=` → 返回 `PluginProviderUsageView`（`plan?`、`windows[]`、`error?`；拿不到时返回 `error`，不伪造 0）。
  - `POST /api/plugins/:id/providers/:providerId/accounts/active` `{ accountId }` → 切换在用账号并同步引擎，返回 `PluginView`。
  - `DELETE /api/plugins/:id/providers/:providerId/accounts/:accountId` → 删除账号及对应 secrets 并同步引擎，返回 `PluginView`。
  - `POST /api/plugins/:id/providers/:providerId/auth/prompt` `{ methodIndex, inputs?, validateKey?, validateValue? }` → 取下一步交互表单（返回 `{ prompt }`）或校验字段（返回 `{ error }`）。
  - `POST /api/plugins/:id/providers/:providerId/auth/api-key` `{ methodIndex, key?, inputs?, accountId? }` → 填密钥或 `keyless` 启用，返回 `{ accountId, models, modelsError?, plugin }`。
  - `POST /api/plugins/:id/providers/:providerId/auth/start` `{ methodIndex, inputs?, accountId? }` → 启动 OAuth/设备码/本机回调/CLI 登录会话，返回 `PluginSignInSessionView`（含 `sessionId`、`kind`、`status`、`url?`、`userCode?`、`instructions?`、`allowPaste?`）。
  - `GET /api/plugins/:id/providers/:providerId/auth/session/:sessionId` → 查询登录会话当前状态（`PluginSignInSessionView`）。
  - `POST /api/plugins/:id/providers/:providerId/auth/paste` `{ sessionId, url }` → 提交 loopback 回调地址回放，返回 `{ ok: true, session }`。
  - `POST /api/plugins/:id/providers/:providerId/auth/code` `{ sessionId, code }` → 提交手工授权码，返回 `PluginSignInSessionView`。
  - `POST /api/plugins/:id/providers/:providerId/auth/cancel` `{ sessionId }` → 取消登录会话，返回 `PluginSignInSessionView`。
  - `GET /api/plugins/:id/providers/:providerId/cli` → 检测本机 CLI 安装状态，返回 `PluginCliStatusView`。
  - `POST /api/plugins/:id/providers/:providerId/cli/install` → 调用插件 `cli.install()` 安装本机 CLI，返回 `PluginCliStatusView`。
- **SSE 实时事件（`HobEvent`）**：
  - `{ type: "plugin-install", pluginId, stage, detail?, bytes?, totalBytes?, bunVersion?, packageName? }`：`stage` 依次为 `downloading_bun`、`verifying_bun`、`extracting_bun`、`installing_package`、`verifying_package`、`done`、`error`。
  - `{ type: "plugin-providers", pluginId?, providerId?, host?, signIn? }`：宿主状态变化、登录会话推进/完成/失败/取消、账号或模型变更时广播，前端据此刷新插件详情、登录弹窗或宿主状态行。

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

## 填写登录

Hob 首次启动会安装自带的「密码库」插件，默认对所有助手开启，不需要账号。密码库把登录记录写入 `HOB_HOME/plugin-data/vault/vault.json`，用同目录随机生成的 32 字节 `vault.key` 以 AES-256-GCM 加密，两个文件都是 0600 并原子写入；`system/seeded.json` 记下只安装一次，用户停用或卸载后不会自动补回。Bitwarden 等外部插件可以同时启用，Hob 按同一凭据协议分别查找。

所有声明 `list` 角色的凭据提供者都会在插件详情页显示登录列表。列表只通过 app-only 的 `list` 角色读取概况；密码显示、复制、编辑、删除和 CSV 导入分别调用 `secret`、`save`、`delete`，密码只在这一次请求和界面内存中经过，不写入 Hob 文件、事件、日志或会话。详情页支持 Bitwarden、Chrome 和 1Password 的 CSV 表头，文件只在浏览器内存里解析，重复的名称、用户名和网址会跳过。

密码管理插件可以在 MCP 工具的 `_meta["hob/credentials"]` 上声明 `list`、`secret`、`generate`、`save` 四个角色；这些工具同时带 `_meta.ui.visibility: ["app"]`，不进入助手和任务的模型工具列表。Hob 按角色调用它们，`list` 只拿登录概况，`secret` 只在一次填写操作中拿账号、密码和可选的当前两步验证码，`delete` 是只给界面用的 app-only 角色；模型只看到插件提供的 `list_logins` 和 `save_login`。

登录只有一个工具 `login(site, reason, account?, self?)`，单聊、群和任务里都有；该出哪张卡由 Hob 看过页面和密码管理器以后决定（这两件事只有 Hob 知道），助手只管「登录这个网站」。没有云桌面或助手没有凭据提供者时，`login` 直接出一张自己登录卡（标题「需要登录：网站」、助手写的 reason、「去登录」打开云桌面、用户点「完成」后回助手 `用户已在「{site}」完成登录。`），没有 `account` 参数。

有凭据提供者时，`login` 先读取当前显示的云桌面页面（`login.ts` 的 `prepareLogin`），再按顺序决定：

0. `self` 是 true（用户说要自己登录）→ 不读页面、不找候选，直接出自己登录卡。
1. 页面上有验证码框（`autocomplete="one-time-code"`，或页面上没有密码框且某个输入框的 name/id 含 otp、totp、2fa、mfa、verification、code）→ 自己登录卡，reason 显示在卡上。
2. 从助手启用的凭据提供者里按网站名称、保存的网址和可选用户名找候选：名称包含 `site`，或保存网址的主机名和 `site` 的主机名相同、互为父子域名（页面 `login.example.net` 对保存的 `example.net`），主机名完全一样的排在前面。有候选但页面对不上 → 不填，出「没有填写密码」卡（当前页面、保存的网址、「可能是仿冒的页面」），不去密码库取密码。核对规则：页面主机名必须等于某个候选保存网址的主机名，或是它的子域名；反向的父域名和相似的仿冒域名不通过。
3. 候选和网址对得上：页面上没有可见的用户名框也没有密码框 → 回「没有账号密码框」那句（见下）；设了这个网站以后都允许、或 10 分钟内批准过 → 直接填，不出卡；其余 → 批准卡。
4. 没有候选：页面上有用户名框或密码框且有提供者带 `save` 角色 → 录入卡；没有能存的提供者 → 自己登录卡；页面上没有账号密码框 → 同一个助手 10 分钟内对同一主机第一次回「当前页面（网址）上没有账号密码框。先打开登录表单再调 login；…再调一次 login，Hob 会请用户自己登录。」，第二次就出自己登录卡（助手看过页面，确认只能用别的方式登录才会再调）。

三种卡都用提问卡外壳和同一套样式（`web/src/components/Items.tsx` 的 `FillLoginCard` / `LoginEntryCard` / `LoginCard`）：

- 批准卡：标题「在 {主机名} 登录」，白底行组里「网站」带绿色「和保存的网址一致」、「账号」带提供者和文件夹（几个候选时是单选）；按钮左边文字按钮「我自己登录」，右边「不允许」「这次允许」「这个网站以后都允许」。用户允许后，Hob 再次核对页面，通过 CDP 填可见的用户名和密码输入框（密码优先 `autocomplete="current-password"` 的那个）；密码只在这次内存调用和页面填写之间经过，报错原因里出现了密码也换成「[已隐藏]」。只有用户名框时先填用户名，十分钟内同一网站同一账号再次调用不重复询问，等用户进入密码步骤后再填密码。自动填写设置只保存提供者、条目 id、主机名、用户名和时间（`system/login-auto.json`），插件详情页可以改回每次询问。
- 录入卡（`login.entry`）：密码管理器里没有这个网站的账号时用。标题「在 {主机名} 登录」，白底行组里「网站」、用户名输入框（预填 `account`）、密码输入框（`type=password`，可显示隐藏）；有两个以上带 `save` 的提供者时多一行「存到」下拉，自带密码库排第一当默认。按钮左边「我自己登录」，右边「不登录」「保存并登录」（用户名和密码都填了才能点）。提交后密码只在这一次请求里经过：Hob 调提供者 `save`（`name` 用助手写的网站名、`uris: ["https://{主机名}"]`），再照批准卡的办法核对并填进当前页面（两步登录只填用户名并记 10 分钟）；审批记录只留提供者、用户名和结果。没存上：接口回原因，卡上 toast 显示，表单保持可填，不回模型；存上了没填上：卡片和回助手的话都写明已存进哪个提供者、为什么没填。
- 批准卡、录入卡上点「我自己登录」（`POST /api/approvals/:id { self: true }`）：同一张卡换成自己登录卡的样子（标题改成「需要登录：网站」），还挂着等用户登完，不另发卡、不回模型；用户点「完成」后照自己登录卡回答。卡片收起后保留网站、账号两行，下面写「已登录 · 这次允许」/「已拒绝」/「已存进{提供者}并填好」/「没有登录」/「已选择自己登录」等结果。

回给模型的文字都在 `login.ts` 的 `loginCard` / `prepareLogin` 里：出卡的三种情况都结束这一轮（`terminate`），用户在卡上作答后作为 `[hob-event]` 回到助手（任务里回到任务）。

填进页面以后密码就在网页里了，助手自己的浏览器命令会把它带出来：`playwright-cli snapshot` 的无障碍快照里有密码框的值，`eval` 读输入框也能读到。所以 Hob 填过的密码同时记在这个进程的内存里（`rememberFilledSecret`，按助手的屏幕分，最多 20 个）；助手、任务的 `playwright-cli` 启动器把每条命令的输出和它写进 `.playwright-cli/` 的快照文件先 POST 回这个会话的浏览器转发入口（`BrowserRelay`，令牌只在命令的环境里），由 Hob 抹掉这些密码再还给命令行，模型和会话文件里看到的都是「••••」。转发入口不在了（会话已结束）就照原样输出。Hob 自己报错时也用同一份清单脱敏。这是正常流程里的保护；助手真要存心去翻页面（截图、读内存、用别的工具）挡不住，和票 254 的边界一致。

`fill_new_password` 只在同时有 `list`、`secret`、`generate` 和 `save` 四种角色时提供。它先检查当前页面的可见密码框和主机名，再判断凭据列表里同一主机名、同一用户名是否已有条目：有则更新原条目（修改密码），没有则新建（注册）。用户批准后按给出的长度和字符种类调用 `generate`，先用 `save` 写入密码管理器，再重新核对页面，通过 CDP 填 `autocomplete="new-password"` 的全部输入框；没有这类标记时注册页填全部可见密码框，修改密码页有三个密码框时保留第一个旧密码框（填原来的密码）并填其余新密码框，只有两个框就都填新密码。用户名框为空时一并填入。批准卡只保存生成规则、网站、用户名、条目和文件夹等元数据；生成的密码不进审批、会话、事件、日志或 `HOB_HOME`。注册后 30 分钟内同一网站同一用户名再次调用（网站不接受密码后的重试）仍是注册，批准卡照样出，但更新刚存的那一条，不多存；列表里那条不是这次流程存的才算修改密码。失败若已保存会明确告诉助手已存进哪一条。

端到端测试（`server/test/fill-login-e2e.test.ts`）不需要真的云桌面：云桌面的地址和令牌本来就来自部署环境变量 `HOB_DESKTOP_URL` / `HOB_DESKTOP_TOKEN`（见 `DesktopService`），测试把它们指向 `server/test/fixtures/fake-desktopd.mjs`——一个只实现 desktopd 的 `/api/health`、`/api/events`、`/api/screens/:id/browser/start` 和 `/cdp/:id` WebSocket 转发的小服务，`/cdp/:id` 原样转给本机 Chrome 的 `--remote-debugging-port`。假网站在 `fake-sites.mjs`（一步登录、两步登录、注册、改密码、仿冒页、几个没存账号的站、只有第三方登录按钮的页、登录后出验证码的页），Chrome 用 `--host-resolver-rules` 把这几个主机名指到它；假密码管理插件在 `credentials-fixture.mjs`（密码库是一个 JSON 文件，`HOB_FAKE_FAIL_FILE` 指向的文件内容决定哪一步报错，跑着的时候能切换）。本机找不到 Chrome（也没设 `HOB_TEST_CHROME`）时整组跳过。


可选的 desktopd v2 是独立容器，通过地址和 Bearer 令牌连接。每个助手按 `desktopProfile(assistantId)` 使用独立屏幕、窗口和 Chromium profile。屏幕按需启动，空闲回收后保留浏览器数据；有观看者或 CDP 连接时不回收。助手和任务用 `playwright-cli` 操作所属屏幕的浏览器；Hob 在引擎的 `bin` 写入启动器，并在每次 bash 执行时注入会话独立的本机转发地址和短期凭据。每个会话有独立的 CLI 缓存，即使命令显式指定相同的 `-s` 名称也不会串；会话结束时关闭其 CLI 守护进程。转发入口只监听 127.0.0.1，云桌面令牌留在 Hob 内；用户接管时拒绝新连接并断开已有连接，同一屏幕同时只给一个任务使用，助手遇到任务占用时提示任务名。任务结束或助手会话释放时断开。CLI 的官方技能从 `playwright-core` 原样加载。Hob 自己连当前页面（填写登录、新密码）时，「当前显示的标签页」按 `document.hasFocus()` 的那个、再按 `visibilityState` 是 `visible` 的那个、最后才是列表里的最后一个来取（`currentPage`）：Playwright 列出页面的顺序和 Chrome `Target.getTargets` 的顺序都不可靠，标签页一多就不能拿位置当当前页面。headless Chrome 里所有标签页都报 `visible`、`hasFocus` 也不稳定，所以端到端测试的浏览器里始终只留一个标签页。

登录态是跨屏幕共享的。desktopd 在 `/data/shared-login/cookies.json` 保存公共 cookie 快照，在 `/data/shared-login/state.json` 记每个 profile 是否完成首次迁移；每个 profile 启动时通过 CDP 合并旧 profile 的 cookie 并导入公共快照。每个带调试口的浏览器每 5 秒检查 cookie 变化，只把新增、变更和退出登录的 cookie 合进公共快照，再推给其他开着的浏览器；推送后刷新同一网站的页面，同一浏览器同一网站 60 秒最多刷新 3 次，浏览器正被任务或助手使用时延后到空闲再刷。localStorage、IndexedDB 和已保存密码不复制；依赖这些状态的网站由用户在桌面上完成登录。多个助手仍可同时操作各自屏幕，同一网站是否因新登录使旧会话失效由网站决定。

接管状态按屏幕隔离。Hob 监听 desktopd 的 `/api/events`，断线时清空快照并退避重连，屏幕变化经 Hob SSE 推送；`GET /api/desktop/screens` 提供快照及助手到屏幕的映射，`POST /api/desktop/screens/:id/start` 只允许已存在助手的屏幕。VNC 经登录保护的 `/api/desktop/vnc?screen=…&client=…` 代理；只看时过滤键鼠输入。Hob 每次请求把设置里的 IANA 时区通过请求头传给 desktopd，之后新起的屏幕和浏览器用这个时区，语言照 `DESKTOP_LANG`。

右栏仅在当前助手的屏幕运行时显示桌面小屏，否则显示任务命令行。普通接管和登录卡接管都只改变输入互斥状态，浏览器和原有页面继续运行，用户直接在助手的浏览器里登录；用户点“好了”或交还时，Hob 同步一次 cookie 并推给其他开着的浏览器。浏览器启动参数关闭自动化标记、统一系统信息和 WebGL 信息，并禁止 WebRTC 使用非代理 UDP；不改 `navigator`、不伪造指纹。

网页截图由 `playwright-cli screenshot` 保存为文件，助手用 `read` 查看、用 `send_file` 发送，任务通过 `report.files` 交回。任务的整屏 `desktop_screenshot` 仍保存到任务工作目录的 `screenshots/`，最多保留最近 20 张；旧助手截图随数据迁移保留。官方 CLI 的 `kill-all` 会按进程名终止其他会话的守护进程，Hob 启动器拒绝该命令并提示使用 `close` / `close-all`。

桌面文字输入：接管者的输入法提交和粘贴走 `POST /api/desktop/paste`，Hob 校验当前屏幕的接管者后转给 desktopd；desktopd 用 xclip 写入并读回确认 X 剪贴板，再发送 Ctrl+V，同屏提交串行。单次文本上限 512KB，提交会改变远端剪贴板；普通短 ASCII 和控制键仍走 RFB。

## 设置（settings.json / secrets.json）

- 界面能改的东西都在 `HOB_HOME/system/settings.json`：`{ revision, settings: { general, providers, models, image, work } }`。
  - `general`：`theme`（system / light / dark）、`timezone`（默认系统时区）、`proxy`（HTTP/HTTPS 代理地址，空表示关闭）、`noProxy`（逗号分隔的 NO_PROXY 地址，默认 `localhost,127.0.0.1,::1`）、`aboutYou`（称呼、语言、其他说明）。
  - `models`：`roster`（能用哪些模型 + 每句定位 + 默认思考档）、`conversation` / `work` 两个角色、`thinking`（每个模型的自定义思考档，键是 `"服务商/模型"`；没存就用默认规则，见“思考档”）。
  - `providers`：`ProviderSettings[]`，只有 `kind: "builtin"`（引擎自带服务商，只填 Key）和 `kind: "custom"`（兼容接口：`id` slug、`name`、`api`、`baseUrl`、`models[]`，每个模型可带 `extra` 原样透传给引擎）。Key 在 `secrets.json` 的 `provider:<id>`，接口只给 `keyConfigured`。写入走 `PUT /api/providers/:id`。
  - `search`：联网搜索服务商顺序、开关和服务地址，密钥手动填写并存入 `secrets.json` 的 `search:<name>`。搜索与抓取工具对 Router 和 Worker 可用。
  - `image`：`{ source: "off" }` / `{ source: "openai", baseUrl, model, size? }`，写入走 `PUT /api/image`。
  - `work`：`maxJobs`（1–8）、`jobStallMinutes`、`routerStallMinutes`。
- 全局网络代理：设置 → 通用里的 `general.proxy` 只接受 `http://` 或 `https://`，可带用户名和密码；`general.noProxy` 使用标准 `NO_PROXY` 的逗号分隔主机列表。Hob 进程通过 undici 的全局 dispatcher 代理模型调用、插件远程连接、OAuth、联网搜索、网页抓取、图像生成、向量服务、市场索引、版本检查和价格表请求，命中 `noProxy` 的地址直连；清空代理后恢复默认 dispatcher。设置修改后立即切换，插件服务会按现有重载流程重启。
- Hob 启动的本机插件进程、助手和任务的 bash、定时检查脚本都会收到 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY` 及对应小写变量；代理未设置时保留 Hob 继承的环境，不额外写入这些变量。邮箱插件用同一组环境变量连接 IMAP 和 SMTP，按 `NO_PROXY` 分别判断，旧 profile 里的 `PROXY` 值忽略。 `HOB_HOME/rules.json`，`GET /api/rules` 读取，`PUT /api/rules` 整表保存并推送 `rules` 事件；`ask` 表示执行前确认，`allow` 表示一律照做。
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
  - `GET /api/bootstrap` → 助手列表（带最后一句、未读、是否在忙）、在跑和最近的任务、定时、未答审批、设置（带 revision）、版本检查结果（`update`，有结果时返回）
  - `GET /api/settings` / `PUT /api/settings {revision, patch}` → 读 / 按节合并写设置
  - `GET /api/providers` → 已配的服务商、引擎自带的服务商目录、整份设置，以及每个已配置服务商的模型和思考档（`models`，键是服务商 id；内置服务商列出引擎目录里的全部模型）；`POST /api/providers/test` 测试连接（内置服务商发起少量模型调用，兼容接口访问模型列表，失败不保存配置）
  - `PUT /api/models/thinking {ref, levels}` → 存一个模型的自定义思考档（`null` = 恢复默认），返回新 revision 的整份设置和这个模型现在的思考档、`PUT /api/providers/:id`（新建或改，Key 可选留空沿用）、`DELETE /api/providers/:id`、`POST /api/providers/discover {api, baseUrl, apiKey?, id?}`（从兼容接口拉模型列表）、`GET /api/providers/import`（本机能导入的服务商，不带 Key）、`POST /api/providers/import {ids}`（导入所选，同 id 覆盖）
  - `GET /api/models`（可用模型 + 名单里哪些不可用）
  - `GET /api/usage`、`PUT /api/usage/price {revision, model, price}`（消耗，见下文“消耗”）
  - `POST /api/password {old, new}`、`GET /api/about`（版本、数据目录、版本检查结果；`main.ts` 启动时和每 6 小时查一次 npm 上 `hob-bot` 的 `latest`，只放内存，变化时同时推 `update` SSE 事件）
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
- Web Push：`web-push`，VAPID 密钥首次用时生成，和订阅一起存 `HOB_HOME/system/push.json`（0600、原子写）；subject 是 `mailto:` + 设置 → 通知里填的邮箱，没填用 Hob 的项目主页（Apple 不认 `mailto:…@localhost`）。推送只来自助手：助手出审批（该助手开了“需要我回答或做完时通知我”）、助手回合把一件事做完或失败时发出；任务的提问、结束都只交给助手，不直接推给用户，任务的提问也不计入首页和助手头像的「等你确认」。标题是助手名，点开跳 `/?a=<助手id>`；群里提的问题跳群聊页 `/#/group/<gid>`。只要有一个可见的页面客户端就不推；推送服务回 404/410 或 Apple 的 `VapidPkHashMismatch`（订阅用的是旧密钥）的订阅自动删掉，其他失败写日志，「发送测试通知」如实显示原因；页面开推送时浏览器里现有订阅的公钥对不上，先退掉再重订。页面里不再用浏览器 `Notification` 提醒。

## 前端

- 照 `docs/design/v2/index.html` 做（那是唯一的视觉真相源：CSS 变量、尺寸、组件都直接搬）。截图 `s1~s6.png` 是验收对照。
- 头像：都是 Hob 的像素小火苗，换一种颜色、带一件职责道具（安全帽、放大镜、Wi-Fi…），数据和画法在 `shared/sprites.ts`，前端画成 SVG。sprite 记成「道具」或「道具:颜色」；库里没有贴合职责的道具时，AI 可以自己画一件：sprite 记成 `custom` 或 `custom:颜色`，画法存在 `Assistant.prop`（`{ art, pal, dx }`，格式和 PROPS 里的一项相同；校验在 `shared/sprites.ts` 的 `validateCustomProp`，前后端共用，最多 16 行 × 16 字符、最多 6 种颜色、不能动火苗的 o y e 和描边 k、不能盖住眼睛、至少 6 个像素），草稿同样能带一份；自画道具在头像选择器里排第一个，换成内置道具后画法保留、能换回来；建助手时模型按职责挑道具（道具表同时生成提示词里的那行说明），和已有助手撞了就自动换颜色（自画的图案各不相同，不算撞）；助手设置里可以换道具和颜色。
- 桌面三栏：左栏助手（置顶大头像可按住拖动换位置，先后存助手的 pinOrder，下面是分组列表、收起的助手、底部设置）、中间对话、右栏（正在做 + 定时 / 定时编辑 / 助手设置，可收起）。设置是整页：桌面左侧分栏导航 + 右侧内容，手机先列表再进入。
- 设置页：通用、服务商、模型、记忆、图像生成、联网搜索、技能、任务、消耗、通知、关于都是真页面；MCP 服务从插件页管理，旧的 `#/settings/mcp` 地址跳到 `#/plugins`。
- 手机（宽 < 768px）：列表页（顶部在跑的任务行 + 助手）和对话页两级。
- 浅色为主，深色按系统或设置切换（index.html 里的 `.dark` 变量）。
- 不用 UI 组件库、不用 CSS 框架；React + 手写 CSS。

## 不做（v1）

多用户、事件型触发（邮件/Webhook）、表情回应、助手之间群聊、终端命令硬拦截（审批靠规矩 + ask_user）。
