import type { Logger, ModelInputMessage } from "@zcode/contracts";
import type { ReasoningReplayShape } from "../reasoning-replay-diagnostics.js";

/**
 * model-replay-diagnostics 对外契约：把「将要发出的请求里推理内容是什么形态」压缩成四个计数，
 * 写进按天保留的主日志，让偶发 400（思考模式要求回传 reasoning_content）事后可取证。
 *
 * 背景与取舍见 spec：`apps/zcode-cli/packages/core/spec/model-reasoning-replay-declaration.md`（D5）。
 * 本模块是**只读诊断**：不修改消息、不参与请求构造、不写任何业务数据；计数口径必须与落库过滤
 * （core 的 `hasAssistantReasoningContent`：文本为空且无 providerOptions 的推理块会被丢弃）保持一致，
 * 否则「本来就没有推理」与「推理被过滤掉」两种情形无法区分。
 */

// 真实导出：runner 真正调用的两个函数（`summarizeReasoningReplay` 纯函数、`logReasoningReplayShape` 落日志）。
export {
  logReasoningReplayShape,
  summarizeReasoningReplay,
} from "../reasoning-replay-diagnostics.js";
export type { ReasoningReplayShape } from "../reasoning-replay-diagnostics.js";

/** 一次请求的推理回放计数（四个计数口径见实现注释）。 */
export interface ModelReplayDiagnosticsContract {
  /**
   * 纯函数统计：按 assistant 消息累计计数。
   * 前置：无；`content` 为字符串按「没有结构化内容块」处理。
   * 后置：不改入参、无 IO、结果由入参唯一决定，因此可重复调用。
   */
  summarize(messages: readonly ModelInputMessage[]): ReasoningReplayShape;
  /**
   * 记录一次请求的推理回放形态：写一行 `info`（`event: "model.reasoning.replay.shape"`）。
   * 前置：请求已构造完成（对**将要发送的**历史统计才有意义）。
   * 后置：请求不含 assistant 消息（如首轮）时不写日志；无返回值，不等待持久化，失败静默。
   * 只写日志、不改请求，因此重复调用只多一行同样的诊断。
   */
  logShape(input: ReasoningReplayLogInput): void;
}

/** `logShape` 的入参：`logger` 缺省表示当前上下文不落日志（如未注入 logger 的调用点）。 */
export interface ReasoningReplayLogInput {
  logger?: Logger;
  messages: readonly ModelInputMessage[];
  modelId: string;
  providerId: string;
}
