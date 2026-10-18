# 以当前上下文分叉（Fork at Current Context）

主责包：`apps/zcode-cli/packages/core`。

涉及的其他包：

- `apps/zcode-cli/packages/bootstrap`：命令面（`forkCurrentContext`）、投影可见性与网关接线；与相邻能力 `forkStableConversation` 的边界。
- `packages/shared`：v4 命令 schema、命令结果 schema。
- `packages/ui`：会话工具栏入口与子会话首屏。

本文与 `packages/ui/spec/compact-summary-block.md` 是**两件正交的事**：本文只管"分叉复制什么"，那份只管"摘要怎么显示"。两者共用"压缩摘要"这个实体，但互不依赖：摘要块开不开、展不展开，都不改变本文的复制口径。

---

## 1. 背景与问题

ZCode 的分叉只有一种语义：**回到某条消息那一刻**。它由 `forkAssistant` 命令驱动，锚点必须是"某轮的最后一条 assistant 文本行"（投影层 `guard.forkAssistantOnly`），复制口径是"该锚点之前的完整可见转录"（`activeForkTranscriptMessages`，注释明确写着不做 compact provider scope 裁剪）。

这带来两个问题：

1. **压缩之后没有可分叉的锚点。** 手动 `/compact` 落库的是"一条 `uiVisibility: hidden` 的 compact summary user 消息 + 一条 compaction 分隔线"，**不产生 assistant 行**。因此对话结束、手动压缩之后，用户能点的最后一个分叉锚点仍在压缩之前；分叉出来的子会话既没有摘要也没有 compact boundary，模型上下文是压缩前的全量历史。"以压缩后的状态开一条新分支"这件事在当前模型里表达不出来。
2. **即使锚点落在压缩之后，复制口径也不是上下文口径。** 子会话携带完整可见转录（含被压缩掉的旧 worklog），只有模型侧靠一并复制过去的 boundary 在冷恢复时裁剪。于是"用户看到的"和"模型看到的"不一致，且这种不一致无法被用户验证。

此外，压缩在分叉模型里还表现为一个**抑制状态**而不是一个节点：投影层 `!compactActive` 会在压缩进行中直接关掉分叉。压缩进行中禁止分叉是对的（不该分叉到半截状态），但压缩结束后并不存在"以压缩结果分叉"的入口。

## 2. 设计决策

**D1 新增命令 `forkCurrentContext`，不带 row target。**
语义是"以当前上下文状态开一条新分支"。现有 `forkAssistant`（按行回溯分叉）语义与约束完全不变。理由是两者复制口径不同（上下文 vs 可见转录），合并进一个命令会让 `guard.forkAssistantOnly`、`isLatestAssistantSegmentRow` 这类锚点约束失去意义。

**D2 复制口径 = 当前模型可见上下文。**
唯一来源是 core 的 `activeSessionMessages`（模型恢复语义）：

| 父会话状态  | 复制内容                                                       |
| ----------- | -------------------------------------------------------------- |
| 无压缩      | 完整可见转录（active branch 裁剪后）                            |
| 有压缩      | 最后一个 compact boundary 起：摘要消息 + 之后的对话 + 保留段    |

这是"以当前状态"唯一无歧义的定义：子会话首次 provider 请求的消息集与父会话当前上下文一致。"压缩后分叉得到压缩后的状态"由此自动成立，不需要为压缩单独写规则。

**D3 子会话首屏 = 摘要块 + boundary 之后的对话。**
摘要消息的 `uiVisibility: hidden` 与 `transcriptVisibility: hidden` 不变（它仍不是用户气泡），它以压缩分隔线上的可折叠块呈现，见 `packages/ui/spec/compact-summary-block.md`。本文不定义该块的形态。

