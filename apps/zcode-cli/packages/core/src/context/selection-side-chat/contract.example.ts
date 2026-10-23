/**
 * selection-side-chat 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 构建辅助对话上下文时的唯一调用：把会话的 `taskType` 交给注入函数，由它决定是否加身份段。
 */
import type { SelectionSideChatBuilder, SelectionSideChatContract } from "./contract.js";

export function exampleSelectionSideChat(
  contract: Pick<SelectionSideChatContract, "addSelectionSideChatIdentityIfNeeded">,
  builder: SelectionSideChatBuilder,
  taskType: string | undefined,
): void {
  contract.addSelectionSideChatIdentityIfNeeded(builder, taskType);
}
