# 冷打开：窗口优先 + 后台补全

涉及包：`bootstrap`（主责）、`adapters`（session store）。消费方：`packages/ui`（v4 conversation 订阅）。

## 背景与问题

桌面/网页打开一个**未常驻**的历史会话（CLI 侧 record 已被 `SessionResidentPool` 回收，或首次订阅）会走冷恢复路径：

`v4 subscribe` → `V4Gateway.ensureColdReadyPublisher` → `ColdSessionResumeCoordinator.ensureResumed` → `resumePersistedSession` → `activateSessionForResume`（`readPersistedSessionMessages` **全量读**）→ `hydratePublisher` → `performHydration` → `loadPersistedEvents` / `loadPersistedConversationMaterialization`（**构建完整投影**）。

问题：**为了显示首屏（wire snapshot 只发尾部 `snapshotTailWindowRows = 60` 行），却读了整个会话的全部 message+part 并激活了整个 runtime。**

实测（本机最大会话 36MB / 13979 条 part，本地热缓存）：

| 读法 | 耗时 |
| --- | --- |
| 当前全量读（含读 `data` 大 JSON + `ORDER BY ... sequence is null` 临时 B-tree 排序） | 266 ms |
| 全量读但不排序 | 215 ms |
| 只取排序键、不读 `data` | 56 ms |
| 只读尾部窗口（60 条消息 / 217 part / 289KB） | 10 ms |

结论：读 `data` 是大头（约 160ms），排序只占约 50ms；**只读窗口可省 25 倍以上**。WSL 远程工作区（库 6GB+，跨 VM 文件 IO）差距更大，是「切换对话一直加载中」的直接来源。host 侧订阅 RPC 实测合入 v3.15.1 后 p90 由 101ms 涨到 947ms。

## 设计决策

**保留「打开会话会激活 runtime」的语义**（模型上下文完整、翻页/导航完整），只把**首帧**从「等完整激活」提前为「先给窗口投影」。

1. **窗口态投影（partial projection）**：publisher 增加 `rowsIncomplete` 概念。冷打开时先只灌入**尾部窗口**的行，`rowsComplete = false`。
2. **首帧立刻下发**：`getWireSnapshot` 已是窗口 + 全序元信息口径（`conversation-topic-publisher.ts` 的 `getWireSnapshotForProfile`），窗口态下 `totalCount` 必须取自 store 轻量查询而非 `visibleRows.length`。
3. **后台补全**：activation（全量读 + `app.resume`）继续执行，但**不再阻塞 subscribe 的 ACK/首帧**；完成后用完整投影**原子替换**（`rowsComplete = true`）并推送 snapshot。
4. **窗口态是纯预览，不提供更早历史**（见 §A 修订）：窗口态阶段 `rows.firstRowId` = 实际下发窗口的首行，客户端 `hasOlderRows` 恒为 false，`rowsRange` 不会在窗口态被调用（也就不存在「翻出来的行随后被补全替换掉」）。更早历史一律由补全后的权威投影供给。
5. **config 种子降级**：首帧 config（模型/权限模式）从**持久化 session 记录**读（`session` 表已落库字段）；activation 完成后用 `getSessionConfigSeed`（runtime 真值）覆盖。

### 不做的事（本轮边界）

- 不改协议 schema（wire 语义不变）。
- 不改 `app.resume` 的模型上下文语义（仍然全量恢复，只是不阻塞首帧）。
- 第 1 项「去 `ORDER BY ... sequence is null` 临时 B-tree」**不做**：实测仅约 50ms，且需新建表达式索引并在 GB 级库上迁移，性价比不足。

## 行为与所有权

- **投影所有权**：publisher 仍是唯一投影所有者；`rowsIncomplete` 是其内部状态，不外泄到 wire。
- **不变式**：
  - 窗口态下 `rows.window` 是全会话行的**尾部子集**且在**负数行号空间**（见 §A），`totalCount` 是 store 口径的会话消息总数；`firstRowId` 恒等于实际下发窗口的首行 ⇒ 客户端 `hasOlderRows = window[0].rowId > firstRowId` 为 **false**。
  - 补全替换必须原子（一次 snapshot 整体替换），不产生中间态；替换后 `rowsIncomplete = false` 且投影与「全量重放」一致（保持现有 `getRowsRange` 的「与全量重放前缀逐字节一致」契约）。
  - 窗口态→完整态之间到达的 online delta 帧不得丢失（沿用现有 flush 管线）。
  - 客户端侧：行身份空间在**同一会话内**从窗口态翻转成权威态时，虚拟列表必须整份作废旧空间派生状态并按 turn key 重锚定（见 §B）。
