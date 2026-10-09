# 会话信箱（mailbox）已归档信封的手动清理（spec）

涉及包：`packages/services`（主责：storage 清理器与 mailbox 落盘）、`packages/shared`
（`STORAGE_CATEGORY_IDS` 类别枚举）、`packages/ui`（资源管理器存储页文案与图标）。
mailbox 落盘结构与根解析的既有 spec 见 `session-mailbox-root.md`。

## 背景与问题

信箱信封按 `<身份数据根>/mailbox/<sessionId>/{unread,read,failed}/` 一消息一文件存放
（写入方为 CLI `adapters/mailbox` 与 Host `sessionMailboxStore`，规则单源在 `@zcode/shared`）。

审计结论（2026-10-09）：

1. **全仓没有删除 `read/`、`failed/` 的路径。** adapters 与 Host 的 `unlink` 只用于两处：
   实时投递命中后消费 `unread/` 里的单封、写入失败时的临时文件回滚。`read/`（drain 后的
   归档）与 `failed/`（坏档死信）只进不出，随每条已投递消息无限累积。
2. **存储清理器结构上绕开 mailbox。** 清理器的可达范围由
   `storageCatalog.ts` 的类别规则 + `CLEANABILITY` 决定：`mailbox` 前缀归 `config` 类别、
   `CLEANABILITY.config = "none"`，`getStorageCleanScopes("config")` 返回空、
   `planStorageClean` 对 `none` 类别直接返回空计划——两层都拿不到它。
   （任务初始描述称 `mailbox` 在 `PROTECTED_BASENAMES` 里；实际不在，`PROTECTED_BASENAMES`
   只含启动引导文件与凭据。真正挡住它的是 config 前缀 + cleanability=none，本 spec 以实测机制为准。）
3. 扫描统计走同一个 `classifyStoragePath`，因此 `read/`、`failed/` 此前一直计入 `config` 类别，
   资源管理器无法单独展示这块占用。

## 设计决策

- **新增类别 `sessionMailbox`，cleanability = `safe`。** 对齐 `subagentTranscripts` 先例：
  无需二次确认、用户在资源管理器点「清理」即删（`safe` 在 UI 不弹确认框，`confirm` 才弹）。
- **只覆盖 `mailbox/*/read/` 与 `mailbox/*/failed/`，`unread/` 永不清。** 未投递信封是活数据
  （drain 与实时投递都要读它），删除等于丢消息。实现上用**文件级规则**
  （`/^mailbox\/[^/]+\/(?:read|failed)\/[^/]+$/`，单层信封文件）精确圈定，`PREFIX_RULES` 里
  `sessionMailbox` 留空——不把 `mailbox` 从 config 前缀整体摘走，`unread/` 与结构外残留仍归
  `config`（cleanability=none），被分类过滤与 none 门禁双重挡住。
- **不做 TTL / 自动保留期。** 用户决策（2026-10-09）：要的是「有清理路径」——手动、显式触发；
  与「归档保留时长」那类自动清理不同类，本 spec 不引入任何时间条件
  （对比：`logs` 清当天保留、`subagentTranscripts` 24h 活动窗口，本类别无对应分支）。
- **删除逐文件执行，单文件失败不阻断整体。** 复用既有 `fsCleaner`：有界并发逐文件 `rm`，
  失败进 `failures[]` 继续删其余（与坏档逐文件隔离同一理念）；删完后自底向上清理空目录，
  但保留类别顶层 `mailbox/`（写入方 `mkdir recursive` 可随时重建会话目录，不必保留）。
  Windows 上 `readdir`/`rm` 的大目录性能由既有 `walkStorageRoot`（有界并发、让出事件循环）承担。

## 行为

