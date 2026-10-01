import { z } from "zod";

// ── 用量账本（Usage Ledger）─────────────────────────────────────────
// 多数据根只读聚合协议：一台机器可同时存在官方版与自建版（~/.zcode-<身份>）数据根，
// Windows 侧与 WSL 里各有一份 SQLite 账本。读取层在 host 进程内聚合后合并成一份快照。
// 口径不变式（与 packages/services/spec/usage-ledger.md 对应）：
//   1. cacheRead ⊂ input、reasoning ⊂ output，任何 token 合计只用 input + output。
//   2. 费用逐模型计价再汇总；未定价模型的调用显式记入 unpricedCalls，不静默按 0 算。
//   3. 均值（耗时/首字延迟）跨源合并时按调用数加权。

export const LEDGER_RANGES = ["today", "7d", "30d", "all", "custom"] as const;
export type LedgerRange = (typeof LEDGER_RANGES)[number];

export const ledgerSnapshotRequestSchema = z.object({
  range: z.enum(LEDGER_RANGES),
  /** range=custom 时的起止日期（YYYY-MM-DD，按 host 本机时区解释）。 */
  customStart: z.string().nullish(),
  customEnd: z.string().nullish(),
  /** 供应商按显示名筛选：不同数据根里同一名字对应的 provider_id 不同，按名才能全源同筛。 */
  providerLabel: z.string().nullish(),
  modelId: z.string().nullish(),
  /** 选中的来源 key 子集；null/缺省表示全部可用来源。 */
  sourceKeys: z.array(z.string()).nullish(),
});
export type LedgerSnapshotRequest = z.infer<typeof ledgerSnapshotRequestSchema>;

export const ledgerSourceKindSchema = z.enum(["windows", "wsl"]);
export type LedgerSourceKind = z.infer<typeof ledgerSourceKindSchema>;

export const ledgerSourceVariantSchema = z.enum(["official", "self"]);
export type LedgerSourceVariant = z.infer<typeof ledgerSourceVariantSchema>;

export const ledgerSourceSchema = z.object({
  /** 来源 key：`windows`、`windows@<身份>`、`wsl:<发行版>`、`wsl:<发行版>@<身份>`。 */
  key: z.string(),
  label: z.string(),
  kind: ledgerSourceKindSchema,
  variant: ledgerSourceVariantSchema,
  /** 自建版身份后缀；官方版为空串。 */
  identity: z.string(),
  calls: z.number(),
  ok: z.boolean(),
  error: z.string().nullish(),
  included: z.boolean(),
  /** 该来源的数据根绝对路径，用于界面展示数据位置。 */
  rootPath: z.string(),
});
export type LedgerSource = z.infer<typeof ledgerSourceSchema>;

export const ledgerHourlyBucketSchema = z.object({
  /** 0–23 小时；展示文案由 UI 按语言生成，协议不携带。 */
  hour: z.number(),
  calls: z.number(),
});
export type LedgerHourlyBucket = z.infer<typeof ledgerHourlyBucketSchema>;

export const ledgerDailyRowSchema = z.object({
  date: z.string(),
  calls: z.number(),
  errors: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  reasoningTokens: z.number(),
  avgDurationMs: z.number().nullable(),
  cost: z.number().nullable(),
});
export type LedgerDailyRow = z.infer<typeof ledgerDailyRowSchema>;

export const ledgerModelRowSchema = z.object({
  model: z.string().nullable(),
  provider: z.string(),
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  avgDurationMs: z.number().nullable(),
  cost: z.number().nullable(),
});
export type LedgerModelRow = z.infer<typeof ledgerModelRowSchema>;

export const ledgerAgentRowSchema = z.object({
  agent: z.string(),
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cost: z.number().nullable(),
});
export type LedgerAgentRow = z.infer<typeof ledgerAgentRowSchema>;

export const ledgerSessionRowSchema = z.object({
  sessionId: z.string(),
  title: z.string().nullable(),
  directory: z.string().nullable(),
  calls: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  lastActiveMs: z.number().nullable(),
  cost: z.number().nullable(),
  /** 多源合并时标注该行来自哪个来源（单源时省略）。 */
  src: z.string().optional(),
});
export type LedgerSessionRow = z.infer<typeof ledgerSessionRowSchema>;

