# 会话消息信封的对话流呈现（spec）

涉及包：`packages/ui`（主责：信封解析、气泡渲染、编辑回写）。

上游语义见 `apps/zcode-cli/packages/core/spec/subagent-session-messaging.md`（该 spec 的
「遗留工作评估 / B3」把本条列为待拍板的产品取舍，本 spec 是它的落地）。

## 背景与问题

跨会话投递（`SendMessage`）最终都经 v4 `sendText` 注入目标会话。为了让模型能区分"这是别的
会话发来的，不是用户本人说的"，投递文本被包成一段机器信封：

```
<session-message source="session-message" message_id="msg_…" from_session="sess_…" sender_kind="session" hop="1" origin="msg_…" created_at="2026-10-04T16:31:42.370Z">
测试消息：……
</session-message>
```

信封对**模型**是对的（属性带链深与来源、正文明确标注"仅供参考"）。但 `sendText` 产出的是一条
**用户消息**，于是 `ConversationRowView` 把整段信封当正文渲染——用户在对话流里看到自己"说"了
一串 XML 属性和英文样板句。三个产出方都会这样：

| 产出方                                                 | `source`          | 位置                                                           |
| ------------------------------------------------------ | ----------------- | -------------------------------------------------------------- |
| Host 实时投递                                          | `session-message` | `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` |
| CLI mailbox drain 的 PostToolUse `enqueuePendingInput` | `mailbox`         | `apps/zcode-cli/packages/core/src/hooks/session-mailbox.ts`    |
| 投递回执                                               | `delivery-result` | 同上 services 文件                                             |

（mailbox 的 `UserPromptSubmit` / `Stop` 两条走 `additionalContext`，本来就是模型上下文、不进
对话流，不受本 spec 影响。）

顺带解决了 core spec B3 记的另一件事：用户在界面上从此能看到「这条消息从哪个会话来」。

## 设计决策

- **只在渲染层加工，不改注入文本。** 信封的字节形态是模块级冻结契约（`session-mailbox.ts`
  与 core spec 都写明"注入文本与旧版逐字节一致"，有测试断言逐字匹配）。改动它要动 services +
  CLI + 远端链路，且会让 `hop`/`origin` 这类模型侧信息失去既有口径。因此本方案一个字节都不动
  注入文本，只在 UI 把信封**解析出来**再渲染。
- **走既有的「上下文引用」管道，不新造渲染通路。** 对话流已经有一套完全同构的机制：用户在正文
  尾部插入机器块（`userselect` / code comment / web element / pptx），`ConversationRowView`
  用 `parseComposerPromptContexts` 把它拆成「可见正文 + 结构化引用」，引用以 pill + 悬浮详情
  呈现。会话消息信封正好是同一类东西（机器块对用户不可读），所以作为**第五类上下文**接进去，
  与该管道共用 `ContextAttachmentPill` 外壳、共用 `hasContextReferences` 布局分支。
- **必须参与编辑回写（round-trip），不能只做显示期剥离。** 编辑态提交走
  `serializeComposerPromptContexts(nextText, editPromptContexts)`——它按 `editPromptContexts`
  重新拼回各类机器块（见 `ConversationRowView` 的 `handleSubmitEdit`）。所以解析出的信封
  必须**保留原始文本**并在序列化时原样拼回；否则用户编辑一次历史消息，信封就被永久删掉，
  模型侧的历史与防环链来源字段一起丢失。这是本方案与"只做显示剥离"的关键区别。
- **解析只认强特征，认不出就当普通正文。** 判定条件为：成对出现 `<session-message …>` /
  `</session-message>`，且开标签带 `message_id` 属性。不枚举 `source` 取值，这样将来新增
  产出方（新的 `source`）不需要同步改 UI；而普通用户不可能手打出 `message_id` 这种属性，
  误吞真实文本的概率可忽略。任何不完整的信封都保持原样显示，绝不吞掉用户内容。
- **正文里的英文样板句不进卡片。** 信封内可能带一行给模型看的
  `For reference only. …`（mailbox 与回执各有措辞）。卡片自身已表达"这是别的会话发来的、供
  参考"，再显示英文样板句只是噪音，因此在**展示正文**里剔除；`raw` 里保留，回写不受影响。
- **只加不改：可见正文为空时不留空气泡。** 整条消息只有信封时（最常见），可见正文解析为空，
  `hasVisibleText` 为 false，行内只剩 pill——这正是文件附件消息的既有形态，不需要新分支。
