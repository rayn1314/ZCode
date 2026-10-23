/**
 * model-replay-diagnostics 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { Logger, ModelInputMessage } from "@zcode/contracts";
import {
  logReasoningReplayShape,
  summarizeReasoningReplay,
  type ModelReplayDiagnosticsContract,
} from "./contract.js";

/** 契约对象就是两个真实导出函数本身，没有额外包装层。 */
export const exampleModelReplayDiagnostics: ModelReplayDiagnosticsContract = {
  summarize: summarizeReasoningReplay,
  logShape: logReasoningReplayShape,
};

/**
 * 最常见的一次完整调用，与 runner 在 `projectRequestHistory` 之后的落点一致：
 * 对**将要发送的**消息统计并写一行主日志（此处用真实 logger；缺省不传则完全不落盘）。
 */
export function logExampleReasoningReplay(
  logger: Logger,
  messages: readonly ModelInputMessage[],
): void {
  logReasoningReplayShape({
    logger,
    messages,
    modelId: "deepseek-v4.1-flash",
    providerId: "opencode-go-chat",
  });
}
