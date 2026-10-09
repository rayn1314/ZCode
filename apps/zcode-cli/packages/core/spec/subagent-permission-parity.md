# 子会话授权与主代理同构（去预授权 + 询问统一落父会话）

主责包：`apps/zcode-cli/packages/core`。
涉及：`apps/zcode-cli/packages/bootstrap`（投影门控、冷恢复路由、launch spec 读取）、
`apps/zcode-cli/packages/contracts`（launch spec 的两个新字段）、`packages/ui`（无改动，既有 origin 消费面）。
前置阅读：`subagent-session-as-first-class.md`（D2 / D6 / D9 是本文的地基）、
`apps/zcode-cli/packages/bootstrap/spec/permission-request-timeout.md`（本文 D4 的权威定义）。

## 背景与问题

**现象**：同一个子代理，两轮语义不同。

| 时刻 | 子会话状态 | `permission.allowedTools` 规模 | 一条高风险 `Bash`（`scope=system, risk=high`）的判定 |
| --- | --- | --- | --- |
| 派发当轮 | 刚 spawn | 0 | 走模式规则：只读命令 `ruleId=mode.build.readOnly` → allow（非只读会走到 ask） |
| 被重新打开 / 续轮后 | 冷恢复重建 | 33（= 它的冻结工具面） | `ruleId=rule.allowedTools`、`reason="Tool Bash is explicitly allowed"` → **无条件 allow** |
| 父会话（始终） | — | 0 | `decision=ask`、`ruleId=mode.build.highRisk` |

即：**子代理第一轮写文件要问，之后整份工具面变成免审批清单，此后哪怕父会话在同一个 `build` 模式
下本来会弹授权，它也一路静默落盘**。（实测与源码定位见 `subagent-session-as-first-class.md`
的「待决问题」一节，本文落地后该节已改成指向本文。）

**根因（两层，都在"两条构造路径"这个老根因上）**：

1. **概念被压平**：`bootstrap/src/app/app-config-options.ts` 把会话级工具面
   `runtimeConfig.toolAllowlist` 投影成 `permission.allowedTools`（"免审批清单"）。
   这两件事不是一回事：前者是"哪些工具注册/可见"，后者是"哪些工具不用问"。
   `runtime-config.ts` 里另一侧的注释已经把这条界线写下来了（拒绝从 `permission.allowedTools`
   回落成 `toolAllowlist`，理由正是"那个键的既有语义是免审批清单"），但反向投影没有。
2. **投影只在一条路径上生效**：子会话 App 有两条构造路径（`create-app.ts`）——
   带 childScope bundle 时**注入父会话那个 `PermissionService` 实例**（父的 allowedTools=0，
   于是落回父会话同一套模式规则）；不带 bundle 的冷恢复路径**按自己解析出的配置新建一份**
   （拿到 33 那份白名单）。同一份冻结工具面，一条路径当"工具面"，另一条当"免审批清单"。

**为什么要改**：D6 与 UI 里那个 `subagents.pane.pendingInParent`（「有 N 个请求等待在父会话处理」）
的整套设计前提是**"子代理会发起询问"**。现状让这个入口在续轮之后完全不可达，也让"子代理与主代理
同一个授权逻辑"这句话不成立。

## 设计决策

### D1 · 工具面不再等于免审批清单（子会话不投影）

`createConfigCliOverrides` 里那条 `toolAllowlist → permission.allowedTools` 的投影，
在 `runtimeConfig.taskType === "subagent_child"` 时**跳过**。

- **不整体删除这条投影**：headless CLI 的 `--allowed-tools X` 同时读作"工具面 + 免审批清单"是
  它的既有语义（`-p` 没有交互面、broker fail-closed，删掉会让 `--allowed-tools Write` 直接失败），
  改它是另一个任务。
- **不动注册面**：`runtimeConfig.toolAllowlist` 依旧是注册过滤器（`resolveBuiltInToolAllowlist`、
  MCP 工具面），子会话的可执行工具集合一个都不变。改的只是"要不要问"。
- 结果：两条构造路径取得一致——**都**落回模式规则（派发路径本来就是这样，冷恢复路径向它看齐）。

### D2 · 询问统一落父会话（含冷恢复），带 `origin`

派发路径已经是这样（`subagent-interaction-broker.ts` 把 `sessionId` 改写成父会话、`origin` 保留子会话归属）。
冷恢复路径今天不是：`server-operations.ts` 给子会话注入的是按**子会话自己** id 路由的
`createProtocolInteractionBroker`。本轮把这两条统一。

