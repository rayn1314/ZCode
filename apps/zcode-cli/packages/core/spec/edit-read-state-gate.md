# Edit 读状态闸门（read-state gate）

## 背景与问题

Edit 工具的 read-before-edit 闸门此前把三类情况一律拒绝并报同一句 "File has not been read yet"：

1. 从未 Read 过；
2. Read 被 token cap 截断（`isPartialView: true`）；
3. range Read（offset/limit）跨 resume/compact 后 hydration 不恢复。

情况 2/3 是误报：文件明明读过（上下文里就有内容），报错却说"没读过"。模型按文案重读，
partial view 重读仍被截断、range view 跨 resume 恢复不了，自纠失败后退化成逐行
Read→Edit 循环——一次改五行耗十次调用。

## 设计决策

保守折中，不改 read-before-edit 的门槛本身，只修误报源头：

- **partial view 放行**（`edit.ts` 的 read-state gate）：匹配安全由既有三道防线兜底——
  `old_string` 唯一性检查、写入 `expectedRevision` 乐观锁、下方继续生效的 stale 校验。
  不引入新的放行条件，只删掉对 `isPartialView` 的无条件拒绝。
- **带 freshness metadata 的 range Read 跨 resume 恢复**（`read-file-state-hydrator.ts`）：
  metadata 含 `mtimeMs/revisionId/sizeBytes`，足以支撑 stale 校验（校验基于完整文件的
  mtime/size，与窗口无关）。无 metadata 的 range Read 维持跳过（无法做 stale 校验）。
- **工具描述加批量引导**：多处编辑应在一条消息里发多个 Edit（执行器按序执行，每个
  Edit 看到前一个的结果），不要逐行 Read→Edit，也不要在编辑间隙 Read 回读。

明确不做：不同文件的 Edit 并行化（`concurrentSafe: false` 全局串行保留）——写写并发
涉及 fileSystemPort 并发语义与权限面，另行立项。

## 行为

- `getEditableReadStateFailure`：仅当文件从未被 Read（或被 Bash 回填等记账）时返回
  `FILE_NOT_READ`；`isPartialView` 条目进入与 full read 相同的 stale 判定。
- stale 判定不变：mtime 推进或 size 变化 → `STALE_FILE`；内容一致（strict full read）
  仍豁免。
- hydration：range Read 的 tool part 带 schema v1 freshness metadata 时，按
  `createReadFileStateKey(path, offset, limit)` 恢复为 range 条目；无 metadata 或
  tool/窗口不一致时计入 `skippedRangeReadCount` 并跳过。full Read 恢复路径不变。
- Edit 工具描述末尾新增批量引导一条。

## 所有权与不变式

- readFileState 的唯一所有者是 runtime（`agent-runtime.ts` 实例字段）；Edit 成功后由
  `updateReadFileStateAfterEdit` 用写回 revision 更新，这是连续 Edit 免重读的依据。
- hydration 是唯一跨 resume 重建 readFileState 的路径；它只信任持久化 metadata，
  不读当前磁盘补状态（避免把外部手动保存误认证为 agent 已读）。
- read-before-edit 门槛（"至少读过一次"）保持不变；本 spec 只调整"怎么算读过"与
  "读过的水位如何跨 resume 存续"。

## 失败语义

- `FILE_NOT_READ`：现在只表示"从未读过"，文案不再撒谎。
- `STALE_FILE`：文件自最近一次记账（Read/Edit/Write/Bash 回填）后被外部修改；partial
  view 条目同样适用。
- 乐观锁冲突（expectedRevision 不匹配）仍是底层 FileSystemPort 错误，不在此层转译。

## 迁移边界

- 旧会话的 range Read tool part 无 freshness metadata → 维持跳过，行为与改前一致；
  新会话的 Read tool part 均带 metadata（`createReadFileStateMetadataFromEntry` 对
  缺 freshness 字段的条目返回 undefined，不会产出半截 metadata）。
- 无 schema 变更；`ReadFileStateHydrationResult` 计数字段语义微调
  （`skippedRangeReadCount` 现在也涵盖"有 metadata 但 tool/窗口不一致"的 range Read）。

## 验证

- `packages/core/test/read-file-state-edit-gate.test.ts`：从未读过拒绝、partial view
  未变放行、partial view 已变仍 stale、连续 Edit 免重读、range Read 恢复/跳过、
  full read 恢复回归。
