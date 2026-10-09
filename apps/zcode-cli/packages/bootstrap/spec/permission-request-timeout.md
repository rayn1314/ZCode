# 未应答授权请求的超时收口（可配置）

主责包：`apps/zcode-cli/packages/bootstrap`。
涉及：`packages/shared`（设置项与两个协议 schema）、`packages/services`（Host → CLI 偏好下发）、
`packages/desktop`（Host 侧偏好透传）、`packages/ui`（设置页开关与 i18n）。
显式排除：`apps/zcode-cli/packages/cli`（TUI / headless）——理由见「边界」，不是漏做。

## 背景与问题

**现象**：授权请求发出后没有任何时限。桌面上那个「等待确认」胶囊、系统通知、以及等着被应答的那一轮
回合，会一直等到有人点、或者会话被中止为止。没有「没人管它，它会自己收场」这条路径。

**为什么现在没有**：契约槽位其实一直在。

- `PermissionBrokerRequestOptions.timeoutMs`（`contracts/src/interfaces/permission.port.ts`）就是为此预留的；
- core 的执行器也一直在填它：`tool/executor/permission-flow.ts` 把 `deps.permissionTimeoutMs` 传进
  `requestPermission`（`permission-input-recheck.ts` 同理）；
- 但 `permissionTimeoutMs` 在 CLI 各包里**只被读取、从未被赋值**，所以填进去的永远是 `undefined`；
- 协议 broker（`createProtocolInteractionBroker`）也**完全不读** `options.timeoutMs`——真正实现了超时的
  只有 `ManualPermissionBroker`（TUI / 测试用的那个），而它同样拿不到值。

**同一类问题已有先例**：AskUserQuestion 的「提问自动继续」（`appRuntimePreferences.askUserQuestionAutoResolutionEnabled`
+ `V4InteractionRegistry` 的 5 分钟时钟）就是"没人应答怎么办"的问答版本。本轮把授权版本补齐，
并沿用它的产品语义：**可配置、默认开启、5 分钟**。

**为什么要与子代理授权同批做**：`core/spec/subagent-permission-parity.md` 落地后，被委派的写操作
第一次会真的发起询问。询问一旦能发生，"没人应答"就从"不会发生的边角"变成"最常见的收场"——
没有超时的询问比多问一句更糟。

## 设计决策

### D1 · 时限由交互登记表掌管，答案与语义由注册方决定

时钟加在 `V4InteractionRegistry`（`bootstrap/src/zcode-protocol-v4/interaction-registry.ts`），
它是"一条阻塞交互正在等应答"这件事的唯一权威，也已经掌管 AskUserQuestion 的同类时钟。

但登记表**不认识权限语义**（文件头原话：只做「按 id 找到 deferred 并投递应答」）。所以给
`V4InteractionRegistrationOptions` 加一个通用字段：

```ts
deadline?: {
  afterMs: number;
  answer: V4InteractionAnswer;   // 到点投递什么，由注册方决定
  isStillArmed?: () => boolean;  // 到点那一刻是否还该收口（见 D6）
};
```

到点时走的是**和用户应答完全相同的一条投递路径**（`this.resolve(interactionId, answer)`），
所以"先到先得、晚到 noop、并发应答幂等"这些性质自动继承，不需要第二套收口逻辑。

### D2 · 语义是自动拒绝（fail-closed）

没人应答时唯一安全的默认是**不做**。所以超时收口产生的是 `decision: "deny"`，
reason 用一份**独立文案**（`PERMISSION_AUTO_DENIED_ON_TIMEOUT_CONTENT`），与"用户拒绝"
（`PERMISSION_DENIED_BY_USER_CONTENT`）分开：模型据此知道这是"没人管"而不是"用户不同意"，
可以换方案或再问，而不是把拒绝读成用户偏好。

对 AskUserQuestion，「自动继续」= 交一个空答案；授权场景里等价的"继续"就是拒绝并让模型继续，
两者语义同构，不是两套规则。

