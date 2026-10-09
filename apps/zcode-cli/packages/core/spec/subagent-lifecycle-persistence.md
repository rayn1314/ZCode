# 子代理生命周期持久化的增量读写（subagent lifecycle persistence）

涉及包：`core`（本 spec 主责，`src/runtime/methods/subagent-lifecycle-persistence.ts`）、`contracts`（`SessionStorePort.sessionEntry?` 新增可选方法）、`adapters`（`session-entries.ts` 单行读仓储 + `SqliteSessionStore.sessionEntry` 实现）。读侧 `bootstrap` 的 `subagent-roster.ts` 不改。

与既有 spec 的关系：数据源、id 形状、状态语义仍由 `subagent-session-messaging.md` 的 **D8** 定义（`runtime/subagent_lifecycle` entry、id = `subagent-lifecycle:<agentId>`、spawn 建行 stop 收口）。本文只回答一个问题：**这条「每事件读一条→改一条」的路径怎么读、怎么写才不随事件数退化**。

## 背景与问题

`persistDurableSessionEvent` 在每条 `SubagentSpawned` / `SubagentStopped` 事件上（`events.ts` 的持久化分支）调用 `persistSubagentLifecycleEntry`。旧实现两步都做全量：

1. 读：`sessionEntries({ sessionID, type })` 把该 session 该类型的**全部**行取回来，再 `find` 出目标 id；
2. 写：`saveSessionEntry(entry)` 覆写那一行。

行数由稳定 id 保证 = 派过的子代理数，不随事件增长；但**读放大**是 O(事件数 × 条目数)：一个派过几十个子代理、事件上百条的会话，每条事件都把该类型的所有行从 SQLite 搬回 JS 再丢掉 99%。而这两步是同步 `DatabaseSync` 往返，且发生在 `appendEvent` 的关键路径上（每条事件 `await persistDurableSessionEvent`），读放大直接叠进事件落盘延迟。

关键点：`sessionEntries` 的返回里，除了目标行，其余行**不提供任何这条路径需要的信息**——`buildSubagentLifecycleEntry` 只读 `existing`（同一 agentId 的那一行）。全量读没有信息价值，只有成本。

## 设计决策

- **读侧：单行读，命中 `session_entry.id` 主键。** 新增 `SessionStorePort.sessionEntry?({ sessionID, id, type })`，实现在 `session-entries.ts`（与 `sessionEntries` 同一仓储文件）：`where id = ? and session_id = ? and type = ?`，`id` 是主键 → O(1)。`session_id` / `type` 是**语义护栏**而非索引：主键命中但不属于本 session/type 的行（理论上的跨 session 同 id）一律返回 `null`，不把别人的行读成本行。
- **写侧：不新增 API，沿用 `saveSessionEntry` 的单语句 upsert。** `on conflict(id) do update` 就是「不存在则 insert、存在则覆写同一行」的原生形状，且 conflict 分支**不更新 `time_created`**，只推进 `time_updated`/`data`——与「created 必须是首次 spawn 时刻」天然一致，等于双保险。
- **为什么不能砍掉那次读（纯 blind upsert）**：`stop` 事件不带创建时间，必须沿用旧行的 `created`/`startedAt`，并回填 `agentType`/`description`/`background`/`childSessionId`（`buildSubagentLifecycleEntry` 约束 b）。这条「先读再判」的逻辑保留在 core 的纯函数里，不把业务规则下沉到存储层；能砍掉的只是**读的范围**（全量 → 单行）。
- **正确性论证：单行 upsert 与「全量读→find→写」结果等价。** 两者唯一的差别是读的候选集；`find` 的谓词（`entry.id === entryId`）在单行读里被下推成 SQL 的 `id = ?`。同一事件序列下写入的行内容、行数、时间戳完全一致，幂等性也不变（重复 spawn/stop 落同一主键行，行数不增）。
- **并发论证**：同一行的 read-modify-write 依赖「事件汇按会话串行 await」——`appendEvent` 内 `await persistDurableSessionEvent`，同一 session 的生命周期事件顺序执行，同一 agentId 不会出现两组读写交叠。不同 agentId 是不同主键行，跨子代理并发（spawn/stop 交错、stop 并发）天然隔离，单行读不引入新的竞争面，也不新增事务。
- **老宿主兼容**：方法声明为可选，与同族的 `saveSessionEntry?`/`sessionEntries?` 一致；core 侧未实现单行读时回退 `sessionEntries`（结果等价，只多花读），不因为新方法缺席而丢持久化。
- **同根因一并处理**：`sqlite-session-store.ts` 里 fork 路径两处「全量读 `v4/command_fact` 再 find 目标行」改用同一单行读——同一文件、同一主键、同一护栏，语义等价。

