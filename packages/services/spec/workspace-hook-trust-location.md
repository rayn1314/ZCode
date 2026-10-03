# workspace hook 信任库的位置归属（spec）

涉及包：`packages/services`（主责：审核侧读写与展示）、`packages/shared`（路径与文件格式的
单源规则）、`apps/zcode-cli`（独立子 workspace：Runtime 侧拦截与 `hooks trust` 命令）、
`packages/desktop`。

身份归属总表见 `packages/desktop/spec/product-identity-data-root.md`。

## 背景与问题

ZCode 允许在固定事件点（`UserPromptSubmit` / `PostToolUse` / `Stop` 等）执行用户声明的命令，
即 workspace hook。因为 hook 会执行任意命令，它是**权限边界**：新出现的声明不自动信任，
需要用户审核授权，授权结果按「声明内容摘要」记入信任库
（`workspace-hook-trust-v1.json`）；未授权的声明由 Runtime 硬拦截
（`blocked_untrusted`）。

两条读取路径曾各自解析位置：

- **声明**：服务侧 `hooksService.getRootDir("zcode")` 走 `getZCodeDataRootDir()`，即
  `{dataRoot}/cli/config.json`（**跟随身份**）。
- **信任库**：服务侧 `readPersistentWorkspaceHookTrustDigests` 与 CLI 侧
  `resolveWorkspaceHookTrustStorePath` 都从 `homedir()` 出发，缺省兜底 `{home}/.zcode`，
  即 `~/.zcode/security/workspace-hook-trust-v1.json`（**共享**）。

结果：同一件事一半跟随身份、一半共享。并排安装的两个客户端读写**同一个信任文件**，于是

- 用户在官方客户端点过「信任」的 hook，自建客户端也认为已授权——用户没在那边点过同意，
  hook 却已经可执行；反向同理。
- 判定是否命中的前提是两侧存在**内容相同**的声明（摘要一致）。而 skills / plugins 属于
  刻意共享的用户资产（见身份归属总表），「两侧装同一个技能」是常态，前提经常成立。

CLI 侧的信任库路径解析还顺带从 `{homedir}/.zcode/cli/config.json` 读 `storage.dir`，
因此自建构建下它连「用户改过数据根」这件事也读的是官方文件。

## 设计决策

- **信任跟随声明**：信任库落在**声明所在的数据根**下，即
  `{dataRoot}/security/workspace-hook-trust-v1.json`。
- 路径推导单源在 `@zcode/shared/identity-paths-node` 的
  `resolveWorkspaceHookTrustStoreRoot/FilePath()`：`storage.dir` 显式覆盖优先，否则返回数据根。
  两侧只负责读取自己那条 `cli/config.json` 并传入 `storageDirOverride`。
- CLI 侧读取的 user config 路径同时修正为 `{dataRoot}/cli/config.json`（与声明同源），
  不再从 home 下的官方文件读 `storage.dir`。
- 旧的重复实现（服务侧内联展开、CLI 侧自备）一并删除——服务侧代码注释里已把它记为待下沉
  的重复（"统一需下沉到 shared 层，此处仅记录该重复"）。
- `storage.dir` 的三种形态与改动前逐字节一致：`~/` 按 home 展开、绝对路径归一、**相对路径按
  home 解析**（不是进程 cwd）。信任库是权限落点，相对路径若随启动目录漂移，同一条配置在不同
  workspace 下会指向不同的信任文件。`expandUserPath` 因此保留 `relativeBaseDir` 入参，只有
  权限边界类路径传它；env 型路径（数据根 / mailbox）继续按 cwd 解析相对形态。

## 行为

| 环节              | 位置                                                                         | 行为                                                                       |
| ----------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 路径推导          | `identity-paths-node.resolveWorkspaceHookTrustStoreFilePath()`               | `storage.dir` > `{dataRoot}`，再拼 `security/workspace-hook-trust-v1.json` |
| Runtime 侧读写    | `apps/zcode-cli/packages/adapters/src/storage/workspace-hook-trust-store.ts` | 传入数据根与 `storage.dir`，文件格式仍走 shared 的 strict schema           |
| 审核侧读取        | `packages/services/src/hooks/hooksService.ts`                                | 同一函数；解析失败一律 `corrupt` + fail-closed，不返回部分摘要             |
| 用户级 hooks 声明 | `hooksService.getRootDir("zcode")` = `{dataRoot}/cli`                        | 不变（本就跟随身份）；项目级仍固定 `{workspace}/.zcode`                    |

`source === "agents"`（`~/.agents`）与 `source === "claude"`（`~/.claude`）属于第三方位置，
不参与身份隔离；它们的声明与信任都落在原位，不做特殊处理。

## 所有权与不变式

- **声明与信任必须同源**：任何一侧改变声明读取根，信任库位置必须同步改变，否则会出现
  「UI 显示已信任、Runtime 一律拦截」的展示 / 运行时分歧（该分歧已在
  `readPersistentWorkspaceHookTrustDigests` 的注释里被记录过一次）。
- **文件格式单源**：`@zcode/shared/workspace-hook-trust-store-file` 的 strict schema 是唯一
  权威；展示侧不得用宽松解析得出不同结论。
- **不变式**：官方（空后缀）时信任库仍在 `~/.zcode/security/`，路径与历史一致。

## 失败语义

- 信任库缺失：视为「无任何授权」，全部声明按待审核处理（fail-closed）。
- 信任库损坏（JSON 合法但结构非法）：一律 `corrupt` + fail-closed，不返回部分摘要。
- 读取失败与「无记录」必须可区分：读取失败不得静默当作空集合（否则 UI 展示与 Runtime 拦截
  不一致，用户反复授权无效）。

## 迁移边界

- **不自动搬运**旧信任库：信任是权限边界，跨身份搬运等于替用户做授权决定。升级后另一客户
  端已有的信任记录不会继承，需要各自重新审核（fail-closed，偏安全）。
- 旧位置 `~/.zcode/security/workspace-hook-trust-v1.json` 不删除、不读取，仅作历史留档。

## 验证

- 路径推导单测：官方 / 自建后缀、`storage.dir` 覆盖（`~/`、相对、绝对）三种输入的取值。
- CLI 侧契约测试：数据根变化时信任库位置随之变化；损坏文件仍 `corrupt`。
- 服务侧：`hooksService` 读取的信任库路径与 `identity-paths-node` 单源结果一致（禁止内联
  再实现一份）。
