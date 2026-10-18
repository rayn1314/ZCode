# 压缩摘要可开关显示（Compaction Summary Block）

主责包：`packages/ui`。

涉及的其他包：

- `packages/shared`：会话消息投影策略（`conversation-message-projection-policy.ts`）、v4 只读读端命令 schema。
- `apps/zcode-cli/packages/bootstrap`：投影已下发 `summaryRef`；新增只读读端 handler。
- `apps/zcode-cli/packages/core`：摘要消息的落库形态（不改）。

本文与 `apps/zcode-cli/packages/core/spec/fork-at-current-context.md` 是**两件正交的事**：本文只管"摘要怎么显示"。摘要块的展开状态不落库、不进协议、不参与分叉复制口径 —— 关着也能以当前状态分叉。

---

## 1. 背景与问题

压缩摘要**一直存在且完整落库**：`persistCompactSummary` 写一条 `role: "user"` 的消息，带 `semantics: { kind: "compact_summary", uiVisibility: "hidden", providerVisibility: "visible", transcriptVisibility: "hidden" }`，正文在 `summary.body`（实测 1.6 万 ~ 2.3 万字符，形态是 `Summary:` + 固定九段）。

但用户在任何界面都看不到它：

1. `getConversationMessageProjectionPolicy`（`packages/shared/src/conversation-message-projection-policy.ts:87`）对 `kind === "compact_summary"` 直接返回 `providerContextOnly`，正文被投影丢弃，UI 上只留一条 compaction 时间线分隔线。
2. 协议层其实**已经**把摘要引用送到了前端：v4 `timelineMarker` 的 `type: "compact"` 带 `summaryRef`（`rows.ts`），bootstrap 投影真的填了它（`product-projection.ts` 的注释原文："summary 全文按 ref 拉（同 toolOutput/get）；以 summaryMessageId 占位"）。
3. 但整个 `packages/ui` 从未消费 `summaryRef`，代码库里也不存在 `toolOutput/get` 这个命令 —— 注释里引用的先例并不存在。**管道铺了一半：线索到位、读端缺席、前端不接。**

结果是用户无法验证"压缩到底压了什么"，也无法审计摘要质量。本文把这条管道接通，并把呈现形态定为"默认折叠、可展开查看"。

## 2. 设计决策

**D1 摘要正文按 ref 懒加载，不进投影快照。**
正文是 2 万字符量级，进快照会放大 payload 与快照体积，而它绝大多数时间不被查看。新增一个只读读端按 `sessionId + messageId` 取消息正文；`summaryRef` 保持"只下发引用"的现状。

**D2 只展示落库的摘要正文。**
展示 `summary.body`（即 `Summary:` + 九段），**不展示**给模型拼接的那段指令包装（`buildCompactSummaryMessage` 的 "This session is being continued…" 头部、`suppressFollowup` 后缀、"Recent messages are preserved verbatim." 等）。理由是这些是模型侧的续跑指令，属于实现细节，且会误导用户以为摘要本身包含它们。

**D3 呈现形态 = 现有压缩分隔线升级为可折叠块，默认折叠。**
复用现有 `MarkerDividerRow`（`ConversationRowView.tsx`）作为块头，不新造分隔线；展开区复用仓库既有 `Collapsible` 组件（`ModelTrajectoryExpandableMessage.tsx` 等已有先例）。

**D4 折叠状态是 UI 本地状态。**
不进协议、不落库、不广播、不影响会话内容与 provider context。这是它能与分叉口径正交的前提。

**D5 无摘要可看时保持纯分隔线。**
`status: running | failed | cancelled | noop`、或 `summaryRef` 缺失、或拉取失败时，分隔线形态与现状完全一致，不显示展开入口（不出现"点开是空的"）。

## 3. 行为

### 3.1 块头（折叠态与展开态相同）

| 元素       | 内容                                                                                        |
| ---------- | ------------------------------------------------------------------------------------------- |
| 左侧分线   | 现有 `MarkerDividerRow` 的线段，不变。                                                      |
| 图标       | 现有压缩图标，不变；`running` 时仍隐藏图标 + 流光文案，不变。                               |
| 文案       | 现有 i18n 文案（`chat.contextCompaction.completed` 等），不变。                             |
| token 变化 | 新增：`tokensBefore → tokensAfter`（两者都存在时显示），如 `128k → 21k`；缺任一项则不显示。 |
| 展开指示   | 新增：仅当有摘要可看时出现（箭头/加号），`aria-expanded` 反映当前状态。                     |

### 3.2 展开区

| 状态     | 表现                                                                       |
| -------- | -------------------------------------------------------------------------- |
| 折叠     | 不渲染正文，块头保持一行。                                                 |
| 加载中   | 展开区显示加载文案；块头保持可见。                                         |
| 有内容   | 显示摘要正文，等宽/正文字体，`max-h` 限高 + 内部滚动，保留换行；文本可选。 |
| 空内容   | 显示"摘要为空"；不自动收起。                                               |
| 拉取失败 | 显示失败文案 + 重试入口；**不阻断**会话继续渲染，不弹全局错误。            |

### 3.3 交互

- 点击块头（或展开指示）切换展开/折叠；折叠态与展开态都可点击。
- 展开是只读展示，不提供编辑、不复制进输入框（与工具输出卡的既有交互区分）。
- 键盘可达：块头是 `<button>`，`Enter`/`Space` 可切换。

### 3.4 文案与 i18n

新增文案全部进 i18n（`zh-CN` / `en-US`），key 语义：展开摘要、摘要加载中、摘要为空、摘要加载失败、重试、token 变化格式化。文案不得写死具体 token 数字。

## 4. 所有权与不变式

- **唯一所有者**：摘要正文的权威是会话存储里的那条 `compact_summary` 消息；UI 是只读消费者，任何情况下都不写回。
- **I1**：显示开关只影响渲染。`providerVisibility` / `transcriptVisibility` / provider context 一个字节都不变；展开与否不改变"模型看到什么"。
- **I2**：懒加载只读、幂等、可重复；同一 ref 的重复展开不重复计费式地反复请求（允许缓存最近若干条结果）。
- **I3**：摘要消息仍**不是**用户气泡 —— `providerContextOnly` 策略保持不变，气泡序列里不出现它。
- **I4**：`summaryRef` 缺失时降级为纯分隔线，不视为错误。
- **I5**：块头 / 分隔线的视觉与既有 fork / goal / modelChange 分隔线保持同款（同组件），不引入新的分隔线样式。

## 5. 失败语义

| 情形                        | 行为                                                         |
| --------------------------- | ------------------------------------------------------------ |
| 读端不可用（旧宿主/旧版本） | 与 `summaryRef` 缺失同款降级：纯分隔线，不报错、不重试轰炸。 |
| 读端返回未找到消息          | 展开区显示失败文案 + 重试；不静默显示空内容。                |
| 正文字符数异常（超大）      | 正常展示，靠限高 + 滚动吸收；不截断正文，不新增截断标记。    |

## 6. 迁移边界

- **历史会话**：摘要消息与 `summaryMessageId` 早已落库，无需数据迁移；旧会话的 marker 若没有 `summaryRef`（更早的投影产物），首次重新投影后即带 ref。
- **打包版 / 远端**：读端是只读命令，`desktop-continuous` 与 `web-remote-replayable` 都不新增业务状态；旧宿主不认识该命令时的降级路径见 §5。
- **回滚**：去掉块头展开入口即回到现状（纯分隔线），协议与数据格式不变。
