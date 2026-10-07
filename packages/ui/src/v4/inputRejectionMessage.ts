/**
 * `snapshot.inputRouting.mode === "reject"` 时给用户看的「为什么不能输入」文案映射。
 *
 * reasonCode 是 CLI 侧的机器可读码（`zcode-protocol-v4/snapshot.ts` 的
 * `inputRouting.reasonCode`，可选字符串）。UI 只做码 → i18n message id 的翻译；不认识的码
 * 一律落到通用文案——受限会话必须给得出原因，渲染成「暂无原因」等于没有解释。
 *
 * 纯函数模块：不 import React / i18n 运行时，node:test 能直接跑。
 */

const INPUT_REJECTION_MESSAGE_IDS: Record<string, string> = {
  // 子会话的 launch spec 读不到（身份未能还原）→ 受限模式（spec 的 S4 前置 1）。
  "guard.subagentLimitedMode": "subagents.pane.limitedMode",
};

export function resolveInputRejectionMessageId(reasonCode: string | undefined): string {
  if (reasonCode === undefined) return "subagents.pane.inputRejected";
  return INPUT_REJECTION_MESSAGE_IDS[reasonCode] ?? "subagents.pane.inputRejected";
}
