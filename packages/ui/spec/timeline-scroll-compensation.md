# v4 时间线虚拟滚动补偿与前插锚定（spec）

## 背景与问题

自建版切换会话后自动吸底属正常，但用户「首次轻微上滑」时概率性出现幅度异常的
「跳到很上面」，随后自行收敛。根因两处，都在虚拟滚动的滚动补偿上：

1. **测高补偿谓词漏掉跨视口顶边的行**。
   `@tanstack/virtual-core` 的默认谓词是 `item.start < scrollOffset`，判定标准是
   「行起点在视口顶之上」，天然包含正跨过视口顶边的行；本仓库历史实现
   `shouldAdjustVirtualizerForItemSizeChange` 用的是 `itemEnd <= scrollTop`，只补偿
   「整行完全在视口上方」的行。跨顶边行的高度变化会把其下方内容整体推移 Δ，视口
   显示更早内容——即用户看到的跳变，幅度 = Δ。
   暴露链：切换会话 → `heightCache.clear()` + `virtualizer.measure()` 全行回落 72px
   估算高度重测 → following=true 时每次 commit 贴底掩盖抖动 → 首次上滑时 wheel
   capture 立即 `commitFollowing(false)` → 此后所有跨顶边行的测高（含内容异步就绪
   的二次收敛）不再被掩盖 → 概率大、幅度大；收敛完成后「之后正常」。

2. **前插平移量是增量式，会重复计入同帧测高增量**。
   历史实现用 `nextTotalSize - prevTotalSize` 计算 loadOlder 前插后的
   `scrollTop += delta`。若前插 commit 同帧已有测高落地（ref 回调同步测高或 RO 先行
   交付），该测高增量既进了 totalSize 差值，又已被 virtualizer 逐行补偿，平移量被
   重复计入，方向为「显示更晚内容」，与主诉方向相反但仍是真实缺陷。

## 设计决策

- **测高补偿谓词对齐 tanstack 默认语义**：`itemStart < scrollTop`（含跨视口顶边行）。
  保留仓库自定义的三个开关（following / suppressAdjustment / contentWidthChanging），
  它们表达「此刻不应补偿」的产品语义，优先于几何判定。
- **前插恢复改为绝对目标而非增量**：
  `scrollTop' = next.start - previous.offsetTop`，其中
  `offsetTop = 锚 unit 记录时刻的 measurement.start - 当时的 scrollTop`。
  绝对目标始终对齐「锚 unit 的当前 start」：同帧测高无论先于还是后于平移落地，
  该增量都只计入一次。
- **锚 = 上一 commit 末的窗口首 unit**（`{ key, offsetTop, start }`，`PrependVirtualAnchor`）。
  前插判定 = 该锚在 `measurementsCache` 中的 index > 0（确有更早内容插到它前面）；
  锚不存在（-1）或仍居首（0）都不平移。
- **精确路径优先**：loadOlder 触发瞬间在 `handleScroll` 保存的锚（视口偏移更贴近
  用户触发时刻）优先；无精确锚时回落到 commit 末基线。两条路径共用同一恢复函数
  `prependVirtualAnchorAdjustment`，旧 `prependScrollAdjustment` / `PrependAnchorInput`
  已删除。

## 行为

- 用户滚动权不变：只有真实用户滚动输入改变 following；测高补偿与前插平移只更新
  几何账目（`lastObservedScrollTopRef`、布局 guard、观察者通知照旧入账）。
- 会话切换后自动吸底不变；首次上滑时跨视口顶边的测高不再推移视口内容。
- loadOlder 前插时，锚 unit 的视口偏移在 commit 前后保持一致（绘制前完成，无闪动）。
- following=true 时兜底前插路径跳过：前插与「用户想待在底部」无关，且基线可能记录
  于贴底动作之前，跳过可避免用陈旧视口偏移做无谓平移；贴底 effect 收尾。

## 所有权与不变式

- 唯一所有者：`ConversationTimeline`。following 状态机在 `timelineScrollAnchor.ts`
  纯函数，几何基线在组件 `prependAnchorRef` / `pendingPrependVirtualAnchorRef`。
- 不变式 1：跨视口顶边（含整行在上方）的行高变化必须等量补偿 scrollTop。
- 不变式 2：锚 unit 的视口偏移 `start - scrollTop` 在前插 commit 前后不得变化。
- 不变式 3：测高补偿判定与平移不得改变 following（滚动权只属于用户输入）。

## 失败语义

- 锚 key 不一致、锚不在 `measurementsCache`、任一数值非有限、无滚动容器、
  `pendingDetachedScrollRestoreRef` 拥有当前 commit 的坐标系 → 不平移（返回 null），
  交由底部锚定/滚动记忆恢复逻辑处理。
- 会话切换时重置基线（unit key 跨会话可重复），禁止跨会话误判为前插。

## 迁移边界

- 仅 v4 `ConversationTimeline` 的滚动补偿；`ModelTrajectoryTimeline` 的
  `shouldAdjustScrollPositionOnItemSizeChange` 独立实现，不受影响。
- 无协议、持久化与跨包接口变更；高度缓存（`TimelineRowHeightCache`）行为不变。