为什么必须改（而不只是"口味问题"）：落在子会话自己的 id 上，那条询问在 UI 上**几乎没有出口**——
子区块的行模型（`subagentSubBlockModel.ts`）只画图标/标题/类型/状态，没有交互角标；
子面板顶部条的「等待中」提示（`SubagentSessionSidePane.countChildPendingInteractions`）读的是
**父会话投影**里的 `origin.childSessionId`。于是它只会在"用户正好打开那个子面板"时才可见。

实现方式复用既有 wrapper，不新造：`createSubagentInteractionBroker`（core 已导出）在 bootstrap 侧
包一圈协议 broker，`parentSessionId` 取 `createRecord` 已经算出来的那个（resume 路径由
`session.parentID` 回填，`server-operations.ts` 的 materialize 入口）。

### D3 · launch spec 增补 `agentId` / `description`

冷恢复要构造 `origin`，而 `origin` 的 `agentId` / `agentType` 是**必填**（`contracts` 的
`SubagentInteractionRequestOrigin`，wire schema 也是 `.strict()` + `nonEmptyString`）。
今天这两项只有派发点有：`session.parentID` 给得出父 id，`launch spec` 给得出 `agentType` /
`agentName`，但 `agentId` 与 `description` 谁都没存。

`agentId` 不能就地编（它同时是 `SendMessage` 的寻址键），所以把它**补进 launch spec**——
那份 entry 的定义就是"spawn 时冻结、之后不可变、只存推导不出来的身份事实"，`agentId` 与
`description` 正好符合。两个字段都是**可选**（存量 spec 没有），读取侧缺字段时降级为
"路由仍落父会话、不带 origin"，并 `warn`，不编造事实。

### D4 · 超时两边一起加，权威定义在 bootstrap 的 spec

`permission-request-timeout.md` 是权威。本文只登记一条约束：**它必须同时覆盖父会话与子会话**，
实现落在协议 broker 的 `requestPermission` 上（父、子两边的询问都走同一个 broker），
因此子代理的询问与主代理的询问共用同一个时限与同一个开关。

## 行为

**权限判定**（`mode` 为 `yolo` 时不变——`mode.yolo` 放行在 `allowedTools` 之前，本次改动不触及）：

| 模式 | 工具 | 改动前（冷恢复子会话） | 改动后（与父会话一致） |
| --- | --- | --- | --- |
| build | `Write` / `Edit` / 非只读 `Bash` | 静默 allow | `ask` → 询问落父会话 |
| build | 只读命令（`Read` / `ls` / `git status`…） | allow | allow（`mode.build.readOnly`，无变化） |
| edit | `Write` / `Edit` | allow | allow（`mode.edit.fileEdit`，无变化） |
| edit | 非只读 `Bash` | 静默 allow | `ask`（`mode.build.highRisk`） |
| plan | 写入类 | 静默 allow | `deny`（`mode.plan.nonReadOnly`；plan 判定本来就在 `allowedTools` 之前，这条其实没变） |
| 任意 | 项目 deny / `alwaysAsk` / `requiresUserInteraction` | deny / ask | 不变（都在 `allowedTools` 之前） |

**询问路由**：

| 子会话来自 | `sessionId` | `origin` |
| --- | --- | --- |
| 派发（在跑的父会话） | 父会话 | `{kind:"subagent", agentId, agentType, childSessionId, description, parentToolCallId, parentTurnId}` |
| 冷恢复（重启后重开） | 父会话（本轮改） | `{kind:"subagent", agentId, agentType, childSessionId, description}`（能拿到多少写多少；`agentId` 缺失时整体不写 origin 并 warn） |

**超时**：与主代理共用 `permission-request-timeout.md` 的开关与时限（默认开启、5 分钟、自动拒绝）。

## 所有权与不变式

- **权限判定的唯一 owner 是 `PermissionService`**，一个 App 一份。子会话那份与父会话**同源**：
  派发路径借父实例（连同父会话已授予的会话级规则），冷恢复路径按同一份 config 新建。
  两条路径的输入必须相同——这就是 D1 要保证的事。
- **工具面的唯一 owner 是 `runtimeConfig.toolAllowlist`**（派发时冻结进 launch spec）。
  权限面不得从它派生（除 headless 的既有语义外）。
- **冷恢复 `origin` 的事实 owner 是 launch spec**；没存就不编。
- **不变式**：子会话的可执行工具面 ⊆ 父会话工具面。它由**注册面**保证
  （`resolveBuiltInToolAllowlist` 取父 registry 与 profile 白名单的交集），不依赖权限面；
  去掉预授权不会让子会话多拿到任何工具。
- **不变式**：子会话的阻塞交互（permission / AskUserQuestion / ExitPlanMode）一律改写为
  **父会话** 的 sessionId。派生（wrapper）只在 bootstrap 这一处，子 runtime 不再自己包一层。

