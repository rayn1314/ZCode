# 同根项目身份：活项目优先解析与同根唯一

- 主责包：`packages/ui`
- 跨包影响：`packages/services`（`project-storage` 的 `saveProject` 负责同根唯一；`packages/services/src/project-storage/CONTRACT.md` 已同步）。
- 相关模块契约：`packages/ui/src/project-sidebar/CONTRACT.md`。

## 背景与问题

桌面 App 连 WSL 上的 Source Server 时，某个远端目录被一个已软删项目和一个活项目同时占用（现场数据：`projects` 里 `repos (2)` 的 `deleted=1, position=-1`，`repos` 的 `deleted=0`，两者 `project_roots.root_path` 相同）。旧实现从不校验「同一 Host 的同一 root 只能有一个活项目」，于是出现两个可复现症状：

1. 该目录**打不开**：入口列表里已删除项目的残留入口排在前面，`directory.entries.find(首个 root 匹配)` 命中它，再用 `(hostId, projectId)` 精确解析到已删除项目，Root 判据 `!project || project.deleted` 直接抛 `project.not-found`，活项目被永久顶着。
2. 该目录**被当成新建项目**：`resolveRecentRemoteProjectPreference` 要求匹配到「恰好 1 条入口」才生成打开意图，同根多出那条已删除入口时提前返回 `null`，偏好里没有 `preferredProjectEntryId`，Root 只能退回目录选择，用户在已有目录里被要求重新生成一个项目。

重复项目的来源：`saveProject` 只对**项目名**去重（重名加 `(2)`，`repos (2)` 即由此产生），对 root 没有唯一性校验；`assertRemoteProjectRoots` 只管「单根 + 根不可变」。

## 设计决策

1. **同根唯一由 services 侧写事务保证。** 新建时若 roots 已被同 Host 的另一个活项目完全占用，则不插入新行，直接返回那个已存在的活项目（采纳）；恢复已删除项目而根被占用则拒绝。判定只认「root 集合完全相同」：多 root 项目之间共享部分目录仍是合法组织态，只有完全同根才会让身份无法判定。
2. **UI 侧只保留一个入口解析器。** `packages/ui/src/project-sidebar/remote-project-entry.ts` 是「按目录找项目入口」的唯一实现，Root、连接向导、设置页最近项目全部改走它，不再各写一份 `.find`。活项目优先，其余按目录自身顺序取首条；没有项目树时无法判定软删（见迁移边界）。
3. **解析结果驱动选择，而不是由偏好是否完整驱动。** `resolveRemoteProjectDirectorySelection` 把「打开哪个项目 / 是否允许进入新建」的判据集中成纯函数：目录已有活项目就一定打开它；只有目录确实没有活项目、且没有恢复意图时，才进入项目编辑（`RemoteProjectPicker`）。
4. **恢复意图的失败语义保持不变。** 入口已从本机移除 → `remote-connection-canceled`；入口还在但项目已删除 → `project.not-found`；只恢复原会话（`preferredWorkspaceTabId`）时不做草稿归属解析，避免阻止已删除项目的历史会话重连。

## 行为

- 给定 `(hostId, path, tree)`，`resolveRemoteProjectEntryForDirectory` 返回唯一结果 `{entry, rootPath, project?}`：优先解析到未删除项目的入口；入口的 root 与 `legacyWorkspace.workspacePath` 都参与匹配，路径比较沿用 workspace identity 的归一（尾斜杠、反斜杠不产生第二个目录）。
- Root 的目录选择：命中活项目 → 打开它（草稿归属用活项目 ID；只有恢复会话时留空）；目录没有活项目且有恢复意图 → 按上面第 4 条失败；其余情况 → 打开项目编辑。
- `resolveRecentRemoteProjectPreference`：同根存在已删除项目的残留入口时仍固定活项目入口；只有该目录确实没有活项目（且拿到了项目树）时才返回 `null`。
- `requestRetainedRemoteProjectConnection`：用同一解析器取保留入口，`preferredProjectEntryId` 指向活项目；其 `stillRetained` 复验只检查「原入口是否仍在同一目录」，不重新做活项目优先，避免复验本身被残留入口顶掉。
- `saveProject`：新建同根 → 返回已存在活项目且不新增行；恢复同根被占用 → `project.restore-root-claimed`；已删除项目不占用根（「删除后重建同目录」仍照旧）。

## 所有权与不变式

- 同一 Host 下，**一个 root 集合最多被一个活项目占用**；软删项目不占用根，其入口可以继续存在但不参与身份判定。
- 入口列表（`remote_project_entries`）仍是「本机可见的远端项目成员」的记录；软删远端项目的残留入口不清理，只在解析时被活项目优先规则排除。
- 目录路径的比较规则只有一个实现（`matchedEntryPath`），解析、`stillRetained` 复验、Root 的 `isCurrent` 复验共用，不得各自内联字符串比较。
- 同根唯一由 `ProjectRepository.saveProject` 的事务内校验持有；UI 不重复实现写侧规则，也不在写前读后写地「先查再建」。

## 失败语义

| 场景                           | 出口                                       |
| ------------------------------ | ------------------------------------------ |
| 同根新建，已有活项目           | 采纳该活项目并导航到它，不新增行           |
| 恢复已删除项目，根被活项目占用 | `project.restore-root-claimed`             |
| 恢复意图的入口已被移除         | `remote-connection-canceled`（沿用原语义） |
| 恢复意图的项目已删除/读不到    | `project.not-found`（沿用原语义）          |
| 目录没有活项目且无恢复意图     | 进入项目编辑（新建），非错误               |

`project.deleted`、`project.cross-host-move`、`project.host-immutable`、`project.restore-roots-mismatch`、`project.invalid-primary-root`、远端单根约束的语义与错误码不变。

## 迁移边界

- **已在库里的同根重复**（一段已删除 + 一段活着，或两段都活着）不会自动收敛：写侧规则只约束新写入。读取侧靠「活项目优先」在每次解析时把结果收敛到活项目，因此旧数据能立刻恢复可用；重复的活项目需要用户显式删掉多余的那个。
- **没有项目树就判定不了软删。** Root 在进入目录选择前必读一次项目树（`projectService` 缺失即 `project.service-unavailable`，不猜）；`requestRetainedRemoteProjectConnection` 的项目树读取是可选输入，缺失时退化为「按目录顺序取首条」，其正确性由 Root 侧的再次解析兜住。设置页传的是目录 owner 的项目树；Host 离线时该树来自入口缓存，可能把已删除入口看成活项目，此时 Root 的在线复验仍会收敛到活项目。
- **本地项目的编辑路径未纳入同根唯一**：`saveProject({id, roots})` 把 roots 改到另一个活项目占用的目录时仍会写入。远端受 `project.remote-root-immutable` 保护，本地留作后续治理。
- 用户真实数据库不做任何自动改写；本轮只改代码。

## 验收

- `packages/ui/test/remoteProjectRootResolution.test.ts`：同根「已删除 + 活」两条时解析选中活项目、重连/选目录不进入新建、`preferredProjectEntryId` 指向活项目、入口被替换时不打开旧意图。
- `packages/services/src/project-storage/repository/contract.test.ts`：同根新建返回已有活项目且 `projects`/`project_roots` 行数不变；恢复被占用的根抛 `project.restore-root-claimed`；部分共享目录不触发采纳。
