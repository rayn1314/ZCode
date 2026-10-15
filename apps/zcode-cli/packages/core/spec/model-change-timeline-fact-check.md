# 模型切换分隔线落库前的事实校验（model change timeline fact check）

涉及包：`core`（本 spec 主责，`runtime/methods/timeline-persistence.ts`）。无协议、bootstrap、UI 改动。

## 背景与问题

`model_change` timeline part（时间线上的「模型已切换 A → B」分隔线）由
`recordPendingModelChange` 记录「切换意图」，在下一个 turn 开始时经
`persistPendingModelChangeTimeline` 落库。此前落库**不校验意图是否真的生效**：

- 主会话 `<v4 switchModelConfig>` / `setModel`：先 `setSessionModelSelection(toModel)`
  再 `recordPendingModelChange({ from: previous, to })`，意图与事实一致；
- 子代理派生：child runtime 构造时选型就是 `childSelection`，再
  `recordPendingModelChange({ to: childSelection })`，意图与事实一致。

问题出在**第三条路径**：`createSession` 预热 / 恢复场景可能请求一个模型（如
`requestedModel`），但最终实际生效的选型被 runtime 真值收口成另一个模型
（seedConfig / resume 回写的上次选型）。此时若某个中间动作把「切换意图」写进了
pending，而后面没有再被新的选型覆盖或清除，落库就会产出一条**从未真实发生**的
`A → B` 切换记录。落库的宿主消息上用 `getSessionModelSelection()`（真实选型）写
modelId，part 里却用 pending 的意图写 from/to——**同一份数据里两个模型身份分裂**。

该假记录一旦存在，跨项目 / 跨远端 / 长时间不看等冷打开（hydration）路径会把它当
权威切换事实重建（`transcript-hydration.ts` 的 `modelChangeToModelOf`），UI 显示
「模型已切换 A → B」——而会话历史实际只用一个模型，从未切换。

## 设计决策

- **D1 落库前校验「意图 = 事实」。** `persistPendingModelChangeTimeline` 落库前
  比较 pending 的 `toModel` 与 `getSessionModelSelection()`（runtime 当前真实选型）：
  一致才落分隔线；不一致说明切换意图从未生效（被覆盖 / 未收口），丢弃 pending，
  不落库。与投影端 `onTurnStarted` 的裁决同语义——marker 只表达「真实发生过的切换」。
- **D2 校验失败即清除 pending。** 不一致的意图是过时残留，继续保留会在后续 turn
  反复污染（每次 turn 开始都会尝试落库）；丢弃后不得重试。
- **D3 校验只认身份与档位。** 复用 `isSameModelSelection`（provider + model +
  reasoningLevel），与 `recordPendingModelChange` 内部的消重判据一致；思考深度
  变化不视为模型身份变化（与投影端「仅思考深度变化不产 marker」对齐）。

## 行为

- pending 的 `toModel` 与 `getSessionModelSelection()` 一致（身份 + 档位全等）：
  照常落库，宿主消息 modelId = toModel = 真实选型，part 的 from/to 自洽。
- 不一致：丢弃 pending（`pendingModelChangeTimeline = undefined`），不写
  message / part；打一条 warn 日志说明被丢弃的意图模型与当前选型。
- 现有语义不变：同一轮多次切换只保留第一条 `from→` 与最后一条 `→to`（pending
  的既有合并行为）；`transient` 切换仍不记录。

## 所有权与不变式

- 切换意图的唯一写入点仍是 `recordPendingModelChange`（主会话 `setModel` /
  子代理派生两处）；事实校验的唯一落库点仍是 `persistPendingModelChangeTimeline`。
- 不变式：**任何落库的 `model_change` part，其 `toModel` 必须等于落库时刻的
  `getSessionModelSelection()`**。宿主消息 modelId 与 part 的 toModel 不再分裂。

## 失败语义

- `getSessionModelSelection()` 返回 `undefined`（选型未建立）时按不一致处理：丢弃，
  不落库。此时没有可锚定的模型事实，落库只会造出分裂记录。
- 日志失败不阻断 turn：校验与落库本身是异步的，错误按 `persistPendingModelChangeTimeline`
  既有语义由调用方（turn 启动）吞掉，不改变执行流。

## 迁移边界

- 只对**新写入**的 part 生效。已落库的假 `model_change` part（如
  `sess_4073b48c...` 会话里 from=step-5-preview → to=u2-flash 而实际全程
  mimo-v2.6-flash 的这条）留在原库中，冷恢复仍会显示——清理历史假数据是独立的
  一次性数据维护，不属本改动范围。
- 协议、投影、UI 均无改动：投影的 `onTurnStarted` 裁决与 `transcript-hydration`
  重建逻辑保持原样，本改动只掐断「假意图进库」这一源头。