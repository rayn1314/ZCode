# 子代理配置：单源、跨环境复制与热重载

涉及其它包（各包改动就近落在本文所述边界内，不另复制 spec）：

- `packages/shared`：协议方法与 schema；`SubagentStateSnapshot`、`SubagentUserAgentFilesSnapshot`（跨环境复制载荷）。
- `packages/services`：`ISubagentsService` 三项写入统一返回全量快照 + `getSubagentState` / `replaceSubagentState` / `exportUserAgentFiles` / `replaceUserAgentFiles`；本机实例写权威后发「权威已变」信号；`ZCodeAgentService.reloadSubagents` 推送。
- `packages/ui`：设置页三条写入路径（内置覆盖 / 插件覆盖 / 启用开关）与用户 agent 增删改，只写本机并触发本机重载（不再自带跨环境复制助手）。
- `packages/desktop`：Host 侧复制通道（写入后广播 + 连接就绪时推一次），用远端连接的**真服务**而非作用域集合。
- `apps/zcode-cli/packages/bootstrap`：`workspace/reloadSubagents` op、`resolveSubagentProfiles`（唯一解析路径）、app 的 `reloadSubagents`。
- `apps/zcode-cli/packages/core`：subagent 端口迟绑定读 profile 清单与内置覆盖 + runtime `updateSubagentsConfig`。

## 1. 背景与问题

设置页「子智能体」里，**凡是写进 `{dataRoot}/v2/agents-state.json` 的配置**都会失效或滞后，具体表现两类：

1. **远端 workspace 派发永远不生效**：设置页是「Local Environment」面板（`SubagentsSection` 刻意用 `useBaseWorkspaceServices()` 且过滤远程 tab），写入只落**本机** `C:\…\.zcode-rayn\v2\agents-state.json`；而派发发生在远端 server（如 WSL 的 `~/.zcode-rayn`），它读自己数据根下**从未被写过**的同名文件 → 读到空 → 配置丢失 → 子代理继承父会话模型。实测：设置页显示 u2-flash，WSL 上 built-in `general-purpose` 子会话实际全跑父模型。
2. **改完设置对已打开的会话不生效**：配置在会话构造时随 `resolveStartupInputs` 读盘一次并烘焙进 subagent 端口，运行中的会话感知不到后续修改，必须新建会话。
3. **复制假成功，写回了本机**（2026-10-16 定位）：时点 1/2 的复制调用打在**本机实现**上——远端 workspace 作用域集合里 `ISubagentsService` 刻意是本机实例（见 D1），于是 `replaceSubagentState` 返回 OK 却把本机文件又写了一遍，远端数据根里 `agents-state.json` **从未存在**、`agents/` 目录也不存在。后果比问题 1 更重：不只三项配置丢失，**用户级自定义子智能体在远端根本不存在**（远端派发认不到 `subagent_type`，只会退成内置行为）。实测证据：桌面日志里复制序列（`getSubagentState → replaceSubagentState → reloadSubagents`）全部由本机 host 服务、远端转发日志零条复制记录；WSL 数据根无同名文件；WSL 全部子会话的 `runtime/model_selection` 恒等于父会话模型，而本机同一父会话的子会话取到的是覆盖值。

同一份文件里其实有**三项**配置，它们同源同写法、同受上面两个问题影响，因此一并治理（不做只修一半的补丁）：

| 配置项                               | 写入方                                                       | 影响面                        |
| ------------------------------------ | ------------------------------------------------------------ | ----------------------------- |
| `builtInModelSelectionOverrides`     | 内置 `general-purpose` / `Explore` 行的模型控件              | 内置 profile 的模型           |
| `pluginAgentModelSelectionOverrides` | 插件 agent 行的模型控件（键 `plugin:<pluginId>:<bareName>`） | 插件 profile 的模型           |
| `disabledAgentIds`                   | 用户 agent 行的启用开关（只对 `source === "user"` 生效）     | 用户 profile 是否进入派发清单 |

插件 agent 的启用/停用属于**插件级**（`plugin.enabled`，走插件同步链），不在本文范围。

## 2. 设计决策

### D1 · 本机是唯一权威，远端环境是复制件，复制由 Host 执行

设置页保持「Local Environment」语义不变（不改成按 workspace 路由——那会让展示与写入跟着当前 tab 漂移，且与该面板的既有定位冲突）：

