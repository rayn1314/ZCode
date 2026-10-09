# Wire snapshot 字节测量缓存（输入准入的 memo 化测量）

涉及包：本 spec 主责 `packages/bootstrap`（`zcode-protocol-v4/conversation-topic-publisher.ts`、`zcode-protocol-v4/product-projection.ts`）。调用方 `zcode-protocol-v4/v4-gateway.ts`（入口不改，签名不变）；测量口径常量 `PROTOCOL_V4_LIMITS.logicalFrameAssemblyMaxBytes`（`packages/shared`，不改）。

## 背景与问题

1. **每条输入准入都整份序列化测字节**：gateway `handleCommand` 对 sendText / sendGoalCommand / compact / createSession 逐条调 `ConversationTopicPublisher.measureInputAdmissionProjectionBytes`，旧实现构造候选快照后 `measureWireSnapshotBytes(getWireSnapshot(candidate))`——整份 `JSON.stringify` + `new TextEncoder().encode`，三份临时分配（JSON 字符串、编码器、Uint8Array）。会话越大越贵，排队的多条命令对**几乎同一份快照**重复付费。
2. 事件侧已有增量手段（dwf 键级增量上界、streaming append 上界、批量 hydration checkpoint），准入侧没有——这是 P2-6 上半段的成本来源。

## 设计决策

### D1 · 版本判据 = 投影 snapshot 对象引用

- `ProductProjection` 对 snapshot 只做**不可变替换**（`applyEvent` 里 `this.snapshot = {...applyConversationDeltas(...), seq}`；`seedConfig`/`seedSharedContextImport`/`seedUsage`/`seedSubagents` 同样 `{...}` 重建），`getSnapshot()` 在下一次变更前返回同一引用。因此「引用相同 ⇒ 内容相同 ⇒ wire 字节数相同」是可证明的，memo 按引用判据命中即安全。
- **不用 revision 当判据**：种子注入明确不递增 revision/seq（`seedConfig` 注释：种子直改 `snapshot.config`，不产 delta），revision 相同 ≠ 内容相同，按它缓存会测少。
- **不做按时间的缓存**：禁止。测量值必须始终等于真实发送值（见不变式）。
- **hydration 例外**：冷恢复批量重放期间 snapshot 在 accumulator 上**原地**推进（同一引用内容持续变，见 `beginHydrationReplay`），引用判据在该状态不成立。准入永远读不到候选 publisher（`rehydrate` 同步完成、校验通过才 adopt），仍由新增的 `ProductProjection.isHydrationReplayActive()` 拦一道：命中 = `引用相同 && 非 hydration`。`tryBatchHydration` 内的重复测量刻意走裸 `measureWireSnapshotBytes`，不进 memo。
- **变更入口显式失效作双保险**：`ingest`/四个 seed/`rehydrate` 统一 `invalidateWireSnapshotMeasureMemo()`。即便未来出现绕过替换语义的原地变更，也不会读到旧字节。

### D2 · 准入测量 = memo 基线 + queue item 的**精确**增量

- 候选快照只比基线多一个 queue item（`{...snapshot, queue: {...snapshot.queue, items: [...items, queueItem]}}`），键序与其余字段逐字节不变，rows 与 frame 头完全一致——wire JSON 唯一差异是 `items` 数组尾部多出 `[,]<queueItem>`。于是：

  ```
  候选字节 = 基线字节 + (原 items 非空 ? 1 : 0) + UTF8(JSON.stringify(queueItem))
  ```

  JSON 转义与上下文无关，该等式是**精确值**而非估算（对拍测试钉住）。
- **不复用 `wireSnapshotBytesUpperBound` 当基线**：它是保守上界（streaming 分支 `+= utf8(append)+64` 等），会高估，拿它推准入值会把本来能通过的输入误拒。memo 只存精确测量。
- **ingest 精确分支回填 memo**：非 streaming、非 dwf 的事件本来就走全量 `measureWireSnapshotBytes(候选快照)`，accept 通过即 adopt——顺势回填，让紧随其后的准入零成本命中；超限被拒时该引用不会成为当前值，按引用判据自然失效。
- 队列项自身仍逐条 stringify，但成本是 O(单条输入) 而非 O(整份快照)，且走 `jsonUtf8ByteLength`（`Buffer.byteLength`，不落 Uint8Array；与 `utf8JsonByteLength` 逐字节等价）。
- 「按变更行重算的真增量测量」本轮**不做**（事件侧已有上界快速路径，准入侧 memo 已把每命令成本降到 O(队列项)），记入遗留。

