import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const RESPOND_TO_COORDINATOR_TOOL_NAME = "RespondToCoordinator";
export const RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS = 20_000;

export const RespondToCoordinatorInputSchema = z
  .object({
    summary: z.string().min(1).max(200).describe("Short summary of the response."),
    message: z
      .string()
      .min(1)
      .max(RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS)
      .describe("Response or progress update for the coordinator."),
  })
  .strict();

export type RespondToCoordinatorInput = z.infer<typeof RespondToCoordinatorInputSchema>;

export const RespondToCoordinatorInputJsonSchema = toToolJsonSchema(
  RespondToCoordinatorInputSchema,
);

export const RespondToCoordinatorOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    responseId: z.string(),
    message: z.string(),
    error: z.string().optional(),
    /**
     * 协调者对这条回复的实时可达性：
     * - "released"：协调者此前正前台等待本子代理，已把该等待转后台，回复会被立即消费；
     * - "busy"：协调者仍阻塞在本前台运行上且该运行无法转后台（借用的前台模型覆盖），
     *   回复只会在运行结束后被读到，子代理不得等待回复。
     */
    coordinatorAttention: z.enum(["released", "busy"]).optional(),
  })
  .strict();

export type RespondToCoordinatorOutput = z.infer<typeof RespondToCoordinatorOutputSchema>;