**D4 闸门沿用现有语义，不引入新的停止语义。**
- 压缩进行中（投影 `activeWorks` 含 `compact`）时**入口不可用**：这一层判定留在 UI/投影侧（与 `forkAssistant` 的 `canFork` 同款），core 不新增"是否正在压缩"的运行时标志 —— 运行时没有这个事实，硬造一个就是第二个判定源；
- 父会话有未完成 turn 时按现有 CAS（`envelope.baseRevision`）裁决；
- 本命令不读 `activeAbortController`、不 stop 父 runtime、不复制 workspace checkpoint（与 `forkStableConversation` 同款"conversation-only fork"）。

**D5 goal 边界取当前 target 的快照。**
与现有路径一致，使用 `kind: "snapshot"`；active run 的三个瞬时字段（`activeInputId` / `activeRunStartedAtMs` / `activeRunLastSeenAtMs`）不复制。

**D6 boundary 不再要求是 assistant。**
现有两处硬约束必须只对 `forkAssistant` 生效，`forkCurrentContext` 各自放行：
- `v4-bridge` 里 `boundary?.info.role !== "assistant"` 的断言；
- core 里 `stableForkHistoryMessages` 的"segment 末尾必须是完成态 assistant"校验。
新命令自己构造 segment（`activeSessionMessages` 的结果），因此不复用该校验；`forkAssistant` 路径保持原样。

## 3. 行为

| 环节        | 行为                                                                         |
| ----------- | ---------------------------------------------------------------------------- |
| 入口        | 会话工具栏独立按钮（非消息行 hover 工具栏）；不在压缩分隔线上重复提供入口。   |
| 命令载荷    | 仅 `baseRevision` / `logEpoch` 等 CAS 字段，无 row target。                  |
| 解析        | 读父会话消息 → `activeSessionMessages` → segment = 结果全体，boundary = 末条。 |
| 复制        | `commitAtomicConversationFork`，`messages = segment`，`targetMessageId = 末条 id`。 |
| 结果        | 返回 `{ type: "forkCurrentContext", sessionId }`；UI 原地切到子会话。         |
| 子会话首屏  | 摘要块（若有压缩）+ boundary 之后的对话 + fork notice 分隔线。               |

## 4. 所有权与不变式

- **唯一所有者**：复制口径的唯一权威是 `activeSessionMessages`。禁止出现"可见气泡走一套、模型上下文走另一套"的双口径实现。
- **I1**：子会话首次 provider 请求的消息集，与父会话当前上下文一致（合成项 fork notice、model selection entry 除外）。
- **I2**：父会话零副作用 —— 不 stop、不改 workspace 文件、不写父的 message/part 表（只追加 fork 事件）。
- **I3**：segment 必须是 active branch 上的连续段，且必须整体落在最后一个 compact boundary 之内（不允许"跨压缩点拼接"）。
- **I4**：压缩摘要消息被复制时，其 `semantics`（hidden/provider-visible）逐位保持，不因复制而升级为可见气泡。
- **I5**：`forkAssistant` 的全部既有约束不变（锚点是最新轮尾 assistant、需 `canFork`、需 stable anchor）。

## 5. 失败语义

| 情形                          | 行为                                                             |
| ----------------------------- | ---------------------------------------------------------------- |
| 会话无 record / 无 store      | 现有错误码（`proto.sessionNotFound` / `fault.command.stableForkStoreUnavailable`）。 |
| 上下文为空（新会话没有任何消息） | 拒绝，不创建空子会话。                                            |
| 消息读取失败                  | 向上抛错。**禁止**静默降级为"复制完整可见转录"。                  |
| CAS 落后                      | 现有 `baseRevision` 拒绝路径，不重试。                            |

## 6. 迁移边界

- **旧会话（无 compact boundary）**：复制结果与"在最后一条 assistant 上分叉"在模型上下文层面等价（可见转录里多出的 hidden 消息本来就不进 provider）。因此这个入口对新旧会话都成立，不需要数据迁移。
- **远端链路**：命令走 v4 命令面，`web-remote-replayable` 与 `desktop-continuous` 均无新增业务状态；子会话由既有 fork commit 路径原子创建。
- **回滚**：入口只是 UI 按钮 + 一条命令，去掉按钮即回落现状，无数据格式变更。
