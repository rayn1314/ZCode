# workspace / 项目身份一致性：投影写稳定身份与编辑路径同根唯一（spec）

涉及包：`packages/services`（主责：`remote-projects` 的 settings 投影、`project-storage` 的
`saveProject`）、`packages/shared`（身份格式单一来源 `remote-workspace-identity.ts`）、
`packages/ui`（读取期别名归一与错误呈现，本轮不改行为）、`packages/desktop`（Host 侧 bind 权威
与 settings 文件落点）。相关 spec：`packages/ui/spec/remote-project-root-identity.md`（同根唯一）、
`packages/ui/spec/remote-workspace-identity-authority.md`（身份权威，本 spec 收口其「待产品口径」一项）。

## 背景与问题

### 问题一：settings 投影持续写入旧命名空间身份

`packages/services/src/remote-projects/workspace-settings.ts` 的兼容投影把
`lastWorkspaceSession` 的远端条目身份写成 **transport 身份**（`buildRemoteWorkspaceIdentity(path, target)`）。
Source Server 路由的 target 只是连接手段（relay 的 ssh/wsl），route 身份本身才是权威稳定身份
（`host.id = remote:server:<sourceServerId>`）。于是同一台机器的
`~/.zcode-rayn/v2/setting.json` 里两种格式长期并存：

- `lastActiveWorkspace` 走 `buildRemoteHostWorkspaceIdentity(host.id, path)` → 稳定身份；
- `lastWorkspaceSession` 走 target 现算 → transport 身份（如 `remote:wsl:Ubuntu:rayn:<path>`）。

读取侧靠 `packages/ui/src/lib/remoteWorkspaceHistory.ts` 的别名归一兜住（不改写存量值），因此用户
看不到明显故障，但**分裂一直在被持续写入**：每条远端条目都要靠别名现算折算，且
`packages/ui/src/remote/remoteWorkspaceProjection.ts` 之类只认「稳定身份或已持久化 legacy alias」
的消费方会把这些条目画成「待识别线路」。

### 问题二：项目编辑路径可把根改到别的活项目占用的目录

`packages/services/src/project-storage/project-repository.ts` 的 `saveProject` 里，同根唯一（同一 Host
的同一 root 集合最多被一个活项目占用）只覆盖了**新建**（同根采纳已有活项目）与**恢复**
（`project.restore-root-claimed`，提交 `0b13382d`）。**编辑**路径（`saveProject({ id, roots })`）没有校验：
把某项目 root 改到另一个活项目占用的目录会成功，重新造出同根重复——与 2026-10-26 事故链同类根因。

## 设计决策

1. **身份格式只有一种权威形式，由身份构造器决定。** 远端 workspace 的权威形式是
   `remote:server:<sourceServerId>:<path>`（`buildServerRemoteWorkspaceIdentity`）。投影写身份时按
   **route 身份**判定命名空间：`host.id` 补回 path 段后解析出 `kind === "server"` 即写稳定身份，
   否则（legacy 直连主机没有 sourceServerId）写 transport 身份——那是它唯一可解析的形式。
   `host.id` 本身不含 path 段、单独解析返回 null，因此判据取自投影内部已有的去重键
   `buildRemoteHostWorkspaceIdentity(host.id, workspacePath)`，不新增第二种拆解规则。
2. **稳定身份与去重键同源。** 条目写入的 `workspaceIdentity` 直接复用该 host+path 的去重键，
   避免「集合去重用一个键、写出去另一个键」再次分裂。
3. **读取兼容保持不变。** 别名归一仍只在读取层（UI），不改写存量值、不新增第三种格式；
   投影对存量 transport 身份的 `lastActiveWorkspace` / `lastWorkspaceSession[lastActiveTabIndex]`
   照旧收敛到同一 host 的稳定身份。
4. **同根唯一在写事务内统一收口，判据只有一份。** 新建、恢复、编辑三个入口共用
   `claimedRootsProject`：判据是「root 集合完全相同」（顺序无关）、软删项目不参与、自身 id 排除。
5. **编辑路径只在根集合真的改变时拒绝。** 既存同根重复数据本轮不自动收敛，其中任一项目仍必须能
   改名/置顶（那是用户区分它们的唯一手段），否则新校验会把遗留数据锁死。
6. **远端项目不放行绕过。** 远端项目根不可变（`assertRemoteProjectRoots` 先于同根判据执行），
   保持 `project.remote-root-immutable`；同根校验只是不给远端编辑路径补一条后门。

## 行为

