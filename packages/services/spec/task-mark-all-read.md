# 项目级「全部标为已读」（spec）

涉及包：`packages/services`（主责：批量清除与未读归属落盘）、`packages/ui`（项目行更多菜单入口与乐观反馈）、
`packages/desktop`（window controller 的 source 路由）、`packages/shared`（测试 id 常量）。

## 背景与问题

项目行（workspace 行）的未读蓝点由 `hasUnread` 决定，它统计的是该 workspace 里 **`timeline` membership**
（`matchesTaskListMembershipKind`：非置顶、非归档、未删除）的未读，且在**完整结果**上统计
（`useWorkspaceTaskLists.ts` 的 `unreadTaskKeys`），而侧栏默认只渲染 5 条、展开后每次只多加载 5 条。
于是出现一个无法自救的状态：一条很久以前后台跑完、用户从未点开的老会话被标成未读，却排在列表第 29 位——
蓝点一直亮，用户翻不到那一行，也就永远清不掉。

实测（2026-10-11）：`E:\model-test` 共 51 条有效任务，仅 1 条 `unread_at IS NOT NULL`
（`sess_f6dd2250-…`，completed，2026-10-01 13:54:48 由后台终态标未读），它按更新时间与创建时间排序都排在第 29 位。

同时确认这不是子代理问题：`subagent_child` 会话在 `zcodeTaskIndexSyncer.ts:1674` 提前 return，
不写 tasks-index；该 workspace 的 2 个子代理会话在任务表里 0 行。

既有清除路径只有两条，都不解决上面的场景：

1. 点开某条会话 → `useWorkspaceTaskNavigation` 对该条做 compare-and-clear（要求用户先找到那一行）。
2. 任务行右键只有「标记为未读」，没有反向的「标记为已读」。

## 设计决策

1. **入口放在项目行工具栏的「…」更多菜单，不放任务右键菜单。**
   用户决策（2026-10-11）：右键能点到的时候，这个功能已经没必要了——它要解决的正是"翻不到那一行"。

2. **范围 = 项目行未读蓝点的判定口径：非置顶、非归档、未删除，一个字不多不少。**
   用户决策（2026-10-11，二次澄清）："蓝点从哪儿判断出来，我们就消灭哪些，不要多也不要少"。
   蓝点统计的是 task list membership 为 `timeline` 的未读；置顶区、归档区的未读不点亮项目行蓝点，
   因此保持不动。服务端复用同一个判定函数过滤，不在 SQL 里另写一份条件副本。

3. **做成服务端批量接口 `markWorkspaceTasksRead`，不做前端循环调用单条 `setTaskUnread`。**
   循环调用会发 N 次 RPC 与 N 条 `workspace_task_list_changed`，并且要求 UI 先握有完整未读清单
   （依赖 membership 查询成功）。批量接口一次 RPC、单个 SQLite 写事务、广播一次。
   这与既有批量先例 `deleteArchivedTasks` 同一模式（`zcodeTaskServiceAdapter.ts` 的注释已写明
   "循环调用单条接口会逐项广播"）。

4. **批量清除不做逐条 CAS（不带 `expectedUnreadAt`）。**
   单条清除的 CAS 是为"用户看着某一行的旧快照点击"服务的。批量场景没有快照，
   `BEGIN IMMEDIATE` 持有写锁期间读改写天然原子，并发产生的新未读进不来，
   语义等价于"以执行时刻为准全部清除"——正是按钮的意图。

5. **不弹确认框。** 用户决策（2026-10-11）：菜单本身要点两下，操作可逆（单条仍可右键「标记为未读」）。

6. **没有未读时置灰禁用，不隐藏。** 用户决策（2026-10-11）：入口位置固定，下次有未读不用重新找。

7. **desktop 下必须走 window controller 路由。** 与 `pin`/`archive`/`unread` 同级：controller 是
   任务列表投影与跨 source 路由的唯一 owner。直接透传到本地 host 的 adapter 会绕开
   "写入的 source 与列表投影的 source 是同一个"这条纪律。批量操作不针对具体 task，
   因此新增 mutation kind `mark-workspace-read`，并把 `mark-workspace-read` 加入
   `projection.mutate` 的「允许投影里没有对应行」白名单（与 `delete-archived*` 同类）。

## 行为

