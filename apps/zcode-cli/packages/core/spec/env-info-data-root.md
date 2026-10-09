# Environment 段的身份数据根声明

- 主责包：`apps/zcode-cli/packages/core`
- 涉及其它包：`apps/zcode-cli/packages/contracts`（只读复用 `resolveZCodeDataRoot`，无改动）；
  共享域判据沿用 `packages/desktop/spec/product-identity-data-root.md`（无改动）

## 背景与问题

系统提示词里原先没有任何一段声明「本进程的数据根在哪」。模型对数据根的全部认知来自上下文里
出现过的路径字面量，而这些字面量压倒性地指向共享域 `~/.zcode`（用户级 AGENTS.md 注入头、
skills 列表路径、内置 prompt 命令文案、workspace 的 `.zcode/` 目录、记忆索引本身）。

后果（用户实测）：自建身份（数据根 `~/.zcode-rayn`）的会话里，模型查会话库、日志、凭据时
频繁落到官方根 `~/.zcode` 上——查到的是另一个产品身份的数据；而真正按身份隔离的路径躲在
`resolveZCodeDataRoot()` 后面，从不出现在提示词里，模型只能靠猜。

## 设计决策

1. **在 Environment 段注入一行 `User data root`**，由 `buildEnvInfoContent` 在渲染期调用
   `resolveZCodeDataRoot()` 解析当前进程的真实数据根，并附共享域说明（用户级
   skills / commands / plugins / AGENTS.md 刻意共享、仍在 `~/.zcode`）。
2. **渲染期解析而不是走 `EnvInfo` 字段**：`EnvInfo` 在 resume 时优先取持久化快照
   （`resume.ts` 的 `extractPersistedEnvInfo`），旧会话快照没有该字段且会跳过重新探测，
   经 `EnvInfo` 传递会让最需要它的「恢复的旧会话」拿不到声明；渲染期取进程 env 是当下事实。
3. **只在数据根 ≠ 常规根 `~/.zcode` 时注入**：官方构建（空后缀、无覆盖）解析结果就是常规根，
   此时模型的天然假设本就正确，不注入——官方提示词逐字保持原文，也不占缓存 token。
4. **比较按 `resolve()` 归一 + Windows 大小写不敏感**：避免 `ZCODE_DATA_ROOT` 覆盖值的
   分隔符/大小写差异把常规根误判成非常规根。

## 行为

- 数据根非常规时，Environment 段在 OS Version 之后出现：
  `- User data root: <绝对路径> (user-level skills / commands / plugins / AGENTS.md are intentionally shared and stay under <home>/.zcode)`
- 数据根为常规 `~/.zcode` 时（官方构建且无覆盖），不出现该行。
- 该段是 `cacheHint: "dynamic"` 的 system 段，随上下文构建重新解析；自定义 system prompt
  路径跳过 Environment 段的行为不变。

## 所有权与不变式

- 数据根解析的唯一入口是 contracts 的 `resolveZCodeDataRoot()`（单源
  `@zcode/shared/identity-paths-node` 的 `resolveIdentityDataRoot`）；本段不自行拼 `.zcode`。
- 共享域清单（skills / commands / plugins / AGENTS.md 刻意共享 `~/.zcode`）不在此处重新定义，
  判据唯一落在 `packages/desktop/spec/product-identity-data-root.md`。
- 声明行不进入持久化消息历史（Environment 段本就每次构建重新生成）。

## 失败语义

- `resolveZCodeDataRoot()` 是纯字符串运算，不触盘、不抛错；解析异常不存在失败分支。
- 覆盖值非法（不存在的路径）时照原样声明——声明反映进程实际使用的根，不做存在性校验。

## 迁移边界

- 无数据迁移。已存在会话在下一次上下文构建（新会话 / resume / context refresh）时自动获得声明。
- 不改动 `EnvInfo` 契约与持久化快照格式。