## 失败语义

- **存量 spec 缺 `agentId` / `description`** → 路由仍落父会话，`origin` 整体不写（不写半份），
  记一条 `warn`。UI 上后果是权限弹窗少一个「子代理」来源徽标，不是挂起。
- **异常数据没有 `parentSessionId`**（子会话行缺失 `parent_id`）→ 保持今天的行为（落自己的
  sessionId）并 `warn`；不猜一个父出来。
- **launch spec 完全读不到** → 该子会话本来就是"受限模式"（`subagentLimitedMode`），
  与本次改动无关，不在此处兜底。
- **`permission.allowedTools` 的移除不影响 `disallowedTools`**：子会话的禁用清单依旧来自
  `runtimeConfig.toolDisallowlist`（父的），硬禁用与项目 deny 优先级不变。

## 迁移边界

- **行为变更面（非 yolo 模式）**：被委派的写操作现在会问。这是本次变更的目的，但要如实说三件事：
  1. **无人值守的会变慢 / 变失败**：自动化（cron / 闲时）会话若在 build 模式派子代理写文件，
     过去静默成功，现在要等应答，5 分钟后按超时规则自动拒绝。需要的用户应改用 `yolo`，
     或用项目 allow 规则显式声明"这里不用问"。
  2. **多一次中断**：人在场时，委派出去的写入会在父会话弹一次确认——与主代理一致，这正是要求的行为。
  3. **可回滚**：把子会话的 `toolAllowlist → permission.allowedTools` 投影恢复即可回到旧行为；
     没有落盘格式变化（launch spec 的新字段是可选、只增不减）。
- **存量会话**：不需要迁移。冷恢复的子会话下次重建 record 时即生效；不需要重派。
- **不做**：不动 headless `--allowed-tools` 的既有双语义；不给"派发/冷恢复"两条路径保留任何
  权限面上的差异分支（差异本身就是缺陷源，这次的根因就是这个）。

## 验证记录（2026-10-09，协议面实测）

单测：`packages/bootstrap/test/permission-allowlist-projection.test.ts`（5 例，含变异验证——
把门控撤掉后子会话那 3 例转红、普通会话那 2 例保持绿）、
`packages/core/test/subagent-interaction-broker.test.ts`（5 例，覆盖"最近的 broker 决定 sessionId、
第一处 setter 定 origin"）、`packages/bootstrap/test/subagent-launch-spec.test.ts`（9 例，含
`agentId` / `description` 的读写往返）。

协议面 E2E（app-server + app 驱动，build 模式派子代理写文件，驱动侧不应答）：

| 观测点 | 改动前（此前会话已录） | 改动后 |
| --- | --- | --- |
| 子代理的 `Write` | **静默落盘，一句询问都没有** | `interaction/requestPermission`：`toolName=Write`，`riskLevel=medium` |
| 请求的 `sessionId` | —（无请求） | **父会话 id** |
| 请求的 `origin` | — | `kind:"subagent"` + `agentId` / `agentType` / `childSessionId` / `childTurnId` / `description` / `parentSessionId` / `parentToolCallId` / `parentTurnId` |
| 无人应答 5 分钟后 | 文件已存在 | 文件**不存在**，按超时规则自动拒绝 |

子代理换一个 turn 重试时，`origin.childTurnId` 跟着换成新 turn 的 id——说明 origin 是**逐轮**构造的，
不是把首次派发的事实缓存下来复用。

**冷恢复路径单独跑了一次两阶段 E2E**（上面那次只覆盖派发路径，而"重启之后"正是被报的那个症状）：

1. 阶段 1：父会话派一个只读子代理（读一行文件），拿到 childSessionId，**退出 app-server 进程**
   ——子会话 runtime 不在内存里了；
2. 阶段 2：全新进程里只 `session/resume` **那个子会话**（走 `createRecord` 的冷恢复分支），
   再往子会话发一轮"把某行写进某个文件"的输入。

结果：子会话的 `Write` 触发 `interaction/requestPermission`，`sessionId` = **父会话**，
`origin` = `{kind:"subagent", agentId, agentType, childSessionId, childTurnId, description, parentSessionId}`
——`agentId` / `description` 只可能来自 launch spec，证明确实还原出来了。无人应答时两次 `Write`
都被超时自动拒绝（`decision:"deny"` + 独立文案），子会话轮次正常收场，目标文件不存在。
与上表的预测一致：冷恢复的 origin **没有** `parentToolCallId` / `parentTurnId`（那两项是派发那一刻的
现场事实，规格里没存，也不该编）。
