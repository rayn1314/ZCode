// ============================================================
// 辅助对话（selection side chat）专属身份段
// ============================================================
//
// 辅助对话是普通会话 fork（`taskType === "selection_side_chat"`），默认拿到与主 Agent 完全相同
// 的身份提示词，其中还包含「自主行动、可改就改」的行为边界。唯一约束它「不要接父任务」的信号
// 是一条 user 角色的合成边界消息，权重远低于 system 层。这里在 system 层补一段显式身份：
// - 明确自己是父任务开出的辅助对话，不是主 Agent；
// - 父对话历史只是参考，不得自动续做父任务；
// - 用户消息末尾的 `# userselect:` 块是引用选段，回答必须围绕它。

import type { ContextBuilder } from "../builder.js";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

const SELECTION_SIDE_CHAT_IDENTITY_PROMPT = [
  "You are an auxiliary conversation opened from a parent task, not the main agent.",
  "The preceding conversation was inherited from the parent task and is for reference only.",
  "Messages in this side chat are new, independent topics: answer the user's question directly and do not continue the parent's active work.",
  "Continue the parent's active work only when the user explicitly asks you to take it over.",
  'If the user\'s message ends with a "# userselect:" fenced block, that block is the passage the user quoted — base your answer on it.',
].join("\n");

export function buildSelectionSideChatIdentitySection(): ContextSection {
  const content = SELECTION_SIDE_CHAT_IDENTITY_PROMPT;
  return {
    name: "Auxiliary Side Chat Identity",
    source: "selection_side_chat_identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

/** 仅对 `selection_side_chat` 注入；其余 taskType 不产生任何额外段。 */
export function addSelectionSideChatIdentityIfNeeded(
  builder: ContextBuilder,
  taskType: string | undefined,
): void {
  if (taskType === "selection_side_chat") {
    builder.addSection(buildSelectionSideChatIdentitySection());
  }
}
