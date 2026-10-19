# Provider 请求速率限制（每分钟最多请求数）

- 主责包：`apps/zcode-cli/packages/bootstrap`
- 涉及其它包：`packages/provider`（配置 schema 与解析）、`apps/zcode-cli/packages/contracts`（`ModelRequestAdmission` 端口）、`apps/zcode-cli/packages/core`（子会话继承端口）、`apps/zcode-cli/packages/adapters`（runner 的 `admitAttempt`）

## 背景与问题

服务商侧的配额是「每分钟 N 次」，长在**账号**上，不区分这次请求来自主代理、子代理还是工作流。ZCode 侧唯一读得到配额数字的地方是已解析的 Provider Registry（`ProviderConfig.requestPolicy.requestsPerMinute`），用户面入口是设置 → 模型设置 → 服务商卡片 → 「请求策略」。

模型请求有许多条发出路径，各自构造自己的 runtime。只要有一部分路径没拿到限速端口，它们就会在主代理看不见的地方把配额吃光，表现为「明明限了速，还是撞 429」。本轮之前有两条这样的路径：

1. legacy `Workflow` 工具的子代理（`script-workflow-runtime.ts` → `createScriptWorkflowAgentRuntime`）；
2. expert workflow facade 的 workflow 子 runtime（`workflow-facade.ts` 的 `createWorkflowChildRuntime`）。

两者都因为「不参与进程级并发治理」而不带 `modelRequestAdmission`；而限速恰好是挂在同一个端口上的一层装饰，于是被一并豁免了——豁免的理由（不排队）对限速并不成立，配额是账号级的账。

## 设计决策

- **限速是端口上的装饰层**：`withProviderRateLimit(inner, port)` 只在既有并发闸门上补一个 `awaitRateLimit`。谁拿到端口谁受限，所以覆盖面等于端口的装配范围，而不是散落在各发送点。新增调用路径时，问题从「记得加限速」变成「记得带端口」。
- **进程级单例、按 `providerId` 分桶**（`getProviderRateLimiter`）：配额在账号上，同一进程里的多个会话（app）共用一份桶。每次请求重读配置，设置页改完立即生效，不重建桶。
- **令牌桶而非滑动窗口**：桶是三个标量，不随在飞量增长。代价是突发边界上略有出入（满桶可 N 连发，随后匀速补），对配额约束而言这正是想要的语义——用户配的是**节奏**。
- **给不参与并发治理的 legacy 路径一个「只带配额」的准入端口**（`createRateLimitOnlyAdmission`）：立即给票、不排队、不喂治理器信号，但**限速生效**。它刻意不提供 `tryAcquire`——runner 因此不发并发那一条 `model_request_queued` / `model_request_admitted`（没有快路径就分不清「排了队」与「立即放行」）；限速那一条由 `awaitRateLimit` 的返回时长单独决定，照常发。
- **不动并发语义**：legacy 子代理依旧不进治理器的在飞统计。本轮只补配额这一层。

## 行为

受限的调用路径（共用同一份 per-provider 额度）：

| 路径                                                | 端口来源                                                         |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| 主代理（turn step、工具内部调用、sidecar）          | `create-app`：`withProviderRateLimit(governor.observer(), port)` |
| Agent/Task 工具派发的子代理（前台 / 后台 / 冷恢复） | 继承父 runtime 的端口（`core/src/runtime/methods/subagent.ts`）  |
| 动态工作流（dwf）的每个 actor                       | driver 的 per-actor 准入端口，座位闸门（seat gate）透传          |
| legacy `Workflow` 工具的子代理                      | 本轮新增：`createRateLimitOnlyAdmission`                         |
| expert workflow facade 的子 runtime                 | 本轮新增：同上                                                   |
| 辅助对话（`selection_side_chat`）                   | 普通会话 fork 路径，走标准会话构造，天然带端口                   |
| 标题生成 / 压缩摘要 / 记忆提取 / 目标校验           | 统一走 `createRuntimeModel`，准入端口在句柄工厂绑一次            |

不受限：

- **非模型请求**：拉取模型列表、插件市场、MCP OAuth、provider 连通性探测。它们不消耗 LLM 配额。
- **其它进程**：CLI 进程按 `workspaceKey` 复用（`zcodeAgentProcessManager.ts` 的 `processesByWorkspaceKey`），所以**同一工作区共桶**；不同工作区、双开桌面窗口、手机远控、WSL 远端各自一份桶，各自限 N/min，加总仍会超账号配额。跨进程共享需要落共享状态，当前未做。

## 所有权与不变式

- 配置唯一来源：`ProviderConfig.requestPolicy.requestsPerMinute`（稀疏语义：省略 = 继承，`null` = 清除）。
- 桶的唯一所有者：`createProviderRateLimiter` 的进程单例，按 `providerId` 分桶。
- 端口的唯一装配点：`create-app.ts` 的 `providerRateLimit`，其余位置只消费、不各自构造。
- **等待顺序是载荷性的**：`awaitRateLimit` 必须在抢并发槽**之前**（`admitAttempt` 固定先限速后 `tryAcquire`）。反了会形成「持槽者等令牌 → 令牌要等已发出的请求 → 别人在排队等槽」的三方互等死锁。
- 「只带配额」的准入端口不得提供 `tryAcquire`：提供了就变成并发闸门，把 legacy 路径拉进治理器的在飞统计。
- 限速层只读自己的令牌桶，不碰任何并发槽。

## 失败语义

- `requestsPerMinute` 非法（0 / 负数 / 非有限）等价于不限速——0 会让配额永远补不满，那是把所有请求永久挂起。
- 不限速的 provider 不建桶、不排定时器、不留状态；`awaitRateLimit` 返回 0，且不发等待事件（否则「真在等并发」这条信号会被淹掉）。
- 等待期间 abort：等待者立刻摘除并 `reject(signal.reason)`；队列空了连定时器一起撤，避免用户取消后进程被无主定时器拖住。
- 时钟回拨（系统改时间、NTP 校正）不凭空造令牌：负时间差按「未经过」处理。
- 限速器自身不抛错、不干预重试：真撞上 429 仍走既有指数退避。

## 迁移边界

- 本次把两条 legacy 路径从「不受约束」改为「与主代理共享配额」。行为差异只在用户配了 `requestsPerMinute` 时可见：legacy workflow 子代理的请求会先等令牌，等待事件（`cause: "rate_limit"`）会出现在它们的时间线上。
- 端口是可选的：未装配的调用方行为逐字不变（`admitAttempt` 在端口缺席时返回空实现）。
- 跨进程共享与「限速等待显示重试时刻」仍是已知缺口，见上文「不受限」与 `provider-rate-limiter.ts` 的遗留说明。
