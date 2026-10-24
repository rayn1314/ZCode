# 子代理目录的结束时间：取最晚终态证据

涉及包：本 spec 主责 `packages/bootstrap`（`src/zcode-protocol/subagent-session-query.ts` 的 `projectSessionSubagents`）。读端 `packages/ui`（`app-shell/SubagentDirectorySidePane.tsx` 的 `DirectoryRow` 只渲染 `item.endedAt`）本轮不改。相关但不在本轮范围的语义见 `core/spec/subagent-session-messaging.md`（D8 左栏读父会话投影、§1 结算通道）与 `core/spec/subagent-lifecycle-orphan-reconciliation.md`。

## 背景与问题

父会话的 `ended[]` 行（左栏「子代理目录」面板的已结束段）每行带一个相对时间，取自 `projectSessionSubagents` 产出的 `endedAt`。原实现按固定优先级取第一条非空：

```
background.completedAt → candidate.stoppedAt → stateEndedAt → childOutcome.endedAt → childSession.time.updated
```

前两项与第三项都是**父侧**证据，且都可能在子代理真正结束之前很久就已存在：

- `stateEndedAt` = 父会话里那条 Agent tool part 的 `state.time.end`。后台 Agent 在 launch ACK 之后父 tool part 立即 `completed`，所以它结构上≈**启动时刻**，不是结束时刻。
- `candidate.stoppedAt` = 父会话 `SubagentStopped` 事件时间。它表达的是「父进程看见它停了」；被孤儿对账认领（`interrupted`）的子代理**事后还能被续跑跑完**，而复活跑完不会再补一条 stop，于是这个时间会永久停在认领时刻。

### 实测（2026-10-24，父会话 `sess_31a77c12-…`）

三个子代理同批派发、被对账认领、又被续跑跑完：

| 子代理 | 派发/ACK part 的 `state.time.end` | 子会话最后一条 assistant 完成 | 子会话 `time.updated` | 会话行 `last_outcome` |
|---|---|---|---|---|
| `…ab3c098e` | 03:29:40 | 07:29:15 | 07:29:18 | completed |
| `…e81ba60b` | 03:29:29 | 08:09:53 | 08:09:55 | completed |
| `…23dc9f2f` | 03:29:14 | 08:08:41 | 08:08:43 | completed |

当时 `background.completedAt` 与 `stoppedAt` 均缺席（当天 0 条 `subagent.background.completed`；复活跑完不补 stop），于是 `stateEndedAt` 胜出：面板显示「已完成 · 4小时前」，而三行其实在 07:29~08:09 之间刚刚结束。**状态是对的、时间错了**——状态走 `endedStatus`，子会话实时投影 `completed` 优先；时间走上面这条链，父侧旧值优先。

## 设计决策

### D1 · 结束时间 = 所有可用终态证据里最晚的一条

参与比较的证据：`background.completedAt`、`candidate.stoppedAt`、`stateEndedAt`、`childOutcome.endedAt`；一条都没有时回落 `childSession.time.updated`。

取最晚值在两个方向上都对，这正是它优于「把子侧证据整体提前」的原因：

| 场景 | 期望语义 | max 结果 |
|---|---|---|
| 被续跑跑完（本例） | 真实结束时刻 | 08:09，取自子会话侧最晚证据 |
| 中途被杀、最后一条消息停在更早的工具轮 | 最后一次已知活动 / 停止时刻 | 取父侧更晚的那条 |
| 真取消（子会话最后消息早于取消） | 取消时刻 | 取 `stoppedAt` |

### D2 · 不把生命周期 entry 的 `endedAt` 引入数据面

`runtime/subagent_lifecycle` 的 `endedAt` 是「停止/对账时刻」，只有 roster 读它；左栏目录刻意读父会话投影（`core/spec/subagent-session-messaging.md` D8）。本 spec 不改这条所有权，只修投影内部的时间选择。

### D3 · `childSession.time.updated` 只做兜底、不参与取最晚

它是会话行水位（任何会话写入都会推进），语义是「最后一次活动」而非「终态证据」；让它参与取最晚，会把「被后续无关写入碰过的旧行」显示成刚结束。仅在四条终态证据全缺时使用（例如子会话在写出首条消息前就被杀）。

## 行为

- 已结束行的相对时间 = 上述最晚值；`ended[]` 的排序（`endedAt` 降序）与分页游标（`encodeCursor` 内含 `endedAt`）随之同步。游标仍自洽：同一次查询内同一行只产出一个 `endedAt`。
- 状态计算不动：`endedStatus` 仍按 background → 子会话实时投影 → 父 part error → stop relation → 输出状态 → childOutcome 的顺序，因此复活跑完的行继续显示「已完成」。
- 行的 `startedAt`、`summary`、`title` 不动。

## 所有权与不变式

- **唯一产出点**是 `projectSessionSubagents`；UI 只渲染，不重算时间。
- `endedAt` 始终有值：四条终态证据全缺时回落 `childSession.time.updated`（会话行 `time_updated` 非空）。
- **不得**把父侧证据当终态时间优先使用：`stateEndedAt` 对后台 Agent 是启动时刻，`stoppedAt` 在复活场景会停在认领时刻。
- 改动不触碰 `status` 的事实源（子会话实时投影），状态与时间可以来自不同来源，这正是本例「已完成但时间错」能成立的原因。

## 失败语义

无新增错误面：只影响已结束行的数值与排序。子会话缺失、非 `subagent_child`、无法解析 `childSessionId` 的候选仍整条跳过（既有 `continue` 分支）。

## 测试

`packages/bootstrap/tests/subagent-session-query.test.ts`（vitest）：

1. `takes the latest terminal evidence as the ended time, not the parent launch ACK` —— 父 part `time.end = 20`、子会话最后一条消息完成于 500 → `endedAt = 500`。旧实现给出 20，已做红绿验证（先跑红、恢复后跑绿）。
2. `keeps a later stop relation as the ended time when it outranks the child's last message` —— 子会话最后消息 300、父侧 stop 900 → `endedAt = 900`，守卫「不要只偏好子侧证据」。

## 遗留

1. **「看见它停了」与「它真的停了」的语义差**：真被杀且未被续跑的子代理，其死亡时刻没有任何进程记录过（最接近的上界是对账 entry 的 `endedAt`，但它只被 roster 读，不在目录面板的数据面里）。本 spec 只在展示层止血，两侧语义保持原样。
2. **复活后不补终态**：被续跑跑完的子代理不写 `SubagentStopped`、不写终态生命周期 entry、不发结算通知（任务 D 范围）。本 spec 只保证即使如此，展示时间也取最晚证据。
3. 相对时间的粒度（「N小时」/「N天」）由 `packages/ui/src/lib/taskListItemPresentation.ts` 的 `formatTaskRelativeTime` 决定，本轮不改。