- **pill 只读，不给删除入口。** 输入框里的其它上下文由用户自己添加，所以可删；信封是投递方
  冻结的协议文本，允许在对话流里删掉它，历史消息的防环链来源（`hop`/`origin`）就永久丢了。
  因此编辑态只开放可见正文，信封由 round-trip 原样带回。为此 `ContextAttachmentPill` 的
  `removeLabel` 与 `onRemoveAll` 收敛成"成对出现"的联合类型，只读 pill 两者一起缺席。

## 行为

| 环节     | 位置                                                         | 行为                                                                                                      |
| -------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 解析     | `packages/ui/src/lib/sessionMessageEnvelope.ts`              | `parseSessionMessageEnvelopes(text)` → `{ visibleContent, messages[] }`；剥离所有信封并归整空白           |
| 引用结构 | 同上                                                         | `{ raw, source?, messageId, fromSessionId?, senderKind?, hop?, origin?, createdAt?, requestId?, body }`   |
| 序列化   | 同上                                                         | `buildPromptWithSessionMessageEnvelopes(visibleContent, messages)` 按 `raw` 原样拼回，保证编辑 round-trip |
| 管道接入 | `packages/ui/src/v4/composer/composerPromptContexts.ts`      | 作为第五类 `sessionMessages` 参与 count / serialize / parse                                               |
| 渲染     | `packages/ui/src/v4/ConversationRowView.tsx`                 | pill 与悬浮详情；进入 `hasContextReferences`                                                              |
| 卡片     | `packages/ui/src/v4/composer/SessionMessageEnvelopeChip.tsx` | 复用 `ContextAttachmentPill`；label 按 `source` 区分消息/回执；只读无删除入口                             |
| 文案     | `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`              | `chat.sessionMessage.*`（消息 / 多条计数 / 回执 / 第 {hop} 跳）                                           |

序列化顺序是既有不变式的关键：**serialize 与 parse 必须严格相反**（该文件头注释已写明）。
信封排在序列化末尾（可见正文 → selections → codeComments → webElements → pptxElements →
sessionMessages），因此解析时**最先**跑信封解析，再按原顺序反向剥其余四类。

## 所有权与不变式

- **注入文本仍由 services / CLI 拥有**，UI 只读：UI 侧不生成信封、不修改信封字节。
- **round-trip 保真**：对任意文本，`build(parse(text).visibleContent, parse(text).messages)`
  与原文等价（信封本身逐字节相同，位置统一归到可见正文之后）。
- **不吞正文**：解析失败 / 半截信封 / 只有正文 → `visibleContent` 原样返回，`messages` 为空。
- **正文只读**：`body` 只用于展示与测试，回写一律用 `raw`，因此剔英文样板句不会造成数据丢失。

## 失败语义

- 信封未闭合（只有开标签）：整条按普通正文渲染，不剥离。
- 属性缺 `message_id`：不认作信封，按普通正文渲染（避免误吞用户手打内容）。
- JSON/属性异常：属性解析用宽松的 `key="value"` 扫描，单个属性异常只影响该属性，不影响整条识别。

## 迁移边界

- **历史消息无需迁移**：还原走渲染期解析，因此修复前已经落库的消息同样会正常显示（与
  `parseConversationShareContext` 保留对旧 markup 的解析同一思路）。
- 远端 workspace / 手机 Web 复用同一渲染层，自动受益。
- 不引入新的协议帧、不改 `packages/shared` 的 schema；`source` 取值集合将来扩展时 UI 无需改动。

## 验证

- `packages/ui/test/sessionMessageEnvelope.test.ts`：
  1. 整条消息就是实时信封 → `visibleContent` 为空、1 条引用、`hop`/`origin` 解析到位；
  2. mailbox 信封 → 英文样板句从 `body` 剔除，`raw` 保留原句；
  3. 可见正文 + 信封混排 → 可见正文保留、空白归整、信封被剥离；
  4. 一条消息内多个信封 → 全部解析，顺序稳定；
  5. `source="delivery-result"` → 识别为回执，`requestId` 解析到位；
  6. **round-trip**：`build(parse(text))` 与原文等价（含整条信封与混排两种）；
  7. 纯用户文本 / 半截信封 / 缺 `message_id` → 一律原样保留、`messages` 为空；
  8. 与既有四类上下文共存时，`parseComposerPromptContexts` 的可见正文与各类引用数量正确。
- 手工验收路径：让另一个会话给当前会话发一条消息，对话流里应显示「来自另一个会话的消息」
  pill，正文在悬浮卡片里可读，且不再出现 XML 属性与英文样板句；对该行点编辑再提交，信封仍在
  （round-trip 未丢协议字段）。
