// `commands/query` 方法族的 schema：幂等键、查询参数、条目与结果。
// 从 command.ts 拆出：command.ts 已顶到 oxlint max-lines 上限（400 有效行）。
// 仍从 zcode-protocol-v4 桶文件导出，消费方 import 路径不变。
import { z } from "zod";
import { localTtftClockSchema } from "../localTtft.js";
import { commandAckSchema } from "./command.js";

export const commandKeySchema = z
  .object({
    // null 只属于全局/createSession 幂等桶；session 命令必须携带 sessionId。
    sessionId: z.string().nullable(),
    commandId: z.string().min(1),
  })
  .strict();
export type CommandKey = z.infer<typeof commandKeySchema>;

export const commandsQueryParamsSchema = z
  .object({
    commands: z.array(commandKeySchema).min(1).max(64),
    clock: z.literal(true).optional(),
  })
  .strict()
  .refine(
    (params) => !params.clock || params.commands.every((key) => key.sessionId === null),
    "clock probes cannot query session commands",
  );
export type CommandsQueryParams = z.infer<typeof commandsQueryParamsSchema>;

export const commandQueryItemSchema = z
  .object({
    key: commandKeySchema,
    result: z.union([commandAckSchema, z.literal("unknown")]),
  })
  .strict();
export type CommandQueryItem = z.infer<typeof commandQueryItemSchema>;

export const commandsQueryResultSchema = z
  .object({
    results: z.array(commandQueryItemSchema).min(1).max(64),
    clock: localTtftClockSchema.optional(),
  })
  .strict();
export type CommandsQueryResult = z.infer<typeof commandsQueryResultSchema>;
