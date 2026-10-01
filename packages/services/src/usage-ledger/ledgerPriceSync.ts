import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LedgerPriceSyncResult } from "@zcode/shared";
import { LEDGER_SYNCED_PRICES_FILE_NAME, type ModelPrice } from "./ledgerPrices.js";

// 价格基准手动同步：界面按钮触发，拉 models.dev 公开目录写入同步层文件。
// 层级 内置基准 < 同步基准 < 用户覆盖——同步只更新中间层，绝不触碰用户手改的
// usage-prices.json；失败（网络/解析/写入）返回错误，旧文件原样保留。
// 只在用户显式点击时执行，不做定时任务（用户对估算口径何时变化有知情权）。

const MODELS_DEV_API_URL = "https://models.dev/api.json";
// models.dev 的 CDN 拒绝非浏览器 UA（实测 python 默认 UA 403）。
const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};
const FETCH_TIMEOUT_MS = 15_000;
// models.dev 全量目录去重后有 3400+ 唯一模型 id；解析结果远低于阈值说明上游
// 结构变了，宁可报错也不写坏同步层。
const MIN_MODEL_COUNT = 1_000;
// 同名模型在目录里被 30+ 个渠道（含免费档、套餐价、中转价）各报一次价，
// 与内置基准同口径：优先取厂商自营目录；此顺序即多官方命中时的取舍顺序。
const OFFICIAL_PROVIDER_ORDER = [
  "deepseek",
  "zai",
  "alibaba",
  "moonshotai",
  "openai",
  "stepfun",
  "xiaomi",
  "anthropic",
  "google",
  "mistral",
] as const;

interface ModelsDevModel {
  cost?: { input?: unknown; output?: unknown; cache_read?: unknown };
}

interface ModelsDevCatalog {
  [providerId: string]: {
    models?: Record<string, ModelsDevModel>;
  };
}

function toModelPrice(cost: NonNullable<ModelsDevModel["cost"]>): ModelPrice {
  const toNum = (value: unknown) => {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? num : 0;
  };
  return {
    input: toNum(cost.input),
    output: toNum(cost.output),
    cacheRead: toNum(cost.cache_read),
  };
}

function isFree(price: ModelPrice): boolean {
  return price.input === 0 && price.output === 0 && price.cacheRead === 0;
}

/** 同 id 多渠道取价：官方目录优先；否则取非零条目里一致价（众数），全零按免费档。 */
function pickPrice(
  entries: Array<{ provider: string; cost: NonNullable<ModelsDevModel["cost"]> }>,
): ModelPrice {
  for (const official of OFFICIAL_PROVIDER_ORDER) {
    const hit = entries.find((entry) => entry.provider === official);
    if (hit) {
      return toModelPrice(hit.cost);
    }
  }
  const counts = new Map<string, { price: ModelPrice; count: number }>();
  for (const entry of entries) {
    const price = toModelPrice(entry.cost);
    if (isFree(price)) {
      continue;
    }
    const key = `${price.input}|${price.output}|${price.cacheRead}`;
    const seen = counts.get(key);
    if (seen) {
      seen.count += 1;
    } else {
      counts.set(key, { price, count: 1 });
    }
  }
  let best: { price: ModelPrice; count: number } | null = null;
  for (const candidate of counts.values()) {
    if (!best || candidate.count > best.count) {
      best = candidate;
    }
  }
  return best?.price ?? { input: 0, output: 0, cacheRead: 0 };
}

function todayLocalDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export async function syncLedgerPriceBaseline(options: {
  dataRootDir: string;
  /** 测试注入用；生产用全局 fetch。 */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): Promise<LedgerPriceSyncResult> {
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(MODELS_DEV_API_URL, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      return { ok: false, error: `models.dev HTTP ${response.status}` };
    }
    const catalog = (await response.json()) as ModelsDevCatalog;
    const entriesByModel = new Map<
      string,
      Array<{ provider: string; cost: NonNullable<ModelsDevModel["cost"]> }>
    >();
    for (const [providerId, provider] of Object.entries(catalog)) {
      for (const [modelId, model] of Object.entries(provider.models ?? {})) {
        const cost = model.cost;
        if (!cost || cost.input === undefined) {
          continue;
        }
        const key = modelId.toLowerCase();
        const list = entriesByModel.get(key) ?? [];
        list.push({ provider: providerId, cost });
        entriesByModel.set(key, list);
      }
    }
    if (entriesByModel.size < MIN_MODEL_COUNT) {
      return {
        ok: false,
        error: `models.dev 目录结构异常（仅解析出 ${entriesByModel.size} 个模型）`,
      };
    }
    const prices: Record<string, ModelPrice> = {};
    for (const [modelId, entries] of entriesByModel) {
      prices[modelId] = pickPrice(entries);
    }
    const date = todayLocalDate(options.now?.() ?? new Date());
    const payload = {
      _meta: {
        source: "models.dev 公开模型目录（api.json）· 界面「同步价格」手动同步",
        date,
        currency: "USD",
        unit: "每百万 token",
        note: "同步层只覆盖内置基准；同名多渠道时厂商自营目录优先，其余取非零一致价。用户覆盖文件 usage-prices.json 的同名模型仍优先。仅用于估算，实际以账单为准。",
      },
      ...prices,
    };
    const targetDir = path.join(options.dataRootDir, "v2");
    await mkdir(targetDir, { recursive: true });
    // 直接覆盖写：写坏时加载层会当损坏文件忽略并回退内置基准，不会比「没有同步层」更差
    await writeFile(
      path.join(targetDir, LEDGER_SYNCED_PRICES_FILE_NAME),
      JSON.stringify(payload),
      "utf8",
    );
    return { ok: true, modelCount: Object.keys(prices).length, date };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