- **本机文件（权威）**：`ISubagentsService` 读写，**唯一作者**。
- **远端环境文件（副本）**：只由**桌面 Host 的复制通道**写，落到该环境自己的 `{dataRoot}/v2/agents-state.json` 与 `{dataRoot}/agents/*.md`；远端 server 的会话构造时读自己的盘。远端服务不承担任何 UI 写路径，副本因此没有第二个写者。
- **复制必须用远端连接的真服务**（`connection.services`），不能用该 workspace 的作用域集合：作用域集合里的 `ISubagentsService` 是本机实现（`createRemoteWorkspaceServiceCollection` 与 skills/commands/hooks 不同，子代理刻意保留本机实例，因为权威在本机），拿它复制就会「成功地把本机文件又写一遍」（§1 问题 3）。
- **两个时点**（对齐 `remoteDynamicWorkflowUserMode` 的 ready-sync 模式）：
  1. **写入后**：本机权威写入成功（`setEnabled` / `setBuiltInModelOverride` / `setPluginAgentModelOverride` / `createAgent` / `updateAgent` / `deleteAgent`）→ 本机服务发出「权威已变」信号 → Host 读一次本机权威，把整份 `state` + 用户 agent 文件快照推给本窗口**所有在线连接**，再让各环境按自己的盘重载；
  2. **连接就绪时**：远端连接建立、作用域集合装配完成、handle 交给 registry **之前**推一次（覆盖「设置先于连接变更」的缺口，且早于该环境的任何 workspace 请求）。
- **载荷是整份快照**：`state`（三项配置）+ 用户级 `agents/*.md` **原文**。整份替换天然表达「改回继承 / 重新启用 / 删除 agent」的删除语义；项目级 `.zcode/agents/*.md` 属于远端仓库自己的工作区内容，**不复制**（否则本机会覆盖远端仓库的工程约定）。
- `kind === "server"`（独立 server）**不复制**：它有独立的设置权威与自己的子代理配置面（与 `remoteDynamicWorkflowUserMode` 同款判定）。
- 复制失败/断连不阻断保存；重连由时点 2 自愈。整份替换使重复复制幂等（同一环境多个会话命中同一实例，由远端 services 写队列串行化）。

### D2 · 热重载 op 只带 workspace ref，值由接收方重读磁盘

新增 `workspace/reloadSubagents`（对齐既有 `workspace/update*` 家族）：**载荷不含配置值**，handler 让每个 live session 按**当前磁盘**重新解析配置。理由：

- 磁盘是唯一事实源。写入方（本机写盘 / 远端复制）**先落盘再推送**，因此重读必然拿到新值；反过来说，若把值放进载荷，就多出一个可能与磁盘不一致的输入（并发窗口、部分字段过期的载荷）。
- 三项配置的**求值逻辑**（内置覆盖优先级、插件覆盖键、启用过滤、插件 profile 的保留名冲突判定）只在磁盘状态里表达；把它们复制进协议载荷等于把同一份规则实现两遍。
- 新会话/冷恢复每次都重读磁盘，运行态与新建态因此天然一致。

推送面 = 同一 service 实例管理的**全部活跃 client**（existing-only，不为推送拉起休眠 workspace）：本机实例覆盖本机全部 workspace；各远端会话的代理打到该远端 server 的实例，覆盖其全部 workspace。禁止跨数据根用本机值直接推运行态（复制走写盘通道，语义是「远端文件先变，再触发重读」）。

### D3 · 运行态应用 = 迟绑定读（对齐座位闸门「改配置后新派发生效」模式）

- 热重载把 `runtime.config.subagents` 的 **profile 清单 + 内置覆盖**成对整份替换（`AgentRuntime.updateSubagentsConfig`）。
- subagent 端口的 profile 清单与内置覆盖都**改为派发时现算**（getter 迟读 runtime config），构造期不再烘焙——构造期烘焙正是「运行中会话感知不到修改」的机理。同一处收敛也覆盖插件 profile 与启用状态，因为三者最终都体现为这份清单。
- `updateSubagentsConfig` 末尾重跑构造期的持久记忆工具投影并刷新分支感知的内置工具（`refreshBranchAwareBuiltInTools`）：`Agent` / `Task` 的工具描述读的是同一份清单，不收敛会让「模型看到的可用 agent」与「实际可派发的 agent」分叉（例如已禁用的仍被广告）。
- 子代理选型优先级契约不变（`subagent-session-messaging.md` D6：内部 override > 调用级 > profile > 父模型）。

