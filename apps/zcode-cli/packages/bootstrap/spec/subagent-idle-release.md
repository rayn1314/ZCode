# 子代理会话的空闲回收不再与父会话串行等待

涉及包：`bootstrap`（本 spec 主责）、`adapters`（无改动，仅引用其 MCP 生命周期）。

## 背景与问题

一个 app-server 进程里，子代理派发会物化一条 `taskType === "subagent_child"` 的常驻 record。
它借父 App 的进程内适配器（`modelFactory` / `mcpPort` / `executionPort` / …），因此父 App
必须比子 record 活得久——`SessionResidencyFacts.hasResidentChildren` 把这条不变式表达成
「有驻留子会话的父不可被回收」。

问题出在**子 record 自己也要等满同一个 30 分钟 idle TTL**。实测（2026-10-26，自建版 WSL）：

| 时间 | 事件 |
| --- | --- |
| 20:27:41 | 父会话派发子代理 |
| 20:57:13 | 子代理回合结束，活已经干完 |
| 21:30:36 | 子 record 才被 idle 回收（白占 33 分钟） |
| 21:30:36 | 父会话此时才解锁，它的 30 分钟 idle 时钟从这一刻起算 |
| ~22:00 | 父会话回收，其 4 个插件 MCP 宿主进程退出 |

即：一个 20:57 就该结束的资源占到 22:00。多出来的时间不是泄漏，是**两段 idle TTL 串行相加**。
用户切走的每个带子代理的会话，都会把这 33 分钟叠加进父会话的回收延迟。

同时 `sendText` 命令准入只认常驻 record（`CommandInbox.decide` 在 `getRevision` 为 null 时
直接 `proto.sessionNotFound`），一旦子 record 更早被回收，从面板直接给子代理发消息就会失败。
这是「能重新激活」的必要条件，必须同批解决。

## 设计决策

1. **只缩短子会话的 idle TTL，不动父会话的 30 分钟。**
   父会话的 30 分钟是「再点回来不卡」的刻意选择（commit `a7deccac`），保留。
   子 record 的驻留成本只是父进程里的一份 JS 堆，没有任何子进程；它的价值只有「刚结束
   还能立刻续跑」。5 分钟足以覆盖结算与即时追问，超出后走冷恢复即可。

2. **串行关系保留，只把子会话那一段从 30 分钟压到 5 分钟。**
   「父必须比子活得久」是借用式适配器的正确性不变式，不是可以取消的优化。因此不把
   `hasResidentChildren` 从 `isEligible` 里摘掉，而是让子 record 更快消失。
   收益：最坏回收延迟 63 分钟 → 35 分钟，且子 record 本身 5 分钟就释放。

3. **TTL 做成 per-session 覆盖，而不是全局调小。**
   全局调小会同时缩短普通会话的热窗口，与「再点回来不卡」冲突。`SessionResidencyFacts`
   新增可选 `idleTimeoutMs`，host 按 record 类型给出；pool 缺省回落到全局值。

4. **子会话不占主会话的常驻配额（高水位）。**
   高水位 LRU 原本把主会话与子会话放在同一个池子里按 `lastUsedAt` 排序，而子会话刚结束
   回合、`lastUsedAt` 最新，被踢的反而是用户想保留的主会话——顺序是反的。
   `SessionResidencyFacts` 新增可选 `countsTowardResidentCap`，子会话声明为 false；
   pool 的高水位计数与 LRU 候选都只取占配额的会话。子会话仍由自己的短 TTL 回收。

5. **`sendText` 在准入前冷恢复，但「不在册」不等于「该激活」。**
   复用 `CommandInbox` 既有的 `prepareDecision` 钩子（`renameSession` / `deleteSession` 已是
   同一习语），在幂等查询之后、`decide` 之前把非驻留会话拉成常驻 record。
   判据是 `hasLiveConversation`（常驻 record 或 detached publisher），不是 `sessionExists`：
   运行中的子会话没有 record、只有 raw child events 建立的 detached publisher，此时再冷恢复
   就是第二个 runtime，违反 `subagent-session-as-first-class.md` 的 owner 唯一不变式。
   恢复失败不冒泡：交给 `decide` 产出既有的 `proto.sessionNotFound`。

## 行为

- `taskType === "subagent_child"` 的常驻 record：空闲 5 分钟后进入回收候选，其余保护事实
  （运行中、后台任务、订阅、待处理交互、队列、协议操作租约）仍然优先保活。
- 普通会话：行为不变，30 分钟。
- 高水位：只统计占配额的会话（主会话）。子会话再多也不会把主会话挤出常驻池。
- 子 record 被回收后，父会话的 `hasResidentChildren` 变为 false，父会话从**子 record 消失的
  那一刻**开始计自己的 30 分钟。
- 对非驻留会话的 `sendText`：先冷恢复再准入；会话在库里不存在时仍返回 `proto.sessionNotFound`。
- 有 detached publisher 的子会话（父 runtime 仍在推送 raw child events）：不冷恢复，输入面
  仍按未物化拒绝——避免同一子会话出现第二个 runtime。
- 冷恢复出来的子会话是独立 App（自己装配端口），不再借用父 App——这是既有的冷恢复语义。

## 所有权与不变式

- TTL 的唯一所有者是 `SessionResidentPool`；host 只提供事实（`SessionResidencyFacts`），
  不参与计时。
- 子会话「短 TTL」的唯一判据是 record 的 `taskType`，与派发路径无关。冷恢复出来的子会话
  同样带 `taskType`（`server-operations.ts` 的 resume 分支显式透传），因此也受短 TTL 约束。
- 借用不变式不变：父 record 一定晚于子 record 关闭，`closeSessionTree` 的后序顺序不变。

## 失败语义

- 冷恢复失败：`sendText` 仍按 `proto.sessionNotFound` 拒绝，不新增错误码；失败原因记
  `zcode_protocol.v4.send.cold_resume_failed` warn。
- 子 record 回收失败：沿用 `resident_deactivation_failed`，下一次 rebalance 重试；
  父会话继续被钉住，不会出现「父先死、子还在借端口」。
- 并发：子 record 的回收与冷恢复由 pool 的 in-flight 闸门串行，`waitForDeactivation` 保证
  新操作不会命中半关闭状态。

## 迁移边界

- 不改全局 `DEFAULT_SESSION_RESIDENT_IDLE_TIMEOUT_MS`（仍是 30 分钟），不改 UI keep-warm。
- 不改 MCP 连接池：插件宿主进程的回收时机仍由会话 App 的生命周期决定。把插件 MCP 从
  「会话常驻」解耦到「会话活跃」是另一个独立议题——实测重连代价为 1.3–1.8 秒/服务器
  （并行约 2.5 秒），且 4 个插件都带 MCP app connection，释放会掐断已打开的预览，
  不属于低风险改动。
- 已落库的历史子会话不受影响：回收只清内存运行态，不删行、不发 `session.removed`。