- 投影：Source Server 路由（含 relay transport 的 ssh/wsl）的每个 root 写出
  `remote:server:<sourceServerId>:<path>`；legacy 直连 WSL 主机仍写
  `remote:wsl:<distro>[:<user>]:<path>`（存量 transport 身份优先沿用，否则现算）。
  同一 Host 内 `host.id` 与 root path 相同的条目仍只出现一次。
- 编辑：`saveProject({ id, roots })` 的 roots 集合若与**另一个活项目**的 root 集合完全相同，
  抛 `project.root-claimed`，事务回滚（两边 roots 与原顺序均不变）。
- 编辑自身：改自己的根、自身多根增删与重排、改名、置顶（roots 不变）一律放行。
- 新建、恢复的既有语义不变：同根新建采纳已有活项目且不新增行；恢复被占用的根
  `project.restore-root-claimed`。

## 所有权与不变式

- **身份格式的唯一来源是 `packages/shared/src/remote-workspace-identity.ts`**：构造
  （`buildRemoteWorkspaceIdentity` / `buildServerRemoteWorkspaceIdentity` /
  `buildRemoteHostWorkspaceIdentity`）与解析（`parseRemoteWorkspaceIdentity`）都从这里走，
  业务模块不得自拼 authority。
- **投影是单向的**：只从本机 SQLite 目录 + 传入 settings 派生兼容字段，不读旧集合重建成员，
  也不改写用户数据库。
- **同根唯一由 `ProjectRepository.saveProject` 的写事务持有**，UI 不重复实现写侧规则
  （见 `packages/ui/spec/remote-project-root-identity.md`）。
- 投影的远端条目顺序（`identityOrder`）继续以 `buildRemoteHostWorkspaceIdentity(host.id, path)` 为键，
  `lastActiveTabIndex` 的语义不变。

## 失败语义

| 场景                                            | 出口                                     |
| ----------------------------------------------- | ---------------------------------------- |
| 编辑：roots 集合撞另一个活项目（不同 id、未删） | `project.root-claimed`（新增，事务回滚） |
| 编辑：改自身根 / 自身多根重排 / 改名 / 置顶     | 正常写入                                 |
| 编辑：远端项目根变化                            | `project.remote-root-immutable`（不变）  |
| 恢复：根被活项目占用                            | `project.restore-root-claimed`（不变）   |
| 新建：同根活项目已存在                          | 采纳该活项目，不新增行（不变）           |
| 投影：存量 transport 身份与稳定身份混合         | 都收敛到同一 host 的稳定身份             |

`project.root-claimed` 暂无 i18n 文案：UI 走既有 `formatProjectError` 的兜底分支（未知码原样展示），
翻译待 `packages/ui/src/i18n/locales/*.ts` 解禁后补。

## 迁移边界

- **不改写用户数据库与 settings 文件。** 存量 `lastWorkspaceSession` 里的 transport 身份保持原样，
  只由读取层别名归一消费；投影的修复只约束**后续**写入，收敛靠正常使用自然完成。
- **让路给一次性的 Source Directory 迁移（未迁移设备）。** `packages/desktop/src/host/sourceServerDirectory.ts`
  的 `persistLegacyRemoteEntries` 会被 `sourceServerDirectoryMigrationVersion !== 1` 触发一次，可能把
  transport target 的路由条目落成 Profile 与 `legacyWorkspaceIdentity`；本改动不触碰该路径。已迁移设备
  不再读 `lastWorkspaceSession`，无影响。
- **既存同根重复不自动收敛。** 两段活项目同根时读取侧按「活项目优先」在每次解析时收敛，重复的活项目
  需要用户显式删掉多余的那个；写侧只阻止再产生新的同根重复。
- **同类写入口未纳入本轮**：`initializeProjectRoot`（给零 roots 项目补唯一 root）与
  `moveTask({ addMissingRoot: true })`（把缺 root 的任务目录补进项目）同样可以造出同根集合，
  本轮只修用户可达性最高的编辑路径，其余留作后续治理。

## 验收

- `packages/services/src/remote-projects/workspace-settings/contract.test.ts`：Source Server 路由写稳定
  身份、legacy 直连 WSL 主机写法不变、两种存量格式在投影里收敛到同一 host 与稳定身份。
- `packages/services/test/projectRootClaimed.test.ts`：编辑撞活项目根抛 `project.root-claimed` 且两边 roots
  不变；增/减 root 撞集合同样拒绝；自身根编辑、自身多根重排、改名、置顶放行；既存同根重复仍可编辑；
  新建采纳与远端 `project.remote-root-immutable` 不回归。
- `packages/ui/test/remoteWorkspaceHistory.test.ts`：读取期别名让 transport 与稳定两种格式归并到同一身份键。