### D4 · 唯一解析路径

`bootstrap` 导出 `resolveSubagentProfiles({logger, storageRoot, workingDirectory, plugins})`：用户/项目 profile 加载 → 插件 profile 合入（用同一次得到的覆盖表与保留名）→ 合并清单 + 内置覆盖表。**启动装配与热重载都调它**，不再各写一份表示。

`resolveAppRuntimeConfig` 与会话重载共用 `composeSubagentProfiles`：会话级注入的 profile 恒在前。热重载整份替换 `config.subagents.profiles`，若不按同一规则重组，会话级 profile 会被静默丢掉。

### D5 · 串行化

同一 workspace 的先后通知经每 workspace 一条串行队列（与既有偏好同步合用）；services 侧三项写入也共用一条写队列（读 → 改 → 原子写）。整份快照下后发先至会把旧值盖回新值。

## 3. 行为

### 3.1 事件顺序

```
写入：UI 改模型 / 切启用 / 增删改用户 agent
    → subagentsService.setXxx | createAgent | updateAgent | deleteAgent（本机写盘，返回全量快照）
    → ① 本机 zcodeAgentService.reloadSubagents()
    → ② 本机服务发「权威已变」信号 → Host：读一次本机权威（state + 用户 agent 文件原文）
         → 对每个在线连接（非 server）：远端 replaceSubagentState(快照)
                                       + 远端 replaceUserAgentFiles(文件快照)
                                       + 远端 zcodeAgentService.reloadSubagents()
    → client.request workspace/reloadSubagents（只带 workspace ref）
    → handler: 遍历 context.sessions → app.reloadSubagents()
             → resolveSubagentProfiles 按当前磁盘重解析
             → runtime.updateSubagentsConfig({profiles, builtInModelSelectionOverrides})
    → 下一次派发：端口 getter 迟读 → 现算 profile 清单 → resolveSubagentSelection（D6 不变）

连接：远端连接就绪（handle 交给 registry 之前）→ 本机 getSubagentState + exportUserAgentFiles
      → 远端 replaceSubagentState + replaceUserAgentFiles + reloadSubagents
```

顺序约束：每个连接内**先写 state、再写用户 agent 文件、最后只发一次重载**（重载按磁盘整份重解析，分两次发只会让中间态多一次无意义重读）。

状态所有权：

| 事实                     | 唯一所有者                                     | 存储                                                                    |
| ------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------- |
| 配置（权威）             | 本机 `ISubagentsService`                       | 本机 `{dataRoot}/v2/agents-state.json`                                  |
| 用户 agent 文件（权威）  | 本机 `ISubagentsService`（文件 system of record） | 本机 `{dataRoot}/agents/*.md`                                          |
| 配置/文件（远端副本）    | 桌面 Host 的复制通道（写入方）；远端服务只落盘 | 远端 server `{dataRoot}/v2/agents-state.json`、`{dataRoot}/agents/*.md` |
| 未来会话的取值           | 各环境 `resolveStartupInputs` 构造期读盘       | （无内存缓存）                                                          |
| 运行中会话的取值         | `AgentRuntime.updateSubagentsConfig`           | `runtime.config.subagents`（profiles + builtInModelSelectionOverrides） |
| 派发时选型               | `resolveSubagentSelection`                     | 端口无状态，不持有 profile 副本                                         |

### 3.2 不变式

1. 设置页永远读写本机（Local Environment 语义不变）；远端副本只由 Host 的复制通道写，远端服务不承担 UI 写路径（副本无第二写者）。
2. 复制必须走远端连接的**真服务**（`connection.services`）；作用域集合里的本机 `ISubagentsService` 只用于本机读取，不得用于复制。
3. 协议载荷不含**求值结果**：`state` 是既定的三项快照，用户 agent 文件按**原文**复制（文件本身即事实，接收方自己解析 md）。求值（覆盖优先级、启用过滤、插件保留名冲突）仍只在磁盘状态里表达，不复制进载荷。
4. 接收方按磁盘重解析并**整份替换**，不做键级合并；用户 agent 文件同样整份替换（不在快照内的 `*.md` 一律删除）。
5. 端口不得持有 profile 清单或覆盖的构造期副本；读取必须经 getter 迟绑定。
6. handler 不落任何内存缓存（磁盘是各环境的事实源）。
7. 三项配置的求值只有一条实现路径（`resolveSubagentProfiles`）；启动与热重载必须共用。
8. 选型优先级（D6）与设置页「默认=继承」显示语义不变。

