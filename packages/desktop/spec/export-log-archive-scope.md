# 日志导出的敏感面收敛（export-log-archive-scope）

> 涉及包：`packages/desktop`（主责）。

## 背景与问题

导出日志的产物是**用户会转发出去的**（提 issue、发客服）。因此既有防护按"包里不该有密钥"设计，分两层：

1. 收集阶段按路径排除（`credentials.json`、`debug`、退役 acp 目录、非日志状态目录等）；
2. 复制阶段对文本做流式脱敏（键名族 + 连接串 + Bearer + query token，且能识别 UTF-16）。

缺陷在第 2 层有一个逃逸口：编码识别失败的文件走 `copyFile` **原样复制**，脱敏被完全绕过。
而落在导出根 `{dataRoot}/v2` **顶层**的两类文件正好命中这个逃逸口：

- **crashpad dump**：`{dataRoot}/v2/crash/{live,archive}/*.dmp` 是崩溃瞬间的进程内存快照，凭据与会话正文当时在内存里就会被写进去。`crash` 不在任何排除名单里。
- **`tasks-index.sqlite`（含 `-wal` / `-shm`）**：任务索引库。现有排除表全是**目录型**规则，管不到顶层单个数据库文件。

2026-10-02 本机实测，用 `exportLogs.ts` 自身的编码识别逻辑复核（不是粗略近似）：

| 文件                                           | 识别结果      | 实际后果                                                                       |
| ---------------------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| `tasks-index.sqlite`（5.0 MB，209 条任务记录） | BINARY        | 原样 copyFile                                                                  |
| `tasks-index.sqlite-shm`                       | BINARY        | 原样 copyFile                                                                  |
| `tasks-index.sqlite-wal`（2.4 MB）             | 误判 utf-16be | 走脱敏分支，但二进制碎片无键值结构，正则匹配不到裸值，内容仍被带出（且已损坏） |
| `crash/**/*.dmp`、`crash/live/settings.dat`    | BINARY        | 原样 copyFile                                                                  |

诱因分层：官方渠道走 ARMS crashpad，`crash/` 下一直有 dump，属既有缺陷；自建版此前没有本地 dump，
是崩溃捕获修复（`ZCODE_ARMS_RUM_ENABLED` 为真才跳过本地 reporter）之后才开始落盘，把该缺陷扩大到了自建渠道。

同时发现 `isNonLogStateArchivePath` 用 `startsWith(name)` 而非 `startsWith(name + "/")`，
会把 `repo-backup`、`sessions-old` 之类目录整个丢掉——与同文件另外三个同类判断不一致。

## 设计决策

**两条规则同时落地，缺一不可：**

1. **收集阶段**：`crash` 目录与数据库文件后缀显式排除。它们是"状态"不是"日志"，与既有的
   `sessions` / `repo` / `checkpoints` 同族。
2. **复制阶段**：非文本文件从"原样复制"改为"**跳过并记录**"。这是根因修复——只要还留着
   原样复制这条路，将来任何新落进导出根的二进制都会绕过脱敏。

**不采用"给二进制做内容扫描"**：minidump 与 sqlite 的敏感内容不以键值形态存在，
现有脱敏正则的设计前提就是键值结构，扫不出来。

**路径策略抽成独立模块** `exportLogArchivePolicy.ts`：纯函数、无 IO、不依赖 electron / services，可单测；
`exportLogs.ts` 只保留 IO 与脱敏，不再内联路径判断。

**顺带修前缀边界缺陷**，让四个同类判断一致。

## 行为

- `NON_LOG_STATE_ARCHIVE_PATHS` 新增 `crash`。
- 新增数据库后缀排除：`.sqlite` / `.sqlite-wal` / `.sqlite-shm` / `.db` / `.db-wal` / `.db-shm`。
- 复制阶段：`!textEncodingInfo` 时跳过文件，记入 `skippedFiles` 并附 `reason`，进汇总日志。
- 本机 v2 根下约 11.4 MB 二进制不再进包。

## 所有权与不变式

- `exportLogArchivePolicy.ts` 拥有"什么能进包"的**全部**判定；`exportLogs.ts` 不得再内联路径规则。
- **不变式**：导出包内不存在任何未经过 `sanitizeSensitiveLogContent` 的文本，也不存在任何非文本文件。

## 失败语义

- 跳过非文本文件是**可预期行为**，不是错误：进汇总日志，用户报障时能知道哪些文件没进包。
- 单个文件跳过不让整体导出失败（沿用既有 ENOENT/EACCES 语义）。
- 被跳过的文件不视为读失败，不触发二次源文件可读性复核。

## 迁移边界

- **官方渠道**：`crash/` 下 dump 此前就存在，本次一并排除。对**反馈包无影响**——
  `createFeedbackLogArchiveFromExportLogs` 只取 `logs/`、`cli/log`、CUA run 三处，本来就不含 `crash`；
  受影响的是手动"导出日志"的全量路径。
- **不影响正常日志**：`cli/log/*.jsonl` 与 `rollout/*.jsonl` 实测均为 utf-8，照常脱敏。
- **未来**：若需要导出二进制诊断材料（如截图），走显式白名单，默认仍拒绝。
- 历史导出包不会自动清理；已转出的包无法追回。
