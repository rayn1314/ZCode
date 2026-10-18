// ============================================================
// 压缩摘要正文的只读读端（v4/conversation/compactionSummary）
// ============================================================
// 会话投影只下发 `summaryRef` 当占位（= 落库那条 `compact_summary` 消息的 messageId）：
// 正文实测 1.6 万 ~ 2.3 万字符，且单会话可能有多份（实测 24 次压缩），进快照会成倍放大
// payload 与快照体积，而它绝大多数时间不被查看，所以正文按 ref 懒加载。
//
// 与 workflowRunNodeResult 同族：只读、无状态、超时重发安全，刻意不是 v4 command——
// 读的是已经落库的持久事实，没有陈旧可防，也就不带 atSeq / atLogEpoch。
//
// 授权在宿主侧（v4-bridge 的端口实现）：messageId 必须是一条
// `semantics.kind === "compact_summary"` 的消息，否则与「无此消息」同一个答案——
// 这条通道不能顺势变成任意消息读取。返回的是**落库的结构化摘要**（`Summary:` + 固定
// 九段），不是发给模型的那段指令包装（"This session is being continued…"）。

import { z } from "zod";

export const v4ConversationCompactionSummaryParamsSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    messageId: z.string().trim().min(1),
  })
  .strict();
export type V4ConversationCompactionSummaryParams = z.infer<
  typeof v4ConversationCompactionSummaryParamsSchema
>;

export const v4ConversationCompactionSummaryResultSchema = z
  .object({
    /** 摘要正文原文；空串是合法结果（消息在、正文为空），由 UI 展示「摘要为空」。 */
    summary: z.string(),
  })
  .strict();
export type V4ConversationCompactionSummaryResult = z.infer<
  typeof v4ConversationCompactionSummaryResultSchema
>;