- **失败语义**：后台 activation 失败时，窗口投影保持可用（不回落 error）；沿用现有 `error`+`retry()` 入口暴露补全失败，但不打断已显示的首屏。

## 迁移边界

- 老会话（无 `sequence` 列的 part）与 fork/子会话（detached live）走既有路径不变。
- `rowsIncomplete === false` 的 warm 会话完全走旧路径，行为零变化。

## 验收场景

- A1 冷打开大会话：首帧延迟显著低于现状（目标本地 <300ms 量级），且 UI 无闪烁/无重复行。
- A2 窗口态不提供更早历史：首帧 `firstRowId` = 窗口首行（`hasOlderRows` 为 false），客户端不自动补拉、不显示「还有更早」；此后用户上翻的需求由补全后的权威投影满足。
- A3 补全完成后翻页/问题导航/计划目录均与「一直 warm」的会话一致；翻转当场不发生可见滚动跳变。
- A4 首帧 config（模型/权限）显示正确（来自持久化），补全后被 runtime 真值覆盖无跳变。
- A5 后台 activation 失败时首屏仍可见，错误入口可重试。
- A6 既有 v4 订阅/recovery/rows-range 测试全绿。

## 实现说明与偏差（2026-10 二轮：纯预览 + 翻转重锚定）

二轮修订了首轮的两处落地并删除了随之不可达的分页路径。以下按新语义记录。

### §A 窗口态 = 纯预览（行号负数空间 + firstRowId = 窗口首行）

- 首轮曾让窗口行沿用投影局部行号（1..k），并把 `firstRowId` 设成全序哨兵
  `-(消息总数 × STRIDE)`，使客户端判定「还有更早行」，再用按 store 分页的 `rowsRange`
  逐窗补拉（负数行号）。**这条路径在本轮整体删除**：窗口态首 turn 按定义就是被 tail 截断的，
  UI 的 `shouldAutoLoadIncompleteLeadingTurn`（`packages/ui/src/v4/conversationProjectionStore.ts`）
  因此一拿到首帧就自动补拉，逐窗连续进行，而补全的 snapshot 是整体替换——用户**没有滚动**
  也会看着自己刚看到的历史整批消失、行号空间从负数翻到全序。
- 现在：**首帧行号改写成负数空间**（`assignColdWindowRowIds` 应用到首帧窗口，公式与判据见
  `cold-window-rows.ts`），`markRowsIncomplete({ totalCount, rows })` 直接带上这份行列表；
  publisher 在**打帧边界**按实际下发的窗口（profile 过滤 + tail 60 截断之后）现算
  `firstRowId`，因此任何订阅者看到的都是 `hasOlderRows === false`。
  - 负数空间同时承担「识别标记」职责：客户端 `isColdWindowRowSpace`（见 §B）只凭行窗口
    首行为负数即可判定窗口态；权威全序行永远为正数。
  - 行上的 `actions` 一律清空：窗口态行号是临时代数，命令目标在补全后按全序行号重新解析。
- 由此删除的路径（全部不可达）：
  - gateway：`readColdWindowOlderRows` / `projectColdWindowRows` / `rowsRangePublisher`
    与 `rowsRange` 的窗口态分支（`rowsRange` 回到「等完整 READY / 冷恢复」的既有语义）；
  - host 钩子 `readMessagePageBefore`（`v4-bridge.ts`）；
  - store：`SessionStorePort.messagePageBefore` 与 adapters 实现（`messageWindow` 保留；
    其游标分支一并删除，`messageSlice` 不再是共享入口）；
  - `cold-window-rows.ts` 的哨兵/回序函数（`coldWindowFirstRowId` / `coldWindowOrdinalOfRow` /
    分页页常量）；
  - UI/gateway 侧不再需要「窗口态翻页」的任何兜底。

### §B 行身份空间翻转的客户端处理

- 判定与重锚定抽成纯函数模块 `packages/ui/src/v4/conversationRowIdentitySpace.ts`
  （`isColdWindowRowSpace` / `didRowIdentitySpaceFlip` / `resolveRowSpaceFlipScrollTop`），
  node:test 用例在 `packages/ui/test/v4ConversationRowIdentitySpace.test.ts`；
  组件级回归在 `packages/ui/test/v4ConversationTimelineColdWindowRowSpaceFlip.test.ts`
  （窗口态 → 权威态的翻转重锚定、锚 turn 缺席时回贴底；去掉翻转处理即失败）。
