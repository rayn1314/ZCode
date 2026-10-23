# 辅助对话身份段

意图：辅助对话与主 Agent 共用同一份 system prompt（含「自主行动、可改就改」），原来只有一条 user
角色的合成边界消息约束它「不接父任务」，权重太低。本模块在 **system 层**补一段稳定身份：不是主
Agent、父历史只是参考、默认把每条消息当新话题、明确要求才接手、`# userselect:` 是引用选段。

不变量：

- 唯一写入点是 `addSelectionSideChatIdentityIfNeeded`，判据固定 `taskType === "selection_side_chat"`；
  文本不得在别处复制。
- 段只进 `system`、`cacheHint: "stable"`、`source: "selection_side_chat_identity"`。
- 段不进持久化消息历史；每次构建上下文（含冷恢复 resume）重新生成。
- `taskType` 缺失时**不注入**，行为回退到改动前，不抛错。

与其它模块的交集（hook 点）：

- 注入时机：`core/src/runtime/methods/context.ts` 在构建上下文时按会话 `taskType` 调用本模块。
- 新建辅助对话的 fork 边界消息（`session-fork.ts` 的 `SELECTION_SIDE_CHAT_BOUNDARY`）另有一条，
  与本段互补：边界消息只影响新建会话，身份段对冷恢复同样生效。
- 引用块的序列化格式（`# userselect:` + JSON）归 UI（`conversationSelectionReference.ts`），
  本模块不解析、不生成引用，只在身份段里解释它的含义。

相关 spec：`apps/zcode-cli/packages/core/spec/selection-side-chat-identity.md`。
