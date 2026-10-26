# 远端工作区身份权威（bind 边界换代与 UI 消费契约）

- 主责包：`packages/ui`
- 跨包影响：`packages/desktop`（main 的 bind 权威化、host 的 connect descriptor 与项目树身份重写）、`packages/services`（`remote-projects` 的 settings 投影、`project` 的树身份重写、`task-groups` 的不变式校验）、`packages/shared`（身份格式与 bind 结果类型的单一来源）。
- 相关契约：`packages/ui/src/project-sidebar/CONTRACT.md`、`packages/ui/spec/remote-workspace-identity-merge.md`（历史条目归并，另一层）。

## 背景与问题

2026-10-27 桌面 App 点侧栏会话报 `Error: project.workspace-identity-mismatch`。当时全仓唯一抛出点是 `packages/ui/src/project-sidebar/remote-navigation.ts`：绑定完成后用**调用方传入的 identity** 回查会话存储器，`findSession(callerIdentity)?.sessionId !== sessionId` 即抛错。

问题在于 bind 是**身份换代点**，不是身份透传：

- Host 侧（main）`bindRemoteWorkspaceSessionContext` 在 Source Server 身份已知时一律把登记身份写成稳定命名空间：`route.descriptor.sourceServerId ? buildServerRemoteWorkspaceIdentity({serverId, workspacePath}) : requestedWorkspaceIdentity`（`packages/desktop/src/main/desktopRemoteSessions.ts` 约 1440 行）。
- 渲染层会话存储器里的身份**只来自 Host descriptor**（`desktopRemoteSessions.ts` 的端口注册 → `packages/desktop/src/renderer/src/main.tsx` 的 `registerRemoteWorkspaceSession`），UI 自己现算的身份从不写回。
- 于是「调用方身份」与「bind 后的权威身份」只有在同一命名空间时才会相等。

现场存在两套并存的命名空间（均为当前代码，非陈旧数据）：

| 命名空间                                              | 生产者                                                                                                                           | 消费者/落点                                                                                                                                                            |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 稳定 `remote:server:<sourceServerId>:<path>`          | `buildServerRemoteWorkspaceIdentity`：main 的 bind、host 的项目树身份重写（`packages/desktop/src/host/index.ts` 远程 host 分支） | tab / pane 的 `workspaceKey`、`sourceServerWorkspaceHistory`、任务行 identity                                                                                          |
| transport/route `remote:wsl:<distro>[:<user>]:<path>` | `buildRemoteWorkspaceIdentity(path, target)`：host 的 connect descriptor（`packages/desktop/src/host/index.ts` 约 3431 行）      | UI 目录选择的 fallback（`packages/ui/src/Root.tsx` 约 1311 行）、`lastWorkspaceSession` 投影（`packages/services/src/remote-projects/workspace-settings.ts` 约 61 行） |

物理实据（本机现场数据，只读核对，未改写）：桌面 `C:\Users\rayn\.zcode-rayn\v2\setting.json` 的 `lastWorkspaceSession` 3 条远端条目是 `remote:wsl:Ubuntu:rayn:...`（`lastOpenedAt: 0`、无 `sourceServerId`），同一文件的 `sourceServerWorkspaceHistory` 是 `remote:server:0dd064e1-...`；该机器上的 tab/pane 连接键始终是稳定格式（渲染层生命周期日志）。

第三套命名空间只存在于 Source Server **内部**：静态映射 `stableToCanonical`/`canonicalToStable`（`packages/services/src/source-server-workspace/sourceServerWorkspaceIdentityChannelServer.ts`）把对外稳定身份折算成 storage canonical 身份，因此远端 `tasks-index.sqlite` 的 `workspace_key` 列是 `remote:wsl:...`。这本身合法，但同一行的 `host_id` 是控制面格式（`ensureHost` 用 `ownerHostId`，见 `packages/services/src/project-storage/legacy-tasks.ts`），跨命名空间成对出现即违反 `packages/services/src/task-groups/index.ts` 的 `remoteHostIdFromWorkspaceIdentity(identity) === hostId` 不变式——桌面日志 00:29:20 的 `task-group.host-identity-mismatch`（4 条）正是它。