- `ConversationTimeline`（`packages/ui/src/v4/ConversationTimeline.tsx`）在**同一会话内**的行
  身份空间翻转时执行与 `sessionKey` 切换同规的清理：清 turnId 测高缓存、重置
  `prependAnchorRef` / `pendingPrependVirtualAnchorRef`、`virtualizer.measure()`；随后按
  **翻转前视口顶部 unit 的 turn key（turnId）**重锚定：`scrollTop = 新 measurement.start −
  翻转前视口内偏移`；该 key 在权威尾窗里不存在时回到「打开会话」的贴底语义。
  - 基线（行空间 + 视口顶部锚点）在**每 commit 末**与**每次 scroll 事件**记录，翻转 commit
    只读取上一个 commit 的基线，避免用新空间的行起点做锚。
  - 用户已在窗口态里滚出自己的位置（`userAdjustedScrollSinceRestoreRef`）时，翻转会撤掉
    尚未落地的会话滚动记忆恢复（`pendingDetachedScrollRestoreRef`），否则该恢复会把用户
    拽回打开时的旧坐标；未调整滚动时保留既有语义（回到上次阅读位置）。
- 为什么必须有这一步：turnId 键控的测高缓存、prepend 锚点基线与 virtualizer
  measurementsCache 都带着窗口态的量继续用，prepend 补偿
  （`timelineScrollAnchor.ts` 的 `prependVirtualAnchorAdjustment`）会按错误的行起点算出错误
  平移，表现为「上翻几下视口突然窜到很上面」。

### 落地结构

- store（`adapters`）：`messageWindow({sessionID, limit})`，元信息走 `count/min/sum` 聚合
  （不读 `data`），正文按 `(session_id, sequence)` 索引倒序取 `limit + 1` 条判 `hasOlder`，
  part 用同索引子查询按页取。返回 `SessionMessageSlice`
  （messages + 对齐 sequences + totalCount + firstSequence + hasOlder + legacySequence）。
- host 钩子（`v4-bridge`）：`readMessageWindow` / `synthesizeTranscriptEvents`
  （= `mergeColdConversationEvents`，无内存事件）/ `getPersistedSessionConfigSeed`。
- publisher：`markRowsIncomplete({ totalCount, rows })` / `markRowsComplete()` /
  `isRowsIncomplete()`；窗口态打帧取 `rowsWindowMeta.rows`，`firstRowId` 与截断后的窗口同源。
- gateway：`ensureColdOpenPublisher`（窗口态单飞，返回可订阅的 publisher）与既有 `readyFlights`
  （完整 READY，command/query/rowsRange 仍等它）；补全复用同一 publisher 实例的 `rehydrate`，
  完成时 `markRowsComplete()` 并由现有 flush 推一份完整 snapshot（客户端 snapshot 帧语义 =
  整份替换，因此替换天然原子）。行号换算集中在 `cold-window-rows.ts`。

### 首轮保留的偏差与取舍

1. **只在 `hasOlder === true` 时启用窗口态**。窗口覆盖整个会话时全量读本来就便宜，而窗口投影缺
   activation 才有的内存事实（queue / 权限面 / usage 水位 / runtime config 真值）：对中小会话窗口优先
   反而更差。该判据把现有中小会话测试与行为留在原路径上（A6 的稳定性来源）。
2. **`rows.totalCount` 是近似**：真实全序行数只在全量重放后才知道（行数 ≠ 消息数，且需读 `data`）。
   窗口态取 `max(store 消息总数, 投影已可见行数)`——只会小于真实行数，但绝不会小于已可见行数；
   `totalCount` 的现有消费方只有滚动条估计与「内容是否不足一屏」。补全后恢复为精确行数。
3. **回滚（`session.revert`）过的会话不做窗口读**：活动分支 = kept 前缀 + cut 之后的消息，
   已不是规范尾部的连续子集（中间的旧分支被排除）。钩子直接返回 null → 回退既有全量路径。
4. **首帧 `config.thoughtLevels` 为空**：档位表来自当前 provider registry，只有 app 实例能列举，
   activation 前拿不到；留空由补全后的 runtime 种子补齐（模型/模式/thought 三项仍来自持久化事实，
   补全后与 runtime 真值一致，无跳变）。**这是唯一一处用户可见的首帧降级，需要产品侧确认是否接受**。
5. **旧库（`legacySequence`）/ 旧宿主（缺钩子）整体回退**既有完整路径；`performHydration` 的
   「保留健康 live publisher」早退分支增加 `!coldWindowSessions.has(sessionId)` 守卫，
   否则窗口投影会被当成健康 live publisher 永久保留。
