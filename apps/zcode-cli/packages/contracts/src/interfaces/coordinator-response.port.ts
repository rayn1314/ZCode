import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

export interface CoordinatorResponseRequest {
  childToolCallId: ToolCallId | string;
  summary: string;
  message: string;
  trace: TraceContext;
}

export interface CoordinatorResponseResult {
  status: "success" | "failed";
  responseId: string;
  message: string;
  error?: string;
  /**
   * 协调者对这条回复的实时可达性：
   * - "released"：协调者此前前台等待本子代理，已把该等待转后台，回复会被立即消费；
   * - "busy"：协调者仍阻塞在本前台运行上且该运行无法转后台（借用的前台模型覆盖），
   *   回复只会在运行结束后被读到，子代理不得等待回复。
   */
  coordinatorAttention?: "released" | "busy";
}

export interface CoordinatorResponsePort {
  // child session/agent/parent identity 由 port closure 绑定，模型不能覆盖路由。
  // 同步返回确保 response command 入父队列后，child tool result 才能完成。
  respond(request: CoordinatorResponseRequest): CoordinatorResponseResult;
}
