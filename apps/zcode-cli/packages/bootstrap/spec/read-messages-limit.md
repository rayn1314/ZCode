# readMessages 服务端 limit 上限与 total/hasMore

涉及包：本 spec 主责 `packages/bootstrap`（`zcode-protocol/server-operations.ts` 的 `readMessages`）；协议 schema 在 `packages/shared`（`zcode-protocol/index.ts` 的 `zcodeSessionMessagesResultSchema`）同步改动；客户端 `packages/services`（`readSessionMessages` 只取 `result.messages`，行为不改）。

## 背景与问题

1. **全量读 + 无界切片**：`readMessages` 先 `readActiveSessionMessages` 取全量，再按调用方 `limit` 切片。服务端原本没有默认/最大上限：`limit` 缺省 = 整库返回，客户端传多大给多大——单次响应与客户端内存都无界。
2. **存储层仍是两表全捞**：`sessionStore.messages` 是 `SELECT *` 两表读入（`adapters/.../messages.ts`），本轮不改存储层分页（见遗留）。
3. **既有潜伏缺陷（本轮顺带修复）**：端点直接回传存储形状消息（`info.id` / `info.sessionID`），而声明的 `zcodeSessionMessagesResultSchema` 是 strict 的 wire 形状（`info.messageId` / `info.sessionId`）——声明客户端解析必然失败。该端点现网零调用方，缺陷一直未被触发。

### 调用方调查（grep 证据，2026-10-09）

| 层 | 结论 |
|---|---|
| 协议方法 `session/messages` | 全仓唯一 handler：`bootstrap/src/zcode-protocol/server.ts:603`；唯一调用点：`packages/services/src/zcode-agent/zcodeAgentService.ts:3749`（`readSessionMessages`），`limit`/`afterMessageId` 原样透传，**不传 limit 时即 undefined（旧行为 = 全量）** |
| `IZCodeSessionService.readSessionMessages` | `packages/ui`、`packages/web`、`packages/desktop` 的 src **均无调用点** |
| UI 的消息读取实际路径 | 走 `readSession` 的 `messageLimit`（实测只传 `messageLimit: 1`：`useActiveTaskSnapshotMeta.ts:70`、`SessionPane.tsx:1906`），与本操作无关 |
| harness / 其它 | 无 `session/messages` 引用 |

结论：**没有任何现网路径依赖超大 limit 或全量导出**，可安全加默认值与硬顶，无需豁免路径。

## 设计决策

### D1 · 默认 2000、硬顶 10000（常量 `SESSION_MESSAGES_DEFAULT_LIMIT` / `SESSION_MESSAGES_MAX_LIMIT`，落在 server-operations.ts）

- 默认 2000：把「不传 limit」的缺省语义从全量改为有界；量级与既有 `PROTOCOL_V4_LIMITS.eventRetentionPerSession: 2000` 的历史窗同档，覆盖长会话整段回看（现网唯一调用方本就不传 limit）。
- 硬顶 10000：调用方调查表明无现网大 limit 依赖，但 `session/messages` 是公开协议面，外部客户端可传任意正整数；10000 给未来的导出/迁移类用途留余量，同时保证单响应有界。
- 常量放服务端操作旁（策略归操作所有），schema 的 `limit` 保持「正整数、无上界」——协议层宽松、服务端钳制，与 v4 `rowsRangeMaxLimit` 的思路一致。

### D2 · 超限语义 = 最近 N 条 + `total` / `hasMore`

- 截断取 `slice(-limit)`：返回**最近的 N 条**（对话场景最新消息更重要），与旧实现的 `limit` 语义同向，只是补上缺省与硬顶。
- `total` = 本次查询候选集（应用 `afterMessageId` 之后、limit 截断之前）的条数；`hasMore` = 候选集超过 limit、更早消息未随本次响应返回。
- schema（strict）**只增不改**：新增 `total?: int >= 0`、`hasMore?: boolean`，既有 `messages` 字段不动。字段 optional，新客户端可兼容尚未返回它们的旧服务端；首方 client / server 同版本出厂，不为跨版本混部放宽 strict。
- **客户端行为不改**：`readSessionMessages` 仍只返回 `result.messages`；少返回总比 OOM 好，更早历史用 `afterMessageId` 翻页。

