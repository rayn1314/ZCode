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

1. **窗口态投影（partial projection）**：publisher 增加 `rowsComplete` 概念。冷打开时先只灌入**尾部窗口**的行，`rows.window` = 窗口行，`rows.firstRowId` = 窗口首行（正确），`rows.totalCount` = **store 的真实全序行数**（见下），`rowsComplete = false`。
2. **首帧立刻下发**：`getWireSnapshot` 已是窗口 + 全序元信息口径（`conversation-topic-publisher.ts:410`），窗口态下 `totalCount` 必须取自 store 轻量查询而非 `visibleRows.length`（`conversation-topic-publisher.ts:429` 需改）。
3. **后台补全**：activation（全量读 + `app.resume`）继续执行，但**不再阻塞 subscribe 的 ACK/首帧**；完成后用完整投影**原子替换**（`rowsComplete = true`）并推送 snapshot。
4. **`getRowsRange` 双数据源**：`rowsComplete === false` 时**从 session store 分页读**（新钩子，走索引），不再依赖「投影全量行」；`rowsComplete === true` 时保留现有投影切片路径。两条路径返回的行必须可用 `rowId` 对齐（前缀一致）。
5. **config 种子降级**：首帧 config（模型/权限模式）从**持久化 session 记录**读（`session` 表已落库字段）；activation 完成后用 `getSessionConfigSeed`（runtime 真值）覆盖。

### 不做的事（本轮边界）

- 不改协议 schema（wire 语义不变）。
- 不改 `app.resume` 的模型上下文语义（仍然全量恢复，只是不阻塞首帧）。
- 第 1 项「去 `ORDER BY ... sequence is null` 临时 B-tree」**不做**：实测仅约 50ms，且需新建表达式索引并在 GB 级库上迁移，性价比不足。

## 行为与所有权

- **投影所有权**：publisher 仍是唯一投影所有者；`rowsComplete` 是其内部状态，不外泄到 wire。
- **不变式**：
  - 窗口态下 `rows.window` 是全会话行的**尾部子集**，`firstRowId` 指向窗口首行，`totalCount` 是全会话行数；三者共同保证 renderer 的 `hasOlderRows` 判定正确。
  - 补全替换必须原子（一次 snapshot 整体替换），不产生中间态；替换后 `rowsComplete = true` 且投影与「全量重放」一致（保持现有 `rowsRange` 的「与全量重放前缀逐字节一致」契约）。
  - 窗口态→完整态之间到达的 online delta 帧不得丢失（沿用现有 flush 管线）。
- **失败语义**：后台 activation 失败时，窗口投影保持可用（不回落 error）；沿用现有 `error`+`retry()` 入口暴露补全失败，但不打断已显示的首屏。

## 迁移边界

- 老会话（无 `sequence` 列的 part）与 fork/子会话（detached live）走既有路径不变。
- `rowsComplete === true` 的 warm 会话完全走旧路径，行为零变化。

## 验收场景

- A1 冷打开大会话：首帧延迟显著低于现状（目标本地 <300ms 量级），且 UI 无闪烁/无重复行。
- A2 窗口态下向上翻页（`rowsRange`）返回更早行且与完整态一致。
- A3 补全完成后翻页/问题导航/计划目录均与「一直 warm」的会话一致。
- A4 首帧 config（模型/权限）显示正确（来自持久化），补全后被 runtime 真值覆盖无跳变。
- A5 后台 activation 失败时首屏仍可见，错误入口可重试。
- A6 既有 v4 订阅/recovery/rows-range 测试全绿。

## 实现说明与偏差（本轮落地，2026-10）

以下为实现时对上面决策的收敛与不得不做的取舍，验收仍按 A1–A6 判定。

**落地结构**

- store（`adapters`）：`messageWindow({sessionID, limit})` / `messagePageBefore({sessionID, beforeSequence?, limit})`，
  共用一条读路径：元信息走 `count/min/sum` 聚合（不读 `data`），正文按 `(session_id, sequence)` 索引倒序
  取 `limit + 1` 条判 `hasOlder`，part 用同索引子查询按页取。返回 `SessionMessageSlice`
  （messages + 对齐 sequences + totalCount + firstSequence + hasOlder + legacySequence）。
