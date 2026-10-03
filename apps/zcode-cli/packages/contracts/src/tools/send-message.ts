import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const SEND_MESSAGE_TOOL_NAME = "SendMessage";
export const SEND_MESSAGE_MAX_CONTENT_CHARS = 20_000;

export const SendMessageInputSchema = z
  .object({
    to: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Recipient. Either a local subagent ID returned by Agent (format agent_<uuid>), " +
          "or any session ID (format sess_*, e.g. sess_subagent_<uuid> for another session's subagent) " +
          "for cross-session delivery.",
      ),
    summary: z
      .string()
      .min(1)
      .max(200)
      .describe("A 5-10 word summary shown as a preview in the UI."),
    message: z
      .string()
      .min(1)
      .max(SEND_MESSAGE_MAX_CONTENT_CHARS)
      .describe("Plain text message content"),
  })
  .strict();

export type SendMessageInput = z.infer<typeof SendMessageInputSchema>;

export const SendMessageInputJsonSchema = toToolJsonSchema(SendMessageInputSchema);

export const SendMessageOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    messageId: z.string(),
    agentId: z.string().optional(),
    // `woken`/`stored` 是跨会话投递（to 为 sess_*）的落地方式；`queued`/`steered`/
    // `resumed_background` 是本会话子代理的既有三态，保留不动。
    delivery: z.enum(["queued", "steered", "resumed_background", "woken", "stored"]).optional(),
    error: z.string().optional(),
    message: z.string().optional(),
    outputFile: z.string().optional(),
    taskId: z.string().optional(),
  })
  .strict();

export type SendMessageOutput = z.infer<typeof SendMessageOutputSchema>;

export const SendMessageOutputJsonSchema = toToolJsonSchema(SendMessageOutputSchema);
