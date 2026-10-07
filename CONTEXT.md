# ZCode 领域词汇

本文件统一定义 ZCode 的领域术语，供页面、服务和文档使用。新增或修改行为前先对照本表，避免同一概念出现多个名字。

## 核心域

**Workspace（工作区）**:
用户打开的本地项目目录，或通过 remote 接入的远端目标。
_Avoid_: 项目、仓库（口语可用，文档统一"工作区"）

**workspacePath**:
workspace 的本地文件系统路径。用于文件操作、命令 cwd、Git 和路径展示。
_Avoid_: 拿它当身份键

**workspaceIdentity**:
workspace 的身份键，用于去重、绑定、缓存、队列、持久化和请求关联的身份隔离。身份键统一为 `workspaceIdentity?.trim() || workspacePath`，本地保留路径 fallback；远端 identity 由 `packages/shared/src/remote-workspace-identity.ts` 的 `buildRemoteWorkspaceIdentity` / `parseRemoteWorkspaceIdentity` 构造和解析，不在业务代码里手写格式。
_Avoid_: 远端链路只按路径匹配

**Remote Workspace Identity Merge（远程身份归并）**:
历史条目按「同 kind + 同 authority（仅 WSL 放宽 user 段通配）+ 同归一化路径」把 canonical 化后的连接 target 归并回既有条目并沿用其存量 identity；身份是数据归属键，不得因 target 格式演进静默升级，格式升级走显式迁移。规则见 `packages/ui/spec/remote-workspace-identity-merge.md`。
_Avoid_: 按 target 现算身份逐字比对历史条目、连接时静默换身份 key

**Task（任务）**:
可被调度、恢复和归档的工作单元，持久化在 `tasks-index.sqlite`。
_Avoid_: 把一次会话当成一个任务

**Session（会话）**:
一次可恢复的对话与执行上下文，归属于某个 workspace；一个 workspace 下可有多个 session。
_Avoid_: 与 Task 混用

**Subagent Session（子代理会话）**:
子代理的会话记录，与正式会话同构（同一 AgentRuntime、同一 sessionStore、同一 `sess_*` 体系、同一条会话构造路径），以 `taskType = "subagent_child"` 与指向父会话的 `parentSessionId` 区分身份。它是可输入、可续聊、可被单独唤醒的**附属**会话：输入与正式会话走同一条准入（`packages/shared/src/zcode-protocol-v4/input-role-policy.ts`），只有**受限模式**（冷恢复时读不到 launch spec、工具面身份未还原）的会话恒拒对话输入类命令；删除父会话时递归删除，中止父会话运行轮时沿树级联，关闭标签页与空闲回收不级联；它**不进入任务索引**，永不作为左栏顶层行出现，也不得再派生子代理。规则见 `apps/zcode-cli/packages/core/spec/subagent-session-as-first-class.md`。
_Avoid_: 把子代理当一次性执行体，或当与父会话平级的独立会话；把目标态当作现状；把"子会话"与 fork / 选段侧聊混为一谈（树边只认 `parentSessionId` + `taskType === "subagent_child"`）

**Session Role Policy（会话角色策略）**:
以 `taskType` 为主键、输出该会话能力面（可用命令集、工具面修正、嵌套闸、交互归属、列表归属、usage 归属）的策略表，集中一处便于审查；运行期条件（身份是否已还原、目标是否可达、是否闲时轮）作为叠加项，不塞回业务代码。它的价值是"不漂移"，不是"减少分支"——把散落的分支收成一张同样复杂的表并不降低复杂度。
_Avoid_: 在业务代码里散落 `if (taskType === "subagent_child")`；把策略表当成复杂度削减

**Host（宿主）**:
承载本地 workspace 会话运行时的进程。每个窗口一个 window-scoped Local Host，本地 workspace 共享该 Host。
_Avoid_: 远端 Host、手机专用 Host

**Remote Connection Registry（远端连接注册表）**:
窗口内管理远端 workspace 连接的注册表，是全部远端 connection 的唯一 owner。远程 workspace 由它管理，不另建 Desktop Remote Host。
_Avoid_: 与 Host 混为一谈

**Attachment（挂载）**:
客户端接入 Host 的会话级资源，运行时以 `attachmentId`（`base-<uuid>`）标识。手机远控连接桌面已有 Host attachment 并复用会话运行时。
_Avoid_: 把 attachment 当成一份独立的快照或队列

**Remote Session（远程会话）**:
由 `remoteSessionId` 标识的远端连接会话，与 `workspaceIdentity` 一起贯穿远程链路传递。
_Avoid_: 只按 workspacePath 关联远端请求

**Owner / Lease（归属与租约）**:
远端 connection 的归属关系，由窗口内的连接注册表持有。切换 workspace 时释放旧 ownership；最后一个 logical owner 取消后，迟到的成功结果必须立即释放，不能复活旧连接。
_Avoid_: 多路径同时写入同一 connection