- host 钩子（`v4-bridge`）：`readMessageWindow` / `readMessagePageBefore` / `synthesizeTranscriptEvents`
  （= `mergeColdConversationEvents`，无内存事件）/ `getPersistedSessionConfigSeed`。
- publisher：`rowsWindowMeta`（`markRowsIncomplete` / `markRowsComplete` / `isRowsIncomplete`）+
  `readRowsRange(params, profile, readOlderRows?)` 双数据源入口；`getRowsRange` 原样保留为完整态路径。
- gateway：`ensureColdOpenPublisher`（窗口态单飞，返回可订阅的 publisher）与既有 `readyFlights`
  （完整 READY，command/query 仍等它）；补全复用同一 publisher 实例的 `rehydrate`，
  完成时 `markRowsComplete()` 并由现有 flush 推一份完整 snapshot（客户端 snapshot 帧语义 = 整份替换，
  因此替换天然原子）。行号换算集中在 `cold-window-rows.ts`。

**偏差与取舍**

1. **只在 `hasOlder === true` 时启用窗口态**。窗口覆盖整个会话时全量读本来就便宜，而窗口投影缺
   activation 才有的内存事实（queue / 权限面 / usage 水位 / runtime config 真值）：对中小会话窗口优先
   反而更差。该判据把现有中小会话测试与行为留在原路径上（A6 的稳定性来源）。
2. **`rows.firstRowId`：决策里的「= 窗口首行」在客户端语义下不成立**。客户端
   `hasOlderRows = window[0].rowId > rows.firstRowId`（`packages/ui/src/v4/conversationProjectionStore.ts`），
   `firstRowId` 必须是**全序首行**才会在翻到顶时停手。窗口态实现为全序哨兵
   `-(会话消息总数 × STRIDE)`，并让分页行号以它为下界，因此翻到会话开头时判定自动转 false。
3. **`rows.totalCount` 是近似**：真实全序行数只在全量重放后才知道（行数 ≠ 消息数，且需读 `data`）。
   窗口态取 `max(store 消息总数, 投影已可见行数)`——只会小于真实行数，但绝不会小于已可见行数；
   `totalCount` 的现有消费方只有滚动条估计与「内容是否不足一屏」。补全后恢复为精确行数。
4. **两条 rowsRange 路径的行号空间不同（无法做成同一空间）**：投影的 dense rowId 偏移量只有在
   全量重放后才存在，部分投影无论怎么编号都无法与最终全序一致。因此窗口态的更早行使用
   「以 store 消息序号锚定」的行号（负数，见 `cold-window-rows.ts`），保证：同页升序、
   页间无缝无重叠、翻到会话开头等于哨兵；补全的 snapshot 会把行号整体换回全序（客户端整份替换，
   临时行随之丢弃并可按全序重取）。窗口态行的 `actions` 一律清空：临时行号不能作为命令目标。
5. **翻页按消息对齐（不是按行截断）**，并向更早方向补齐到「一轮的 real-user 起点」（最多
   `COLD_WINDOW_PAGE_READ_MAX_ATTEMPTS` 页）：合成口径按轮分组，页首落在轮中间会产出与全量重放
   不同构的行。按行截断则会把同一条消息的行拆到两页，客户端按 rowId 合并会出现空洞。
6. **回滚（`session.revert`）过的会话不做窗口读**：活动分支 = kept 前缀 + cut 之后的消息，
   已不是规范尾部的连续子集（中间的旧分支被排除）。钩子直接返回 null → 回退既有全量路径。
7. **首帧 `config.thoughtLevels` 为空**：档位表来自当前 provider registry，只有 app 实例能列举，
   activation 前拿不到；留空由补全后的 runtime 种子补齐（模型/模式/thought 三项仍来自持久化事实，
   补全后与 runtime 真值一致，无跳变）。**这是唯一一处用户可见的首帧降级，需要产品侧确认是否接受**。
8. **旧库（`legacySequence`）/ 旧宿主（缺钩子）整体回退**既有完整路径；`performHydration` 的
   「保留健康 live publisher」早退分支增加 `!coldWindowSessions.has(sessionId)` 守卫，
   否则窗口投影会被当成健康 live publisher 永久保留。

