# 子代理运行时治理

意图：把子代理当**一等会话**治理——并发有上界、终态与续跑可判、跨重启可读历史、进程死亡后有对账。
本模块是 core 侧那一半；bootstrap 侧那一半（record 登记、冷恢复折回 runtimeConfig、roster 实现）
在同一模块的 roots 内，见下「交集」。

不变量：

- 任务状态的**唯一真相源**是 `runtimeTaskRegistry`；历史只存在于父会话的
  `runtime/subagent_lifecycle` session entry（一个 agentId 一行，spawn 建行、stop 覆写同一行，
  `created`/`startedAt` 取首次 spawn）。roster 端口只读，不得写状态、不得成为第二个真相源。
- 历史投影状态必须保守：只有 spawn 无终态 → `lost`，**绝不报 `running`**；未知状态词 → `lost`；
  `stopped` → `killed`（以活体注册表为准）。进程死亡留下的 `lost` 行由下次接管时对账成
  `interrupted`（判据：roster 显示 lost + 本进程注册表无该 agentId + 行早于本进程接管时刻）。
- 座位闸门是纯的（无时钟/IO/定时器）：容量每次 acquire 迟绑定读取并 clamp 到 ≥ 1，
  上界 ≥ 1 ⇒ 永不死锁；lease 是终局闩锁，每个终态转换点必归还。
- 子会话不能再派子代理：`subagents.enabled: false` 是**无条件 fail-closed** 的，launch spec 缺失也要写，
  否则冷恢复会重新长出 `Agent` 套娃后门。
- launch spec 只存推导不出来的身份事实；落盘失败只 warn，读取侧「缺规格 → 受限模式」（输入面关闭）。
- 输入复活桥是纯内存登记表，不落库、不跨进程；任务权威仍在注册表，通知能力仍在父 runtime。

与其它模块的交集（hook 点）：

- 并发上界是一个**进程级**预算（`getSubagentSeatGate()` 模块级单例）：core 不能 import bootstrap，
  所以闸门与工作流侧的 `workflow-seat-gate`（run 级、绑 ask 生命周期）各管一个维度，互不依赖。
- 构造移交：core 产出 `SubagentChildLaunchBundle`（父语境快照 + 父 runtime 活端口），
  bootstrap 的受限构造入口（`bootstrap/src/app/subagent-child-scope.ts` 是「是不是子会话」的唯一判据）
  消费它并登记 record；只有 bootstrap 拿得到的装配端口由父 App 借出。
- 冷恢复：bootstrap `zcode-protocol/subagent-launch-spec.ts` 读回规格折成 runtimeConfig；
  `zcode-protocol/subagent-roster.ts` 实现 `SubagentRosterPort`；`zcode-protocol/reload-subagents.ts`
  做子代理配置热重载（磁盘是唯一事实源，不缓存）。
- `ListAgents` 工具（`core/src/tool/handlers/list-agents.ts`）合并 live 与 history 两个来源，
  行来源决定寻址方式（`agent_*` 只对 live 有效）；历史读不到时用 `historyUnavailable` 显式区分
  「读故障」与「本来就没有」。

相关 spec：`apps/zcode-cli/packages/core/spec/subagent-session-as-first-class.md`（D1/D2/D5/D8/S1-S4）、
`subagent-seat-gate-and-registry-bounds.md`、`subagent-lifecycle-orphan-reconciliation.md`、
`subagent-lifecycle-persistence.md`、`subagent-input-revival.md`、`subagent-continuation-copy.md`。