### D3 · 出协议走 `mapMessageWithParts`（wire 形状修复）

`messages.slice(-limit)` 后经既有 `mapMessageWithParts`（`message-mapper.ts`，与 snapshot 出协议同一条映射）转成 wire 形状。`afterMessageId` 的匹配在映射前按 `info.id` 完成（wire `messageId` 即 `String(info.id)`，游标语义不变）。

## 行为

| 入参 | 返回 messages | total | hasMore |
|---|---|---|---|
| 无 limit，候选 2500 条 | 最近 2000 条 | 2500 | true |
| `limit: 10`，候选 50 条 | 最近 10 条 | 50 | true |
| `limit: 15000`（超硬顶），候选 12000 条 | 最近 10000 条 | 12000 | true |
| `limit: 10`，候选 5 条 | 全部 5 条 | 5 | false |

- `afterMessageId` 语义不变：先按游标取候选集，再钳制 limit、取最近 N 条。
- 响应为 wire 形状（`info.messageId`/`sessionId`），通过 strict 的 `zcodeSessionMessagesResultSchema`（测试钉住）。

## 所有权与不变式

- **钳制唯一落点**是 `readMessages`；常量导出供测试断言，schema 不承担上界。
- **limit 生效边界**：有界的是「响应条数 / 序列化 / 客户端内存」；存储层全量读取不受影响（见遗留）。
- `hasMore === true` 必蕴含 `total > messages.length`；未截断时 `hasMore === false` 且 `total === messages.length`。
- `total` 指候选集而非全库：带 `afterMessageId` 时是「游标之后」的条数，客户端据此判断本段是否还有更早消息。

## 失败语义

- 无新增错误面：`limit` 非正整数仍由 `zcodeSessionMessagesParamsSchema` 拒绝（既有 parse 错误路径）；session 缺失仍抛 `sessionUnavailable`；截断不是错误，正常返回 + `hasMore: true`。

## 测试

`packages/bootstrap/test/read-messages-limit.test.ts`（node:test）：

1. 缺省 limit → 默认 2000 截断到最近 N 条（首/末条 id + total/hasMore）。
2. 显式 limit → 只回最近 limit 条。
3. 超硬顶 limit → 钳到 10000。
4. 未截断 → `hasMore: false`，响应整体通过 strict `zcodeSessionMessagesResultSchema.parse`（覆盖存储→wire 映射与新增字段）。

运行：`cd apps/zcode-cli && node --import tsx --test "packages/bootstrap/test/*.test.ts"`。

## 遗留

- **存储层分页未做（本轮明确不做）**：`sessionStore.messages` 仍两表 `SELECT *` 全捞，默认/硬顶只把**响应面**变有界，不省 DB 读与投影内存；按 `beforeId`/keyset 的存储层分页改造面大（涉及 adapters + 投影裁剪），另立任务。
- **snapshot 路径同样全量读后切片**：`readSession`（`snapshotWithDiagnostics` 的 `persistedMessages` 相）走同一 `readActiveSessionMessages` + `messageLimit` 切片，本轮未动；UI 实测只传 `messageLimit: 1` 仍全量读——与上面同根因，宜随存储层分页一并处理。
- `readMessages` 的 file part 不做 artifact data URL 回填（snapshot 有 `hydrateSnapshotFilePartUrl`）：若该端点将来用于直接渲染图片附件，需要补同样的回填。
- `hasMore: true` 时更早消息依赖 `afterMessageId` 翻页取回；当前客户端无翻页调用（调用方调查见上），翻页体验属未来工作。