### D3 · 开关默认开启、时限固定 5 分钟

对齐「提问自动继续」的产品形态（一个开关 + 写死的时长），不额外做时长输入。
开关名 `permissionRequestAutoDenyEnabled`，默认 `true`；时限常量
`PERMISSION_REQUEST_AUTO_DENY_TIMEOUT_MS = 5 * 60_000`。

### D4 · 覆盖两个阻塞审批：permission 与 ExitPlanMode

两者都经 `createProtocolInteractionBroker` 的 `requestPermission`，都属"用户在批准一件事"。
超时的 ExitPlanMode 收口为 deny + 同一 reason，会话留在 plan 模式（不偷偷退出）。

**不覆盖 AskUserQuestion**：它有自己的时钟（隐藏宽限 60s + 5 分钟 + 倒计时 + snooze），
两套时钟叠在同一类交互上会打架。

### D5 · 只作用于协议交互面（桌面 / 远程 Web / 手机）

时钟只挂在协议 broker 上。headless（`-p`）本来就没有交互面，走 `createDenyPermissionBroker`
fail-closed；TUI 有自己内联的 broker（`cli/src/tui-prompt-handler.ts`），且它的开关来源
（桌面设置页）在终端里不存在，因此 TUI 保持"一直等"。这条边界是**有意的**，不是未完成。

### D6 · 关闭开关要解除在途请求的超时

产品语义照抄「提问自动继续」的原话：**关闭后，当前和后续请求都会一直等**。所以到点那一刻要重新
读一次开关（`isStillArmed`），此时若已关闭则**不收口**，那条请求转为无限等待。
反向不对称（与登记表对 AskUserQuestion 的既有规则一致）：**开启只对之后注册的请求生效**，
不会给已经挂着的旧请求补一个时钟。

## 行为

| 场景 | 行为 |
| --- | --- |
| 开关开启（默认），请求注册 | 启动一个 `5 分钟` 的截止计时；不显示倒计时（权限胶囊不画进度条，见下"不做"） |
| 有人应答（任何客户端路径） | 与今天完全一致：登记被移除、计时被清、应答生效 |
| 无人应答，到点，开关仍开 | 投递 `{ autoResolved: "timeout" }` → broker 映射为 deny + 超时 reason；core 照常发 `PermissionResolved`，pending interaction 从投影消失、弹窗关闭、那一轮继续 |
| 到点那一刻开关已关 | 不收口，转为无限等待（D6） |
| 开关关闭时注册的请求 | 不设时限（= 今天的行为） |
| 超时收口后客户端才点 | `resolveInteraction` 未命中，按既有的「先到先得、晚到幂等成功」收口 |
| `ZCODE_ENV=test` + `ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE` | 时限按同一比例缩短，供秒级协议面用例（与 AskUserQuestion 共用同一环境变量与缩放函数） |

**不做**（有意）：不给权限胶囊画倒计时进度条、不提供"暂停倒计时"（snooze）。理由：倒计时与 snooze 是
AskUserQuestion 的产品形态（用户可能想"先不管它，等下答"）；授权场景要的是"没人就收场"，
多一个可交互的倒计时会把一个安全网变成第二个要用户照看的控件。UI 一行未改。

## 所有权与不变式

- **时限的唯一 owner 是 `V4InteractionRegistry`**；时限的**值与语义**的 owner 是注册方（协议 broker）。
  不在 broker 里另起一个 `Promise.race` 计时器：那样超时只是"本地把结果返回了"，底下那条反向请求
  仍然挂着（每秒重发现、迟到应答无处投递）——走登记表才真正结束这次等待。
- **开关的 owner 是 app setting**（Host 侧持久化），CLI 只是消费者。进程内权威读点是
  `appRuntimePreferences.permissionRequestAutoDenyEnabled`；协议 broker 在校验请求时**实时读取**它，
  因此开关改了立即对后续请求生效，不需要重建会话。