| 环节     | 位置                                                      | 行为                                                                                                                                                 |
| -------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 分类     | `storage/domain/storageCatalog.ts` FILE_RULES             | `mailbox/<sid>/{read,failed}/<file>` → `sessionMailbox`；`unread/`、更深嵌套 → `config`（不可清）                                                    |
| 扫描统计 | `storage/domain/usageAggregate.ts`                        | 同一分类函数，`sessionMailbox` 单列 bytes/fileCount/entries（按 `mailbox/<sid>/<kind>` 聚合）                                                        |
| 清理范围 | `getStorageCleanScopes("sessionMailbox")`                 | `[{ prefix: "mailbox", recursive: true }]`，递归枚举后由计划的分类过滤剔除 unread                                                                    |
| 清理计划 | `storage/domain/cleanPlan.ts`                             | 无类别专属分支：分类一致 + 非保护路径即目标；无时间过滤                                                                                              |
| 清理执行 | `storage/app/storageService.clean` + `adapters/fsCleaner` | 逐文件删除，失败记入 `failures` 不阻断；空目录清理保留 `mailbox/` 顶层                                                                               |
| UI       | `packages/ui` 存储页                                      | 类别动态渲染：新增图标（Mail）与 `resourceManager.storage.category.sessionMailbox` / `.categoryDescription.sessionMailbox` 中英文案；`safe` 直接可清 |

### 部分失败语义

- 计划里的单个文件删除失败（ENOENT / EPERM / EACCES …）只计入 `failures`，其余照删；
  UI 按既有 `cleanPartial` 提示「已释放 X，N 项未能删除」。
- 与 drain / `restoreToUnread` 的并发竞争不产生数据损坏：rename 与 unlink 都是原子单文件操作，
  清理方删晚了得到 ENOENT（记失败），回滚方发现 `read/` 副本缺失会按内存重写（adapters 既有语义）。

## 所有权与不变式

- **不变式：`unread/` 绝不被清理器触达。** 由三重结构保证，任何一层都不得单独移除：
  1. 文件规则不匹配 `unread/` 路径（分类仍是 `config`）；
  2. `sessionMailbox` 清理计划按分类过滤，非本类别候选剔除；
  3. `config` cleanability 为 `none`，任何清理请求对它直接拒绝。
- 类别枚举的唯一事实源是 `@zcode/shared` 的 `STORAGE_CATEGORY_IDS`；
  `CLEANABILITY`、`PREFIX_RULES`、UI 图标表都是穷尽映射，新增类别由类型检查强制同步。
- `mailbox` 前缀继续归 `config`，不得为清理方便整体挪入 `sessionMailbox`。

## 失败语义

- 清理目标为空（无 mailbox 或无已归档信封）：返回 `deletedCount = 0`，UI 提示「没有可清理的内容」，不算错误。
- 根目录不存在：枚举返回空（`walkStorageRoot` 的 `missingRoot` 语义），同上。
- 单文件删除失败：进 `failures`，不回滚已删部分（手动清理是幂等的重复操作，无需事务）。

## 迁移边界

- 不迁移、不改写任何信箱文件的位置与内容；本改动只新增一条删除路径与统计分类。
- 旧版落在 `~/.zcode/mailbox` 的信封（见 `session-mailbox-root.md` 的迁移边界）不在数据根内，
  扫描与清理都覆盖不到，维持「不自动搬运」。

## 遗留

- **不做自动过期**：若未来要「归档保留时长」，应作为独立决策另开 spec（本 spec 明确排除）。
- `failed/` 死信目前没有独立的诊断查看入口，只能在资源管理器里看大小与在文件管理器中定位；
  如需排查坏档内容，暂需手工打开文件。

## 验证

- `packages/services/test/storageSessionMailboxClean.test.ts`：
  分类（read/failed → sessionMailbox、unread → config）、清理范围、计划包含 read/failed
  不含 unread、真实文件系统清理后 unread 完好、单文件失败不阻断、大小统计、既有类别回归。
- 手工入口：`node --import tsx --test packages/services/test/storageSessionMailboxClean.test.ts`。