### D3 · QueueItem 构造抽为模块级函数 `buildInputAdmissionQueueItem`

生产唯一调用方是测量方法；导出供测试用同一份 item 做「整份重算」对拍——item 构造不是被测假设，被测的是 memo + 增量公式，共享构造器不削弱独立性（对拍的帧构造在测试里从零重写）。

## 行为

状态与事件顺序（memo 的唯一所有者是 `ConversationTopicPublisher`）：

```
事件 ingest ─▶ invalidate memo ─┬─ 精确分支：全量测量候选快照 ─▶ 回填 memo（同一引用）
                               ├─ streaming/dwf 分支：只维护上界 ─▶ memo 保持失效
seed* / rehydrate ─▶ invalidate memo ─▶ 立即全量重测（wireSnapshotBytesUpperBound 口径不变）

输入准入 measureInputAdmissionProjectionBytes
  ├─ 基线：引用相同 && 非 hydration → 命中 memo（O(1)）；否则全量测一次并缓存
  └─ 增量：+（items 非空 ? 1 逗号 : 0）+ UTF8(JSON(queueItem))   ← 每命令 O(单条输入)
```

- 同一 snapshot 版本内多次准入测量：值恒定，且不发生整份帧序列化（构造期或最近一次事件精确分支完成首测）。
- snapshot 换代（事件推进 / seed / rehydrate）后的第一次准入测量全量重测一次，值 = 整份候选快照重算；其后再次命中。
- 返回值与旧「每次整份重算」实现逐字节一致；不适用的命令类型仍返回 `null`（守卫原样搬进 `buildInputAdmissionQueueItem`）。

## 所有权与不变式

- **测量值 = 真实发送值**：memo 只允许「引用相同 && 非 hydration」命中；任何可能测少的缓存都不可接受——该值给 16MiB 逻辑帧上限判生死，测少会放行发不出去的输入。
- memo 归 `ConversationTopicPublisher` 私有，生命周期与 publisher 一致；投影 snapshot 对外只读（gateway 只读消费）。
- 失效只有两种：引用判据自然失效、变更入口显式置空。**没有**按时间/按容量的失效。
- 新增「会让投影 snapshot 变化」的 publisher 方法，必须走 `invalidateWireSnapshotMeasureMemo()`（或确保引用替换语义不被破坏）。

## 测试

`packages/bootstrap/test/wire-snapshot-measure-cache.test.ts`（node:test；用 JSON.stringify 探针统计整份 snapshot 帧的序列化次数）：

1. 同一版本命中：构造后连续两次准入测量都不再全量序列化、值稳定，且与整份重算逐字节一致；非输入命令仍返回 `null`。
2. 版本变更失效：`TurnSteerQueued` 入队一条消息（snapshot 换代，且 queue.items 从空变非空，覆盖逗号分支）后测量发生全量重测、值大于旧值、与整份重算一致；版本再次稳定后复测命中。

运行：`cd apps/zcode-cli && node --import tsx --test "packages/bootstrap/test/*.test.ts"`。

## 遗留

- **按变更行重算的真增量测量未做**：本轮用「版本 memo + 队列项增量」达到同量级收益（每命令 O(单条输入)）；若未来准入测量的候选不再只是「追加一个 queue item」（例如候选还要改 rows），增量公式需要重估，届时再评估按行重算。
- `wireSnapshotBytesUpperBound`（上界口径）与 memo（精确口径）并存：streaming/dwf 分支仍只维护上界，未统一成单一精确值——两者用途不同（闸门推进 vs 准入判定），统一属另立任务。
- 若未来出现「投影原地变更且不经 publisher 变更入口」的路径，引用判据会失守；已知路径（hydration）有 `isHydrationReplayActive` 拦截，新增变更入口必须调失效方法。
