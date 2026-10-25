import { z } from "zod";
import { sparseShape } from "@zcode/shared/config-schema";

export const providerApiTypeDataSchema = z.enum([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);
export const providerGroupDataSchema = z.enum([
  "standard-personal",
  "zai-family",
  "bigmodel-family",
]);
export const zhipuAccountModeDataSchema = z.enum([
  "start-plan",
  "individual-coding-plan",
  "team-coding-plan",
  "off-peak",
  // 加速卡访问类别；与 zcodeProviderAccountAccessSchema.mode 同值，改动需同步两处。
  "highspeed",
]);
export const providerVisibilityDataSchema = z.enum(["visible", "hidden"]);
export const providerLogoDataSchema = z
  .object({ type: z.literal("builtin"), key: z.string().min(1) })
  .strict();

const nonBlankRequiredString = z.string().refine((value) => value.trim().length > 0, {
  message: "必填配置不能为空",
  params: { configIssueCode: "required-field-missing" },
});

/**
 * 同一供应商的多 Key 预存池：切换 = 把选中项写进生效 `apiKey`，不引入 active 指针。
 * 与 `apiKey` 同级同文件存放（明文、0600），安全级别与现状一致；模板层禁止携带（见 rule-data-schema）。
 */
export const apiKeyPresetDataSchema = z
  .object({
    id: z.string().min(1),
    name: nonBlankRequiredString,
    apiKey: nonBlankRequiredString,
  })
  .strict();

export const apiKeyAccessDataSchema = z
  .object({
    type: z.enum(["api-key", "zhipu-coding-plan-api-key"]),
    apiKey: z.string().nullable().optional(),
    apiKeyManagementUrl: z.string().url().nullable().optional(),
    apiKeyPresets: z.array(apiKeyPresetDataSchema).readonly().nullable().optional(),
  })
  .strict();
export const completeApiKeyAccessDataSchema = apiKeyAccessDataSchema.extend({
  apiKey: nonBlankRequiredString,
});

export const completeZhipuAccountAccessDataSchema = z
  .object({
    type: z.literal("zhipu-account"),
    accountType: z.enum(["zai", "bigmodel"]),
    mode: zhipuAccountModeDataSchema,
    entitled: z.boolean(),
  })
  .strict();
export const zhipuAccountAccessDataSchema = z
  .object({
    ...sparseShape(completeZhipuAccountAccessDataSchema.shape),
    type: completeZhipuAccountAccessDataSchema.shape.type,
  })
  .strict();
export const providerAccessDataSchema = z.discriminatedUnion("type", [
  apiKeyAccessDataSchema,
  zhipuAccountAccessDataSchema,
]);
export const completeProviderAccessDataSchema = z.discriminatedUnion("type", [
  completeApiKeyAccessDataSchema,
  completeZhipuAccountAccessDataSchema,
]);

export const completeProviderApiDataSchema = z
  .object({
    type: providerApiTypeDataSchema,
    baseUrl: nonBlankRequiredString.pipe(z.string().url()),
    headers: z.record(z.string(), z.string()).readonly().nullable().optional(),
  })
  .strict();
export const providerApiDataSchema = z
  .object({
    ...sparseShape(completeProviderApiDataSchema.shape),
    baseUrl: z.string().url().nullable().optional(),
  })
  .strict();
// Personal 允许暂存编辑中的 endpoint；完整 schema 仍拒绝，且只影响该 Provider 的准入。
export const personalProviderApiDataSchema = providerApiDataSchema.extend({
  baseUrl: z.string().nullable().optional(),
});

/**
 * per-provider 每分钟请求数上限的值域：1 ~ 600。
 *
 * 下界 1：0 会让配额永久耗尽（每个请求都要等令牌，而令牌不再产生），那不是限速是死锁。
 * 上界 600：600/min 已经是 10 req/s，任何 provider 配额都远高于此；再大的数字对用户没有
 * 可感知的意义，却会让 UI 允许填出「配了等于没配」的值。
 */
export const providerRateLimitRequestsPerMinuteDataSchema = z.number().int().min(1).max(600);

/**
 * per-provider 并发上限（同时在飞的模型请求数）的值域：1 ~ 128。
 *
 * 下界 1：0 会让并发永久为 0（闸门永不放行），那不是限流是死锁。
 * 上界 128：这是**单机客户端**同时挂起的推理流；再大的量级该横向拆账号（多建一条 provider），
 * 而不是调大这一个数。
 */
export const providerMaxConcurrentDataSchema = z.number().int().min(1).max(128);

/**
 * per-provider 请求策略：与「用哪个 Key」无关，只约束**发请求的节奏**。
 *
 * 两个旋钮对应服务商侧的两种真实约束：
 * - `requestsPerMinute`（每分钟 N 次）：按它限速后突发自然被压平，429 处理是多余的——不主动撞墙
 *   就不会触发，真撞了走既有的指数退避（见 bootstrap 的 provider-rate-limiter）。
 * - `maxConcurrent`（同时 N 个在飞）：有的服务商**只限并发不限次数**，且超发时不返回 429 而是
 *   静默排队——AIMD 学不到墙在哪，只能靠这条声明硬性卡住总在飞数（见 bootstrap 的
 *   workflow-concurrency-governor 的 provider 闸门）。两个都配时同时生效。
 *   语义是**上游**的总量：同机多端（Windows 桌面 + WSL 远端）共用这一份，各端只按
 *   `N − 对方在飞数` 放行（见 bootstrap 的 provider-concurrency-shared）。
 */
export const providerRequestPolicyDataSchema = z
  .object({
    requestsPerMinute: providerRateLimitRequestsPerMinuteDataSchema.nullable().optional(),
    maxConcurrent: providerMaxConcurrentDataSchema.nullable().optional(),
  })
  .strict();

const modelIdsDataSchema = z.array(z.string().min(1)).readonly().nullable().optional();
export const providerConfigDataSchema = z
  .object({
    group: providerGroupDataSchema.nullable().optional(),
    logo: providerLogoDataSchema.nullable().optional(),
    access: providerAccessDataSchema.nullable().optional(),
    api: providerApiDataSchema.nullable().optional(),
    requestPolicy: providerRequestPolicyDataSchema.nullable().optional(),
    builtinModelIds: modelIdsDataSchema,
    personalModelIds: modelIdsDataSchema,
    modelOrder: modelIdsDataSchema,
    visibility: providerVisibilityDataSchema.nullable().optional(),
  })
  .strict();
export const completeProviderConfigDataSchema = providerConfigDataSchema.extend({
  group: providerGroupDataSchema,
  access: completeProviderAccessDataSchema,
  api: completeProviderApiDataSchema,
});

export const providerTemplateNameMapDataSchema = z
  .object({
    "zh-CN": z.string().min(1).optional(),
    "en-US": z.string().min(1).optional(),
  })
  .strict();
export const providerTemplateDataSchema = z
  .object({
    templateId: z.string().min(1),
    templateNameMap: providerTemplateNameMapDataSchema,
    config: providerConfigDataSchema,
  })
  .strict();
