/**
 * selection-side-chat 对外契约
 * （spec: apps/zcode-cli/packages/core/spec/selection-side-chat-identity.md）。
 *
 * 模块意图：辅助对话（`taskType === "selection_side_chat"`）走普通会话 fork 路径，默认拿到与主 Agent
 * **完全相同**的 system prompt（含「自主行动、可改就改」的行为边界）；唯一约束它「不要接父任务」的
 * 信号原是一条 user 角色的合成边界消息，权重远低于 system 层。本模块在 system 层补一段稳定的身份段：
 * 自己是父任务开出的辅助对话而不是主 Agent、父对话历史只是参考、默认把侧边对话里的每条消息当新话题、
 * 只有用户明确要求接手才继续父任务，并解释用户消息末尾 `# userselect:` 引用块的含义。
 *
 * 类型表达不了的不变量：
 * - 身份段的**唯一写入点**是 `addSelectionSideChatIdentityIfNeeded`；判定条件固定为
 *   `taskType === "selection_side_chat"`，不得在别处复制这段文本（复制即两处漂移）。
 * - 段只进 `system` 注入目标、`cacheHint: "stable"`（内容恒定，可被缓存），
 *   `source` 固定为 `selection_side_chat_identity`（供按 source 过滤的既有逻辑识别）。
 * - 段**不进入持久化消息历史**：每次上下文构建时由 runtime 重新生成，冷恢复同样重新执行注入。
 * - `taskType` 缺失（旧记录）时不注入，行为回退到改动前——这是可接受的降级，不抛错。
 */
import {
  addSelectionSideChatIdentityIfNeeded,
  buildSelectionSideChatIdentitySection,
} from "../sections/selection-side-chat.js";

export { addSelectionSideChatIdentityIfNeeded, buildSelectionSideChatIdentitySection };

/** 身份段本身；`source` 恒为 `selection_side_chat_identity`，`injectionTarget` 恒为 `system`。 */
export type SelectionSideChatIdentitySection = ReturnType<
  typeof buildSelectionSideChatIdentitySection
>;
/** 注入目标：现有 `ContextBuilder`（`../builder.js`），段经其 `addSection` 进 system 层。 */
export type SelectionSideChatBuilder = Parameters<typeof addSelectionSideChatIdentityIfNeeded>[0];

/**
 * 模块对外契约面（两个意图，纯内存操作，无 IO、不产生事件、不持久化）。
 * 真实实现见 `../sections/selection-side-chat.ts`。
 */
export interface SelectionSideChatContract {
  /**
   * 构造辅助对话身份段。
   *
   * 前置：无（纯函数，不读任何外部状态）。
   * 后置：返回 `injectionTarget: "system"`、`cacheHint: "stable"`、`source:
   * "selection_side_chat_identity"` 的段，内容含「不是主 Agent / 新话题优先 / 明确要求才接父任务 /
   * `# userselect:` 是引用选段」四点。
   * 幂等：同次构建内重复调用得到等值段。不产生事件、不持久化。
   */
  buildSelectionSideChatIdentitySection(): SelectionSideChatIdentitySection;

  /**
   * 按会话 `taskType` 决定是否把身份段加进 context builder。
   *
   * 前置：`builder` 是正在构建的上下文 builder；`taskType` 取自会话 runtimeConfig。
   * 后置：只有 `taskType === "selection_side_chat"` 时调用 `builder.addSection` 一次；
   * 其余取值（含 `undefined`，旧记录）不产生任何段。
   * 幂等：判定纯读，可重复调用；重复调用会按调用次数各加一段（调用方负责只调一次）。
   * 不产生事件、不持久化。
   */
  addSelectionSideChatIdentityIfNeeded(
    builder: SelectionSideChatBuilder,
    taskType: string | undefined,
  ): void;
}