## 行为

- 每条 `SubagentSpawned` / `SubagentStopped`：恰好一次单行读 + 至多一次 upsert。
- spawn（含 resume 复活）建行/覆写并清掉旧终态；stop 覆写同一行写入 `endedAt`，保留 `created`/`startedAt`。
- stop 无对应 spawn 行（单行读返回空）→ 不写行，与旧行为一致。
- 读侧 `subagent-roster.ts` 消费的 entry 形状不变。

## 所有权与不变式

- **行数 = 子代理数**：某 session 的 `runtime/subagent_lifecycle` 行数 = 它派发过的 distinct `agentId` 数，不随事件数增长。
- **事件 ↔ 行一一对应**：一个 `agentId` 恰好一行（id `subagent-lifecycle:<agentId>`），spawn/stop 反复落在同一行；事件是「追加的」，行是「覆写的」。
- **读放大有界**：每条生命周期事件 ≤ 1 次读、≤ 1 次写，代价不随该 session 的条目数变化（旧实现是 O(事件数 × 条目数)）。
- **唯一写者**：entry 的写入者只有 core 的 `persistSubagentLifecycleEntry`；roster 端口只读、不回写。
- **主键全局唯一**是既有前提：两个 session 复用同一 `agentId` 时 upsert 会把行交给后写者（本轮不改该前提）；单行读的 `sessionID` 护栏保证读侧不跨会话串行。

## 失败语义

- 读失败 → warn `subagent_lifecycle.persist_failed`，本条事件不落行（spawn 与 stop 同语义）。stop 因此停留在 spawn 态，roster 按「只有 spawn 没有终态 → `lost`」如实呈现，不谎报 `running`。
- 写失败 → 同一条 warn，不上抛，不打断子代理生命周期；upsert 是单语句，要么整行更新要么不动，不产生半行。
- 与旧实现一致：失败只降级为 warn，因为列表是辅助能力。

## 迁移边界与遗留

- 无 schema 迁移、无数据迁移：复用现有 `session_entry` 表、主键与 `session_entry_session_type_idx`；历史行照常被单行读命中。
- 读侧 roster 不改；`subagent-session-messaging.md` D8 的结论不改。
- 测试：`packages/core/test/subagent-lifecycle-persistence.test.ts`（纯映射 + 事件汇契约：读放大回归、两子代理交错、读写失败只 warn、旧宿主回退、原型方法接收者绑定）、`packages/adapters/test/session-entry-single-row.test.ts`（真实 SQLite：命中/护栏/upsert 不加行）。

遗留（有意不做）：

1. **回退路径保留全量读**——只服务未实现 `sessionEntry` 的旧宿主，结果等价；等单行读在所有宿主落地后可整体删除，届时连同本 spec 的兼容段一起清掉。
2. **adapters 的测试未接入默认 `pnpm test` glob**（该入口只 glob 了 `packages/core/test/*.test.ts`）——既有缺口，本轮不动测试入口，需显式跑 `node --import tsx --test "packages/adapters/test/*.test.ts"`。
