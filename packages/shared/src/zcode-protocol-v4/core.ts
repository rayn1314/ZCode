// ZCode Protocol v4 —— 数据模型草稿（未冻结，schema 定型以黄金测试为准）。
// 本包纪律：只放 schema 类型 + 纯函数，禁止任何运行时/IO/传输逻辑。
import { z } from "zod";
import { VIDEO_INPUT_MAX_BYTES } from "../zcode-media-policy.js";

/** V4 物理 wire 协议版本；projection snapshot 继续独立使用 protocolVersion=1。 */
export const V4_WIRE_PROTOCOL_VERSION = 3 as const;

/** V3 row target：display row 与稳定实体必须成对提交并由同一权威投影校验。 */
export const conversationRowTargetSchema = z
  .object({
    rowId: z.number().int().nonnegative(),
    entityId: z.string().trim().min(1),
  })
  .strict();
export type ConversationRowTarget = z.infer<typeof conversationRowTargetSchema>;

// 时钟规则：Unix ms，一律 CLI 时钟；客户端禁止拿本地时钟与协议 Timestamp 相减。
export const timestampSchema = z.number();
export type Timestamp = z.infer<typeof timestampSchema>;

// delivery profile：只存在于 CLI flush 管线的参数表，客户端代码禁止出现 profile 变量。
export const streamablePathSchema = z.enum(["text", "inputText", "output.text", "summaryText"]);
export type StreamablePath = z.infer<typeof streamablePathSchema>;

export interface DeliveryProfile {
  desktopOnlyRows: boolean;
  flushWindowMs: number;
  streamPaths: Record<StreamablePath, boolean>;
  streamOutputCapBytes: number;
  toolProgress: boolean;
}

export const DELIVERY_PROFILES = {
  continuous: {
    desktopOnlyRows: true,
    flushWindowMs: 30,
    streamPaths: {
      text: true,
      inputText: true,
      "output.text": true,
      summaryText: true,
    },
    streamOutputCapBytes: 262144,
    toolProgress: false,
  },
  replayable: {
    desktopOnlyRows: false,
    flushWindowMs: 150,
    streamPaths: {
      text: true,
      inputText: false,
      "output.text": false,
      summaryText: false,
    },
    streamOutputCapBytes: 0,
    toolProgress: true,
  },
} as const satisfies Record<string, DeliveryProfile>;

export type DeliveryProfileName = keyof typeof DELIVERY_PROFILES;

// 常量与限额（初始值，实测调参）。
export const PROTOCOL_V4_LIMITS = {
  maxFrameBytes: 1024 * 1024,
  logicalFrameAssemblyMaxBytes: 16 * 1024 * 1024,
  logicalFrameAssemblyMaxFragments: 1024,
  logicalFrameAssemblyMaxConcurrent: 32,
  logicalFrameAssemblyMaxStagedBytes: 32 * 1024 * 1024,
  logicalFrameAssemblyTimeoutMs: 30_000,
  transportEnvelopeIdMaxChars: 256,
  subscriberBufferMaxOps: 500,
  subscriberBufferMaxBytes: 1024 * 1024,
  eventRetentionPerSession: 2000,
  snapshotTailWindowRows: 60,
  rowsRangeMaxLimit: 200,
  toolOutputFinalHeadBytes: 32 * 1024,
  toolOutputFinalTailBytes: 32 * 1024,
  goalVerificationsRetained: 20,
  pendingCommandsDisplayMax: 32,
  commandPendingTtlMs: 24 * 60 * 60 * 1000,
  idempotencyTablePerSession: 512,
  // commands/query 单 key 等待上限（CommandInbox.queryOne 消费）。对账是只读路径，
  // 不跟随 execute（commandExecuteTimeoutMs）一起挂：到点必须先给调用方可操作的收口，
  // 再由客户端稍后重查。10s 与既有声明值保持一致，避免两处漂移。
  conversationQueryTimeoutMs: 10_000,
  // 命令 execute 路径的准入 gate 持有上限（gateway await admitCommandInput/executeCommand）。
  // 挂死根因：CommandInbox 的 per-session/@global FIFO gate 持有到 settle，execute 永不
  // resolve 时该桶之后所有 handle 与 queryCommands 永久等待；gateway 的 finally 只覆盖
  // 同步异常，不覆盖挂起。依据（宁可宽松也不误杀）：handler 内显式等待的上界是 5s
  // （waitForSessionIdle/preemptActiveTurnAndWait）与 30s（logicalFrameAssemblyTimeoutMs），
  // 其余合法路径都是本机 IO 与进程内状态迁移——createSession 建 record/历史导入 resume、
  // fork 拷贝、附件读盘；compact/sendText 只推进到 admission/入队，不等 turn 结束。
  // 60s 给慢盘与冷机器留足余量，超时即强制 failed 终态释放 gate。
  commandExecuteTimeoutMs: 60_000,
  attachmentMaxBytes: 20 * 1024 * 1024,
  attachmentChunkMaxBytes: 512 * 1024,
  attachmentPreviewMaxBytes: VIDEO_INPUT_MAX_BYTES,
  // share 选择阶段的 metadata-only stat 曾复用 attachmentPreviewMaxBytes
  // （30MiB）作为 totalBytes 上限，于是超过该值的附件在 schema 校验就抛错，
  // 「容量超限」这个本应确定阻断的分类反而被降级成 deferred 并静默丢内容。
  // stat 不搬运字节，只需要一个足够表达真实文件大小的上界。
  attachmentStatMaxBytes: 2 * 1024 * 1024 * 1024,
  attachmentPreviewMaxChunks: VIDEO_INPUT_MAX_BYTES / (512 * 1024),
  attachmentReadCacheMaxBytes: VIDEO_INPUT_MAX_BYTES,
  attachmentReadCacheTtlMs: 30_000,
  attachmentUploadMaxChunks: 64,
  attachmentUploadMaxConcurrent: 16,
  attachmentUploadMaxStagedBytes: 64 * 1024 * 1024,
  attachmentUploadTtlMs: 5 * 60_000,
  attachmentUnreferencedTtlMs: 24 * 60 * 60 * 1000,
} as const;