export const ledgerRecentCallSchema = z.object({
  timeMs: z.number().nullable(),
  model: z.string().nullable(),
  provider: z.string(),
  agent: z.string().nullable(),
  status: z.string().nullable(),
  errorType: z.string().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  durationMs: z.number().nullable(),
  ttftMs: z.number().nullable(),
  cost: z.number().nullable(),
  src: z.string().optional(),
});
export type LedgerRecentCall = z.infer<typeof ledgerRecentCallSchema>;

export const ledgerErrorRowSchema = z.object({
  type: z.string(),
  count: z.number(),
});
export type LedgerErrorRow = z.infer<typeof ledgerErrorRowSchema>;

export const ledgerProviderFacetSchema = z.object({
  id: z.string().nullable(),
  label: z.string(),
  calls: z.number(),
});
export type LedgerProviderFacet = z.infer<typeof ledgerProviderFacetSchema>;

export const ledgerModelFacetSchema = z.object({
  id: z.string().nullable(),
  calls: z.number(),
});
export type LedgerModelFacet = z.infer<typeof ledgerModelFacetSchema>;

export const ledgerPriceMetaSchema = z.object({
  date: z.string().nullish(),
  currency: z.string().nullish(),
  source: z.string().nullish(),
  note: z.string().nullish(),
});
export type LedgerPriceMeta = z.infer<typeof ledgerPriceMetaSchema>;

/** 价格基准手动同步结果；ok=false 时旧基准原样保留，error 只供 UI 展示。 */
export const ledgerPriceSyncResultSchema = z.object({
  ok: z.boolean(),
  error: z.string().nullish(),
  /** 本次写入的有价模型数。 */
  modelCount: z.number().nullish(),
  /** 同步后的基准日期（YYYY-MM-DD）。 */
  date: z.string().nullish(),
});
export type LedgerPriceSyncResult = z.infer<typeof ledgerPriceSyncResultSchema>;

export const ledgerOverviewSchema = z.object({
  calls: z.number(),
  completed: z.number(),
  errors: z.number(),
  cancelled: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  reasoningTokens: z.number(),
  cacheReadTokens: z.number(),
  avgDurationMs: z.number().nullable(),
  avgTtftMs: z.number().nullable(),
  /** 范围内有调用的天数（按日序列长度计）。 */
  activeDays: z.number(),
  /** 今日/本月是固定口径 KPI，不随所选范围变化。 */
  todayCalls: z.number(),
  todayTokens: z.number(),
  todayCost: z.number().nullable(),
  monthCalls: z.number(),
  monthTokens: z.number(),
  monthCost: z.number().nullable(),
  /** 加载到价格表时才有费用字段；否则整体缺省，UI 显示「未启用费用估算」。 */
  cost: z.number().optional(),
  unpricedCalls: z.number().optional(),
  unpricedModelIds: z.array(z.string()).optional(),
});
export type LedgerOverview = z.infer<typeof ledgerOverviewSchema>;

export interface LedgerRangeInfo {
  key: LedgerRange;
  /** all 时 fromMs 为 null。 */
  fromMs: number | null;
  toMs: number | null;
}

export const ledgerSnapshotSchema = z.object({
  range: z.object({
    key: z.enum(LEDGER_RANGES),
    /** all 时 fromMs 为 null。 */
    fromMs: z.number().nullable(),
    toMs: z.number().nullable(),
  }),
  generatedAt: z.number(),
  overview: ledgerOverviewSchema,
  hourlyToday: z.array(ledgerHourlyBucketSchema),
  daily: z.array(ledgerDailyRowSchema),
  models: z.array(ledgerModelRowSchema),
  agents: z.array(ledgerAgentRowSchema),
  sessions: z.array(ledgerSessionRowSchema),
  recent: z.array(ledgerRecentCallSchema),
  errors: z.array(ledgerErrorRowSchema),
  facets: z.object({
    providers: z.array(ledgerProviderFacetSchema),
    models: z.array(ledgerModelFacetSchema),
  }),
  sources: z.array(ledgerSourceSchema),
  pricesLoaded: z.boolean(),
  priceMeta: ledgerPriceMetaSchema.nullable(),
});
export type LedgerSnapshot = z.infer<typeof ledgerSnapshotSchema>;