| 环节         | 位置                                                           | 行为                                                                                                                                                                                                                        |
| ------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 菜单项       | `ui/src/WorkspaceSidebarItem.tsx` 更多菜单                     | `CheckCheck` 图标 + 「全部标为已读」；位于远端同步项之后、`移除` 之前                                                                                                                                                       |
| 禁用条件     | 同上                                                           | `readOnlyReason`（只读/失效目录）或 `!taskListHasUnread` 或正在执行；禁用时 `title` 提示「没有未读会话」                                                                                                                    |
| 乐观反馈     | 同上 handler                                                   | 对可见未读行先写 unread overlay 并清 legacy indicator，蓝点立即消失                                                                                                                                                         |
| 调用         | `services/src/session/zcodeTaskService.ts`                     | `markWorkspaceTasksRead({ workspacePath, workspaceIdentity? })`                                                                                                                                                             |
| 落盘         | `services/src/session/taskIndexRepo.ts` `clearWorkspaceUnread` | 单事务内 `SELECT … unread_at IS NOT NULL AND deleted = 0` → 按 `timeline` membership 过滤 → 逐行 `writeRecord` → `COMMIT`；返回 `clearedTaskIds`                                                                            |
| 广播         | `services/src/zcode-agent/zcodeTaskServiceAdapter.ts`          | 清除数 > 0 时只发一条 `workspace_task_list_changed`（reason `task_meta_changed`），并把每个 cleared task 的 service overlay 对账为已读                                                                                      |
| 回包对账     | UI handler                                                     | 对 `clearedTaskIds` 逐个 `reconcileTaskQueryCacheUnread` + 清 legacy indicator，再 `bumpTaskListMembershipVersion()`                                                                                                        |
| desktop 路由 | `desktop/src/host/index.ts` / `windowHostControllerService.ts` | `markWorkspaceTasksRead` 经 `resolveTaskAddress({ taskId: "", allowMissingTask: true })` 解析 source，再 `projection.mutate(address, { kind: "mark-workspace-read" })` → `service.markWorkspaceTasksRead` → `refreshSource` |
| 失败         | UI handler                                                     | 回滚可见行的乐观 overlay + `markTaskQueryCacheScopesStale` + `bumpTaskListMembershipVersion` + toast 失败文案 + `logger.warn`                                                                                               |

## 所有权与不变式

- **未读的唯一事实源是 `tasks-index.unread_at`**，且 `unread_at` 同时投影在标量列与 `meta_json` 里，
  因此批量清除必须走 `writeRecord`（不能裸 `UPDATE tasks SET unread_at = NULL`），
  否则 `meta_json` 里的旧 `unreadAt` 会在后续 snapshot 合并时写回来。
- **`last_unread_at` 水位不因清除而重置**，仍按 `writeRecord` 既有规则推进；
  批量入口与单条入口共用同一份写逻辑，不新增第二条写路径。
- **事务体必须保持同步**（`BEGIN IMMEDIATE` 与 `COMMIT` 之间不得出现 `await`）：
  sqlite 是单连接同步驱动，一旦让出事件循环，其它写链就会插进这个批次。
- **项目行蓝点的收敛需要 membership 重拉**：`hasUnread` 除了读 query row 的 `unreadAt`，
  还读 `unreadTaskKeys`（只在 membership 重拉时重算），所以 UI 清完必须 `bumpTaskListMembershipVersion()`；
  跨端（手机/另一 Host）收敛则依靠那一条 `task_meta_changed` 事件。
- **清除口径单源**：范围由 `matchesTaskListMembershipKind(…, "timeline")`（`@zcode/shared/zcode-protocol-v4`）定义，
  UI 的蓝点统计与服务端的批量清除引用**同一个函数**。不得在 SQL 或别处再写一份
  `pinned = 0 AND archived = 0` 的副本——副本漂移会直接表现为"蓝点清不掉"或"清多了"。
- **owner 边界不变**：desktop 下 workspace 级写入仍由 window controller 解析 source 后落到对应
  `taskService`；adapter 只负责本 source 的落盘与广播。

## 失败语义

- **落盘失败**：整个事务 `ROLLBACK`，`clearedTaskIds` 不返回，错误向上抛给 UI；
  UI 回滚乐观 overlay 并标脏 scope，蓝点回到原状，用户看到失败 toast。
- **回包前被并发清掉的目标**：若 `unreadTaskKeys` 里的某个 key 不在 `clearedTaskIds` 中
  （例如另一端先清了），它的 overlay 不会被置空，会短暂仍算未读；随后的
  `bumpTaskListMembershipVersion()` 重拉纠正，不会永久残留。
- **source 已替换**（desktop）：`executeMutation` 比对 `sourceKey`，不一致时抛
  「未读清除批次的 source 已替换」，不做跨 identity 写入。
- **source 离线**：沿用既有门禁，抛「远程 source 当前离线，禁止列表写操作」/「本地 source 当前不可用」。
- **空批次**：无未读时返回 `{ clearedTaskIds: [] }`，不广播事件、不触发 refresh。

## 迁移边界

- 不新增协议 schema：`IZCodeTaskService` 走 ProxyChannel 服务描述符，没有 per-method zod 校验，
  `packages/client/src/remoteServiceAccess.ts` 自动代理新方法。
- 不回溯清理历史未读；本功能只提供"用户主动一键清空"的出口。
- 不改动项目行蓝点的统计口径与渲染条件（`!isExpanded && taskListHasUnread` 维持原状）。

## 对应测试

`packages/services/test/workspaceUnreadClear.test.ts`：

- repo 层（真实临时 sqlite）：只清蓝点口径（`timeline`）内的未读；置顶/归档/已删除的未读保持不动、
  `clearedTaskIds` 精确；`last_unread_at` 水位不倒退；无未读、或未读全在口径外时返回空数组。
- adapter 层（stub repo）：有清除只广播一次 `task_meta_changed`、零清除不广播、repo 抛错时向上抛。