**CommandInbox（命令收件箱）**:
CLI/runtime 中对已接受的 busy/running 输入做 per-session FIFO 串行 admission 的组件，位于 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts`；可对过期命令给出 `"stale"` 裁决。Renderer 只保留未提交草稿与 pending optimistic overlay。
_Avoid_: 在 Renderer 侧自行排队已提交的输入

**clientMode（客户端模式）**:
实时链路的语义开关，只有两个取值：`desktop-continuous`（桌面本地与 relay 的连续链路，配套 role `trusted-host-relay`）与 `web-remote-replayable`（手机远控的可恢复链路）。两者在 stream、snapshot、queue 和重连语义上不同。
_Avoid_: 把两条链路当成同一套恢复语义

**Product Identity（产品身份）**:
官方与自建两套并排存在的产品身份，由编译期常量 `ZCODE_DATA_ROOT_SUFFIX` 派生数据根后缀。远端 Server 的代码安装根按身份隔离（保证连过去跑的是匹配的构建），数据根保持共享（历史属于"该环境"）。
_Avoid_: 只隔离代码却共用后缀规则，或反过来隔离数据

**Data Migration（数据迁移）**:
把另一个产品身份数据根里的数据按**域**搬进当前身份的产品能力，域如界面设置、服务商配置、登录凭据、会话与任务历史、用户级工作流、hooks 声明。域内策略固定（目标已有则跳过，不做覆盖开关）；来源根自动探测本机全部数据根而非写死官方；共享域（skills/commands/plugins/AGENTS.md）与权限边界（hook 信任）不在迁移内。规则见 `packages/services/spec/identity-data-migration.md`。
_Avoid_: 用"迁移"泛指改数据根指针（那是 `dataBaseDir`）、或把整根目录拷贝当成数据迁移

## 插件商店（Plugin Store）

插件设置页及其市场浏览/安装体验的领域词汇。

### 市场与来源

**Official Marketplace（官方市场）**:
ZCode 官方运营的唯一分发渠道，市场 id 为 `zcode-plugins-official`，内容 = 内置插件 + CDN 插件。是"分发渠道"而非"作者归属"——其中可以收录社区作者的插件。
_Avoid_: "官方"泛指一切受信市场

**Builtin Plugin（内置插件）**:
随应用包一起分发、启动时播种进官方市场的插件。是官方插件的子集。
_Avoid_: 预装插件、bundled plugin（口语可用，文档统一"内置"）

**CDN Plugin（CDN 插件）**:
官方市场中通过官方 CDN 以 sha256 校验的 zip 包分发、按需下载安装的插件。
_Avoid_: 网络插件、在线插件

**Personal Source（个人来源）**:
用户自行添加的一切插件来源：git/GitHub/URL/本地目录市场、inline 插件。
_Avoid_: 无

**Catalog Auto-Refresh（目录自动刷新）**:
进入商店页时对 Official Marketplace 目录的节流后台刷新，用户无感知；只覆盖官方市场。
_Avoid_: 与 Manual Refresh 混用；把它称作"检查更新"（更新角标只是刷新的副产物）

**Manual Refresh（手动刷新）**:
商店页顶栏刷新按钮触发的全市场刷新，不受自动刷新节流影响。
_Avoid_: 刷新、检查更新（口语可用，文档统一"手动刷新"）

### 商店页结构

**Public Segment（公开）**:
商店列表页的分段之一，展示且仅展示官方市场的目录（Featured + 分类区块）。
_Avoid_: 官方 tab、商店 tab

**Personal Segment（个人）**:
商店列表页的另一分段，展示全部个人来源的目录，按市场分组。
_Avoid_: 第三方 tab、我的 tab

**Featured（精选）**:
公开分段顶部的策展区，名单由官方 CDN 目录的 `featured` 字段远程控制。仅存在于公开分段。
_Avoid_: 与 Recommended 混用

**Installed Strip（已安装条）**:
列表页顶部的一排已安装插件图标，点击图标进入详情页。
_Avoid_: 已安装列表（那是 Manage Installed 视图的事）

**Manage Installed View（管理已安装视图）**:
已安装条右侧齿轮进入的管理界面，承载插件级启停开关、更新、卸载、启用状态筛选。
_Avoid_: Installed tab（旧 IA 术语，已废弃）

### 元数据

**Store Listing（商店信息）**:
目录条目携带的展示性元数据：显示名、icon、分类、开发者、网站/隐私政策/服务条款链接、hero 图、示例提示词。描述"如何在商店里呈现"，不影响插件功能。
_Avoid_: 插件元数据（含糊，可能指 manifest）

**Plugin Manifest（插件清单）**:
插件包内 `plugin.json` 的功能性定义（commands/agents/skills/hooks/mcpServers/userConfig…）。描述"插件是什么、做什么"。
_Avoid_: marketplace.json（那是目录，不是清单）

**Example Prompt（示例提示词）**:
Store Listing 提供的可点击提示词，点击后新建会话并预填（不自动发送）。是详情页唯一的"新建会话"入口。
_Avoid_: 快捷指令、prompt 模板、立即试用

### 生命周期状态

**Plugin Lifecycle（插件生命周期）**:
用户从发现插件开始，经过查看、安装、配置、启停、使用、检查更新、升级、持久化恢复，直到卸载或恢复内置插件的完整产品路径。每个阶段都必须同时验证可见 UI 状态和对应的持久化或运行时结果。
_Avoid_: 仅把“安装成功”称为完整生命周期

**Restorable Builtin（可恢复内置插件）**:
被用户卸载并进入持久化抑制状态的 Builtin Plugin。应用重启不得自动重新播种；它继续出现在 Public Segment，并通过“安装”入口执行干净恢复。
_Avoid_: 未安装 CDN 插件、临时禁用的内置插件

**Orphaned Installed Plugin（孤立已安装插件）**:
对应 Personal Source 已被删除、但安装目录和用户数据仍保留的插件。它仍可使用、配置、启停和卸载；来源重新添加前不能更新，重新添加同一来源后恢复目录关联。
_Avoid_: 安装损坏、manifest 缺失、已卸载插件
