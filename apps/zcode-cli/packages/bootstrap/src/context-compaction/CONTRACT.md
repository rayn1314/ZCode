# context-compaction

## 意图

给压缩链路一套可配置的控制面：安全余量（tokens，不是百分比）、局部压缩（清理旧工具结果）、轮末压缩
（turn 成功后立即压）、模型降档提前压（切到更小窗口前先压），以及压缩摘要正文的只读读端。设计、验收与
逐条不变量见 `core/spec/context-compaction-controls.md`；阈值口径另见 `core/spec/compact-token-count-basis.md`。

链路是单向的：设置页（`packages/ui/src/settings/ContextCompactionSection.tsx`）写 `AppSettings` →
`resolveCompactionPreferencesFromSettings` 归一 → 协议偏好（`packages/shared/src/compaction-preferences.ts`）
→ 创建期稀疏覆盖 / 热更新七项全量 → `runtime.config.compact` → core 判定与执行。

## 不变量

- 创建期与热更新期是**两个映射函数**，不可互相替代：创建期靠**省略键**（不是 `x ?? undefined`）让 CLI
  文件段存活；热更新期七项全量，用户能关掉刚打开的东西、把余量清回默认。
- `record.compaction` 必须与 `setCompactionPolicy` 在同一个循环里刷新：它是 `inherit` 子会话继承偏好的
  唯一来源，只改 runtime 会让此后派生的子会话继续沿用旧值。
- 阈值只有一条公式：`阈值 = (窗口 − min(maxOutputTokens, 21000)) − 余量`（默认余量 13000）。百分比是
  反算出来的**只读**展示值，没有写入路径。
- 轮末阈值 = `max(1, 自动阈值 − 提前量)`；提前量缺省 / 0 时判定逐位不变（`applyPostTurnThresholdOffset`
  必须返回同一引用）。
- 局部压缩的门是 `=== true`（未配置即关闭）：它会就地改写历史里的工具结果正文，属于改变模型所见内容
  的行为，不能用「缺省即开」的默认。
- 三个入口（局部 / 自动 / 降档）共用 `resolveRuntimeCompactPolicyConfig` 合成策略，且模型推导字段
  放在 `...config.compact` 之后强制覆盖；任何入口都不得自行拼装 `AutoCompactPolicyConfig`。
- 摘要正文按 `sessionId + messageId` 懒加载（正文实测 1.6 万 ~ 2.3 万字符，进快照会成倍放大体积）；
  宿主侧只认 `semantics.kind === "compact_summary"` 的消息，这条路不能顺势变成任意消息读取。

## 与其它模块的交集（hook 点）

- `settings` / `services`：偏好经 preferences RPC 单向下发，不回读运行态；`AppSettings` 是用户偏好
  的唯一所有者（`ISettingService`），跨身份迁移与跨窗口广播各自维护枚举副本——漏一处不会编译失败。
- `contracts`（`compact` 目录）：`CompactTrigger` / `CompactPhase` 的新取值要同时在四处字符串枚举副本
  里可见（legacy 时间线 zod、v4 遥测 zod、services 的手写 guard、bootstrap 投影映射）；由
  `contracts/test/compact-trigger-parity.test.ts` 钉住。
- `core` 运行时：`compact-decision.ts` 的判定被轮末与降档共用；`post-turn-compact.ts` 在 TurnComplete
  与 usage 之后、`return result` 之前内联执行（不建后台调度器）；`model-downshift-compact.ts` 必须在
  `emitModelSelected`（PreModelSwitch 注入）**之前**执行，否则注入内容会被压缩吞掉。
- `ui`：设置分区自取 setting service 与 `lib/contextCompactionSettings.ts` 的解析器；摘要展开用
  `hooks/useCompactionSummary.ts`，读取函数由 conversationRowContext 注入，展示组件不直连 transport。

运行时回归位于 `tests/context-compaction/`（契约）与 `core/test/compaction-policy-merge.test.ts`、
`compaction-policy-offset.test.ts`、`compact-trigger-paths.test.ts`、`compact-selection-preservation.test.ts`
（实现）。