旧的断言把「调用方身份」当作权威，因此命名空间一旦不同（或 bind 判定的 serverId/path 与调用方那一份不同），一次**成功**的绑定也会被判成 mismatch。

未定论项（如实记录）：生产构建下渲染层日志被抑制（`packages/ui/src/logger.ts`），拿不到当次点击传入的字符串，因此**无法指认用户那一次点击具体带的是哪一份格式**。已排除的候选：「陈旧会话条目返回旧 sessionId」——`findSession` 是按 identity 键查找，命中陈旧条目只会复用（返回旧 sessionId）而不是落空；日志显示同一远端工作区的 pane/连接被大量复用，没有出现同一身份两个会话的证据。无论哪一份格式，下面这条修法都成立。

## 设计决策

1. **权威 scope 由 Host bind 返回，UI 只消费它。** 绑定后的 identity 校验改用 `bind` 的返回值，不再回查调用方身份。这正是同一类历史事故既有注释里写下的修法（`packages/ui/src/root/useRemoteWorkspaceHistory.ts` 中「先完成 Host bind，再只消费权威 scope」），本次把它贯彻到断言。
2. **把「权威 scope」提升为类型契约，让编译器强制携带。** `bindRemoteWorkspaceScope` 本来就返回权威 `{workspacePath, workspaceIdentity, previousWorkspaceIdentity?, workspacePurpose?}`，但此前在 `onSelectRemoteProject: () => Promise<void>` 边界上被丢弃。现在统一为 `RemoteWorkspaceBoundScope`（`packages/ui/src/app-shell/types.ts`，取自协议 `BindRemoteWorkspaceSessionContextResult`），沿 `AppProps.onSelectRemoteProject`、`ProjectSidebarProps.onSelectRemoteProject`、`attachRemoteProjectWorkspace` 的 `bind` 一路必填。
3. **`open-project` 从 `dispatch` 意图提升为带返回值的方法。** `RemoteWorkspaceIntent` 是「即发即忘」词汇表，无法表达「结果必须被消费」；`RemoteWorkspaceController.openProject` 单独成方法，返回值即权威 scope，避免调用方用 `as` 或兜底分支绕过契约。
4. **不在 UI 侧新增身份归一/别名。** legacy→stable 的别名映射仍只属于历史读取层（`packages/ui/src/lib/remoteWorkspaceHistory.ts`，见 `remote-workspace-identity-merge.md`）。导航层不做猜测式换算：绑定前按调用方身份尽力复用，绑定后一律以权威为准。

## 行为

- 传入 transport/route 身份（`remote:wsl:*`）时：绑定前的复用查找可能落空并新建 logical attachment；bind 完成后按权威 scope 校验，**不再抛 `project.workspace-identity-mismatch`**；已有 tab 由 `selectRemoteWorkspaceProjectFromDialog` 复用并释放本次临时 attachment。
- 传入已经是权威身份（`remote:server:*`）时：行为与旧实现一致（复用已登记 attachment，绑定后校验通过）。
- 绑定后权威 identity 指向别的会话或找不到会话（重复登记、登记丢失）时仍抛 `project.workspace-identity-mismatch`——守卫的语义（「本次绑定的 attachment 必须能按权威身份被解析到」）保持不变，只是换了命名空间。
- 导航被取代（`isCurrent` 失败）、成员被替换（`expectedMembershipId` 不符）、项目被移除（`readProjects` 不含）时的取消与拒绝语义不变；绑定失败不取消已存在的 attachment，只回收本次新建的 attachment。

## 所有权与不变式

- **Host（main + window host）是 workspace identity 的唯一权威**：Source Server 目标下，绑定后的身份一律是 `remote:server:<sourceServerId>:<path>`（serverId 小写归一、路径归一由 `buildServerRemoteWorkspaceIdentity` 单点负责）。
- **渲染层会话的 `workspaceIdentity` 只是权威的投影**（来自 Host descriptor）。UI 不得自建第二份身份，也不得用 transport target/route 现算值做绑定后的等价判断。
- **绑定后校验必须落在权威命名空间**：`attachRemoteProjectWorkspace` 的断言只读 `bind` 返回值；调用方 identity 只用于绑定前的复用查找和作为 bind 的输入提示。
- 身份格式的单一来源仍是 `packages/shared/src/remote-workspace-identity.ts`（UI 侧孪生实现见 `lib/remoteWorkspaceHistory.ts`），本 spec 不新增第三种格式。

