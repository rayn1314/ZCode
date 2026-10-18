# 全局任务搜索支持按会话 ID 匹配

## 背景与问题

任务/会话搜索（`TaskSearchDialog`、Command Center 的 conversations 范围）目前只能命中任务的 `title` 与 `searchable_text`（聊天正文索引）。用户输入 `sess_3e834f0b` 这类会话 ID 时搜不到对应任务，因为 `task_id` 列不在匹配范围内。

`@` 提及会话（`sessionsMentionProvider`）的 `keywords` 早已包含 `task.taskId`，唯独全局搜索缺失，行为不一致。

## 设计决策

- 在 `TaskIndexRepo.queryTaskList` 的搜索 WHERE 中增加 `LOWER(task_id) LIKE ?`，与现有 `title` / `searchable_text` 的模糊匹配保持同一语义（整体 `%query%`，不分词）。
- 当查询命中 `task_id` 时，结果项以会话 ID 本身作为 `searchSnippet`：用户搜 ID 是为了定位会话，正文 fallback 摘要与 ID 无关，展示 ID 能直接确认命中原因，并在 UI 上高亮。
- 不改变 `searchable_text` 的索引构建、不引入额外表或 FTS，避免与现有正文索引链路耦合。

## 行为

- 搜索词 `sess_3e834f0b` 或部分 ID（如 `3e834f0b`）均能命中对应任务。
- 命中 `task_id` 的结果项返回 `searchSnippet = task_id`、`searchSnippets = [task_id]`。
- 仅命中 `title` / `searchable_text` 时行为不变。
- 空搜索、无搜索词时不进入 ID 匹配分支，行为不变。

## 所有权与不变式

- 匹配逻辑唯一所有者为 `TaskIndexRepo.queryTaskList`，SQL 与结果组装在同一方法内完成。
- `rowToTaskListItem` 保持纯函数：`search` 为 null 或空串时不做 ID 匹配，返回原 meta。
- `task_id` 匹配与 SQL 的 `LOWER(task_id) LIKE ?` 使用同一大小写归一化（`toLocaleLowerCase` + `includes`），保证查询结果与摘要展示一致。

## 失败语义

- 无新增外部依赖与失败路径；SQL 参数个数变化由同一 `normalizedSearchLike` 分支统一维护，避免参数错位。
- 非 ASCII 会话 ID（理论不存在）按现有 `toLocaleLowerCase` 语义处理。

## 迁移边界

- 纯增量行为：旧查询结果不变，新查询可命中 `task_id`。
- 涉及 `packages/ui`（搜索对话框）与 `packages/shared`（`ZCodeTaskListItem`）的类型不变，UI 无需改动即展示 ID 摘要。
