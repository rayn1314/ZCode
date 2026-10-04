# 远程 workspace 身份归并（spec）

涉及包：ui（本 spec 主责）、desktop（canonical 化链路）、shared（身份格式契约）。

## 背景与问题

远程 workspace 的历史条目同时持有两份可独立演化的字段：`target`（连接目标快照）与
`workspaceIdentity`（身份键）。WSL 连接前 Main 侧会把 target canonical 化
（`resolveCanonicalWslTarget` → `WSLBackend.resolveIdentity()` 探测默认用户），canonical
结果经连接回包回到 UI 并写回条目 target；而条目的 `workspaceIdentity` 是探测前按原始
target 现算的，不会被同步重算。

`buildRemoteWorkspaceSessionMutation` 在写回前用「按 target 现算身份逐字比对」查找既有条目
（`findMatchingRemoteWorkspaceSessionEntry`）。target 带 user 后现算身份（5 段
`remote:wsl:<distro>:<user>:<path>`）与条目存量 identity（4 段
`remote:wsl:<distro>:<path>`）永不相等——**条目匹配不到它自己**，同一环境被当作新项目另立
条目：项目列表出现重复的同路径条目、旧条目永远「未连接」、新条目下历史会话为空
（远端 `session.workspace_id` 按客户端传入身份过滤）。2026-10-02 在 WSL + 自建版实测复现。

伴生缺陷：mutation 的身份解析原优先级为「调用方显式传入 > 命中条目 > 现算」。Bot 重连等
调用方显式传入现算身份（新格式），即使匹配到旧条目也会绕过它写出新条目，单改匹配层无法收敛。

## 设计决策：身份稳定优先，归并只放宽 WSL user 段

- **身份是数据归属键，绝不静默升级**。条目身份一旦写入，就是远端会话库
  （`session.workspace_id`）、任务索引（`tasks.workspace_key`）与凭据键的归属依据；
  target 的格式演进（canonical 化补 user）不构成换 key 的理由。身份格式升级必须走显式
  迁移工具（迁移数据归属），禁止在连接流程里静默换 key。
- **归并匹配**：精确身份匹配失败后，按「同 kind + 同 authority（WSL 放宽 user）+ 同归一化
  路径」做二次归并；命中即沿用条目存量身份。

## 行为

- `matchesRemoteTargetForIdentityMerge(entryTarget, incomingTarget)`：
  - kind 不同 → false；
  - **wsl**：distro（缺省 `default`，trim 后比较）相等，且 user 满足「至少一方缺失（视为
    同一默认环境）或双方全等」→ true；
  - **ssh**：host（小写）+ port（缺省 22）+ username 全等 → true（authority 完整，无通配）；
  - **docker**：container 全等；
  - 路径比较在调用侧进行（`normalizeWorkspacePathForIdentity` 归一后相等）。
- `findMatchingRemoteWorkspaceSessionEntry`：先按现算身份逐字精确匹配（原有行为不变），
  失败后遍历条目做归并兜底。
- `buildRemoteWorkspaceSessionMutation` 身份解析优先级调整为：
  **归并命中的条目 identity > 调用方显式传入 > 现算**。全部 5 个调用方
  （新连接落库、手动重连、Bot 重连、失败回写 ×2）收敛到同一语义。
- 归并命中时条目 target 快照照常更新为 canonical 版本（`createRemoteTargetSnapshot` 不变）；
  target 与 identity 允许存在「格式不一致」，由归并匹配层兜底，不再分裂。

## 所有权与不变式

- 归并判定只属于 UI 历史层（`packages/ui/src/lib/remoteWorkspaceHistory.ts`）；Main/Host/
  shared 侧的 `buildRemoteWorkspaceIdentity` 保持纯函数 fallback 语义（请求未带身份时现算），
  不复制归并逻辑。
- 身份构造/解析格式契约的单一来源仍是 `packages/shared/src/remote-workspace-identity.ts`
  与 UI 侧孪生实现（`remoteWorkspaceHistory.ts`），归并不新增第三种身份格式。
- user 通配只允许「一方缺失」这一种形态；双方都显式填写且不同代表真正的两个环境
  （如 root 与普通用户的权限边界），必须各自成条目。

## 失败语义

- 归并误判的最坏后果是两个**不同**环境共用一个历史条目——因此 distro / host / port /
  username / path 任何一段不同都不得归并，只有 user 的「缺失 vs 探测值」被放宽。
- 精确匹配永远优先，归并仅在其失败后执行：存量行为（identity 完全一致的条目）不受影响。
- 失败回写（`lastConnectionStatus: "failed"`）沿用条目 target 快照的原有行为不变。

## 迁移边界

- 本 spec 不迁移任何数据。存量分裂条目与远端库的归属修复属显式运维动作
  （2026-10-02 一次人工迁移记录见 `packages/server/spec/remote-runtime-isolation.md`
  迁移边界一节）。
- WSL 任务索引中旧身份 key 下的僵尸行（无人读、无害）清理不在本轮范围。