- **不变式**：超时不改变权限判定顺序。它是"ask 已经产生之后"的收场方式，永远不可能把一个本来
  allow / deny 的判定变成 ask，也不可能绕过 `alwaysAsk` / 项目 deny / plan 这些前置分支。
- **不变式**：超时收口不带任何授权副作用——不发 `permissionUpdates`、不发 `sessionPermissionUpdates`、
  不写会话规则。它只是拒绝这一次。
- **不变式**：超时 reason 必须是独立文案，且 `reasonSource` 保持 `undefined`——那两个"可升级成真实用户
  message"的 source（plan 反馈 / workflow refine）不能被一个没人说过的话命中。

## 失败语义

- **登记表缺席**（新客户端以外的路径：TUI、headless、测试里的 ManualPermissionBroker）→ 与今天一致，
  未应答就等。这不是降级：那几条路径本来就没有"用户在界面上点"的等待面。
- **`ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE` 非法值**（非 1–1000 的数字）→ 抛错，不静默忽略
  （沿用 `resolveV4InteractionRegistryOptionsFromEnv` 的既有行为）。
  注意：这个缩放**只在 `ZCODE_ENV=test` 下生效**，且变量名真的带 `ZCODE_E2E_` 前缀
  （常量 `ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV`，见 `@zcode/shared`）。
  写成 `ZCODE_ASK_USER_QUESTION_CLOCK_SCALE` 之类的近似名字**不报错、静默按原值 5 分钟计时**
  （2026-10-09 实测：一次协议面用例因此误判"超时没生效"，实际是名为 `..._E2E_...` 的开关没被读到时限没被缩短）。
- **到点与用户应答同时发生** → 登记表 `resolve` 是"先删再投递"，两者只有一个生效，另一个按未命中
  幂等收口。

## 迁移边界

- **无存量数据迁移**：设置项缺失 = 默认开启。会话不需要重建就能拿到新语义。
- **跨版本一点**：`zcodeInteractionPreferencesSchema`（Host → CLI 的命令）里新字段写成 **optional**，
  新 CLI 遇旧 Host 的命令时保持默认值；handshake 的 `zcodeSessionRuntimePreferencesResultSchema`
  用 `.default(true)`，旧 Host 缺字段按默认开启。反向（旧 CLI 遇到新 Host 多出来的字段）会被 strict
  schema 拒绝——这与既有每一个偏好字段相同，不是本轮新增的风险面。
- **回滚**：把设置项关掉（或删掉字段）即回到今天的行为；协议字段都是 optional / defaulted，
  没有落盘格式变化。

## 验证记录（2026-10-09，协议面实测）

单测：`packages/bootstrap/test/permission-auto-deny-timeout.test.ts`（8 例，含变异验证——删掉时限、
忽略 `isStillArmed`、在重复注册时重置时限，各自都能让对应用例转红）。

协议面 E2E：用 app-server（stdio NDJSON）真实驱动一轮会话（`ZCODE_ENV=test` +
`ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE=1000`，即时限 300 ms），build 模式派子代理写文件，
驱动侧**故意不应答**：

| 观测点 | 开关默认（开） | 开关关闭（负对照） |
| --- | --- | --- |
| 收到 `interaction/requestPermission` | 8 条（Write / Bash） | 1 条，同一 requestId 全程重发现 |
| 请求发出 → 自动拒绝的间隔 | 约 300 ms（17:40:43.068 → .371） | 无 |
| CLI 日志 `Permission request auto-denied on timeout` | 8 条 | 0 条 |
| 模型收到的拒绝文案 | 8 条独立的"超时"文案（非"用户拒绝"） | 0 条 |
| 目标文件 | 不存在 | 不存在 |
| 轮次结局 | `done`（子代理自己汇报"权限确认无人应答而超时被拒"） | 一直挂着，直到驱动侧超时取消 |

两条一起看才算证明：开关开时收口、关时**不**收口；否则无法区分"时限生效"与"根本没登记时限"。
