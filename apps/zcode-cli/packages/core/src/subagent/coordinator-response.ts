import { randomUUID } from "node:crypto";
import type {
  CoordinatorResponsePort,
  CoordinatorResponseResult,
  SessionId,
} from "@zcode/contracts";
import type {
  EnqueueSubagentMessageInput,
  EnqueueSubagentMessageResult,
} from "../runtime/types.js";

interface CreateCoordinatorResponsePortOptions {
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  parentToolCallId?: string;
  createResponseId?: () => string;
  // void 会接受 async callback；同步返回值让 port 能把协调者的前台等待处置如实回给子代理。
  enqueue(input: EnqueueSubagentMessageInput): EnqueueSubagentMessageResult | undefined;
}

const BUSY_COORDINATOR_MESSAGE =
  "Response was queued for the coordinator, but the coordinator is still blocked in a foreground wait for this run and cannot reply in real time; it will read this message when the run ends. Do not wait for a reply — finish or fail the task yourself.";

export function createCoordinatorResponsePort(
  options: CreateCoordinatorResponsePortOptions,
): CoordinatorResponsePort {
  return {
    respond(request): CoordinatorResponseResult {
      const responseId = options.createResponseId?.() ?? `response_${randomUUID()}`;
      try {
        const delivery = options.enqueue({
          responseId,
          agentId: options.agentId,
          agentType: options.agentType,
          childSessionId: options.childSessionId,
          childToolCallId: String(request.childToolCallId),
          ...(options.parentToolCallId ? { parentToolCallId: options.parentToolCallId } : {}),
          summary: request.summary,
          message: request.message,
          traceContext: request.trace,
        });
        if (delivery?.foregroundWaitBusy) {
          return {
            status: "success",
            responseId,
            coordinatorAttention: "busy",
            message: BUSY_COORDINATOR_MESSAGE,
          };
        }
        return {
          status: "success",
          responseId,
          ...(delivery?.foregroundWaitReleased
            ? { coordinatorAttention: "released" as const }
            : {}),
          message: "Response was queued for the coordinator.",
        };
      } catch (error) {
        return {
          status: "failed",
          responseId,
          message: "Response could not be queued for the coordinator.",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