### 3.3 新会话 / 冷恢复 / 子会话

- 新建/恢复会话：构造期读盘，天然最新（本机读权威，远端读已复制的副本）。
- 子会话冷恢复：模型取自已落库的 transcript/launch 规格，不走这条链。
- 子会话派发中：模型由父 runtime 派发那一刻现算（父被热重载后派发的子会话即用新值）。

## 4. 失败语义

| 失败                                    | 行为                                                                                      |
| --------------------------------------- | ----------------------------------------------------------------------------------------- |
| 本机写盘失败                            | 抛错 toast，不通知不复制（与既有一致）                                                    |
| 本机重载通知失败（非 method-not-found） | 保存已落盘（提交点），toast「已保存，但未能同步到全部运行中会话与远端环境」               |
| 旧 CLI 不认识方法（method-not-found）   | `zcodeAgentService` 内部降级 warn（compaction 同款），对调用方是成功                      |
| 旧远端无 `replaceUserAgentFiles`        | 该环境只降级 warn（state 复制与重载照常）：用户 agent 文件仍是远端缺失，内置/插件覆盖不受影响 |
| 远端复制/通知失败（断连、旧 server）    | 保存不受阻；toast 提示部分远端未同步；重连时 3.1 的连接就绪复制自愈                       |
| 单个远端连接复制失败                    | 只 warn 该连接，其余连接继续推（连接间相互隔离，不因一个断连放弃其它环境）                 |
| 磁盘读失败（重载时）                    | handler 上抛（不把半应用的配置当成成功）；本机已落盘的设置不受影响，下次通知/新建会话再取 |
| 远端断连时                              | 该环境不参与复制（断连代理拒绝），重连后自愈                                              |
| 热重载后派发但 provider/模型不可用      | 沿用 `resolveSubagentSelection` 既有硬失败（不静默回退父模型）                            |

## 5. 迁移边界

- 旧远端 server（无 `reloadSubagents` 方法）：通知降级（method-not-found），复制写盘仍走 `replaceSubagentState` + `replaceUserAgentFiles`（缺哪个方法就只 warn 那一步）；运行中会话保持旧行为直到新建会话。
- 旧远端 server（无 `replaceUserAgentFiles`）的过渡期：三项配置已能同步（`replaceSubagentState` 早已存在），用户级 agent 文件仍缺——此时远端派发自定义 `subagent_type` 会退成内置行为，直到远端 server 一并升级。
- 远端环境若曾被独立配置过，连接就绪复制会以本机设置为准覆盖它（产品语义：桌面设置页是唯一配置面）；远端被手工放进去的 `agents/*.md` 会被下一次整份替换删除（副本语义，不合并）。
- 新建会话读盘时**重新解析用户 agent 目录**，因此新增/删除 `.zcode/agents/*.md` 的变更会在下一次重载后生效；但**插件清单**沿用本次启动的发现结果（新装插件仍需重启，与「已有会话不热加载新插件」一致）。
- 用户 agent 的 md 文件增删改在设置页发生（写本机 agent 目录），本机是唯一作者；远端环境只接收复制，副本侧不做 UI 写入。
- 不在本轮范围：
  - 插件自身的启用/停用（`plugin.enabled`）走插件同步链，与本文无关；
  - `kind === "server"` 的独立 server 环境不接收复制（有自己的设置权威）；
  - bot-only 运行时（未注册为 workspace 会话）不接收复制/通知，新建会话读自己盘；
  - 项目级 `.zcode/agents/*.md` 不参与复制（属于远端仓库自己的工作区内容）；
  - `useSubagents` 对远端 workspace 传本机服务 + 远端路径扫描 workspace 级 agent 文件的既有怪癖（作用域集合仍为本机 `ISubagentsService`，本轮不动；影响的是远端项目 `.zcode/agents` 的列举，与本文的模型/启用配置无关）。