## 失败语义

| 场景                                          | 出口                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| 传入 transport 身份、Host 换代成稳定身份      | 绑定成功且校验通过（修复前误报 `project.workspace-identity-mismatch`） |
| 权威 scope 解析不到本次 attachment            | `project.workspace-identity-mismatch`（守卫保留）                      |
| `bind` 未返回权威 scope（实现违约）           | 类型层拒绝；运行时按编程错误暴露，不回退调用方身份                     |
| 绑定失败 / 导航被取代 / 成员替换 / 项目已移除 | 沿用原错误码与取消语义，不变                                           |

## 迁移边界

- **不迁移、不改写用户真实数据库。** 远端 `tasks-index.sqlite` 里 `workspace_key` 为 `remote:wsl:*` 的存量行是 Source Server 的合法内部 storage 键（`stableToCanonical` 映射在即为可用键），无需按本轮改动重写。
- **规范形式取哪一个（本轮结论）**：跨进程、跨接口边界的规范形式是控制面稳定身份 `remote:server:<sourceServerId>:<path>`；storage canonical（`remote:wsl:*`）只作为 Source Server 内部别名键，且必须由边界处的映射折算后再出边界。因此远端任务行的 `host_id`（控制面）与 `workspace_key`（storage）**同表并存属历史遗留**：行本身可读，但任何把它当「同一命名空间」的校验都会失败。
- **边界归一最后一处已补（services 侧）**：`packages/services/src/project/index.ts` 的 `bindRemoteProjectIdentities` 此前只重写 `tasks`、漏了 `deletedTasks`，而 `deletedTasks` 直接来自 `SELECT workspace_identity AS workspaceIdentity, host_id AS hostId`（`packages/services/src/project-storage/project-repository.ts:207-222`），带 storage identity + 控制面 `hostId` 出边界，`useTaskGroups` 又把它们与活任务合进同一批 `task-groups.admit`，一条坏身份即整批拒绝（现场 00:29:20 的 4 条 `task-group.host-identity-mismatch`）。现已与活任务走同一张 `resolveIdentity` 映射重写（已删除任务的路径一并进入解析集合；`resolveWorkspace`/`bindWorkspaceIdentity` 只做数据库键映射，不校验文件系统，不存在目录缺失导致读树失败的回归面）。测试：`packages/services/test/bindRemoteProjectIdentities.test.ts`。
- **待产品口径**：`workspace-settings.ts` 的 settings 投影仍在写 transport 格式的 `lastWorkspaceSession` 条目（历史读取层靠别名归一兜住）。是否继续支持 legacy `remote:wsl:` 主机行（连带 `Root.tsx` 目录选择里 `session.sourceServerId ? stable : route` 的 fallback）需要产品决策：保留则需把 fallback 与投影对齐到同一规范形式，移除则 legacy 主机行彻底不可解析。本轮不改，仅记录。
- 远端数据如需从 storage 键迁到稳定键，属**显式运维迁移**：脚本 + 备份 + 产品确认，且必须同时改 `projects`/`tasks` 与凭据键；不在本轮范围。

## 验收

- `packages/ui/test/remoteProjectNavigation.test.ts`：传入 legacy route 身份时收敛到 bind 返回的权威身份、不抛 mismatch；权威身份原样时不被误判；权威 scope 指不到本次 attachment 时仍抛 mismatch；复用/失败/晚期连接/成员替换/项目移除语义保持不变。
- `packages/ui/test/remoteWorkspaceController.test.ts`：`openProject` 返回权威 scope（而非 `Promise<void>`）。
- 类型层：`npx tsc -b packages/ui/tsconfig.json` 通过；`onSelectRemoteProject` 的实现必须返回值，漏返回即编译失败。
