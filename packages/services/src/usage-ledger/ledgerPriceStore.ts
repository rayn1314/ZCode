import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LedgerPriceMutationResult } from "@zcode/shared";
import { atomicWriteJson } from "../fs/atomicFileUtils.js";
import { LEDGER_USER_PRICES_FILE_NAME, type ModelPrice } from "./ledgerPrices.js";

// 用户价格覆盖层的读-改-写：只动 <数据根>/v2/usage-prices.json，
// 保留文件里其它未知键与 `_meta` 原样，同步层（usage-prices-baseline.json）不碰。
// 文件损坏时拒绝覆盖——读取层可以忽略坏文件，但写入层若也当空文件处理，
// 一次「改价」就会把用户手写的整份价格表抹成只剩一条。

const ALIASES_KEY = "_aliases";

type PriceFilePayload = Record<string, unknown>;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 用户价格文件路径：文件名是常量，仍显式校验解析结果落在 <数据根>/v2 内，
 * 避免 dataRootDir 被外部输入污染时越出数据根。
 */
function userPriceFilePath(dataRootDir: string): string {
  const dir = path.resolve(path.resolve(dataRootDir), "v2");
  const target = path.resolve(dir, LEDGER_USER_PRICES_FILE_NAME);
  if (path.dirname(target) !== dir || path.basename(target) !== LEDGER_USER_PRICES_FILE_NAME) {
    throw new Error("用户价格文件路径越出数据根");
  }
  return target;
}

async function readUserPriceFile(
  dataRootDir: string,
): Promise<{ ok: true; payload: PriceFilePayload } | { ok: false; error: string }> {
  let filePath: string;
  try {
    filePath = userPriceFilePath(dataRootDir);
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: "用户价格文件顶层不是对象，已拒绝覆盖（请先修复该文件）" };
    }
    return { ok: true, payload: { ...(parsed as PriceFilePayload) } };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, payload: {} };
    }
    return { ok: false, error: `用户价格文件无法读取或已损坏：${messageOf(error)}` };
  }
}

function readAliasMap(payload: PriceFilePayload): Record<string, string> {
  const raw = payload[ALIASES_KEY];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  const aliases: Record<string, string> = {};
  for (const [alias, target] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof target === "string" && target.trim().length > 0) {
      aliases[alias.toLowerCase()] = target.trim().toLowerCase();
    }
  }
  return aliases;
}

async function writeUserPriceFile(
  dataRootDir: string,
  payload: PriceFilePayload,
): Promise<LedgerPriceMutationResult> {
  const aliases = readAliasMap(payload);
  if (Object.keys(aliases).length > 0) {
    payload[ALIASES_KEY] = aliases;
  } else {
    delete payload[ALIASES_KEY];
  }
  try {
    await atomicWriteJson(userPriceFilePath(dataRootDir), payload);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: messageOf(error) };
  }
}

/** 写用户覆盖价；同名键若还是别名，一并删除该别名（显式定价优先，留着只会造成误解）。 */
export async function setUserLedgerPrice(options: {
  dataRootDir: string;
  modelId: string;
  price: ModelPrice;
}): Promise<LedgerPriceMutationResult> {
  const read = await readUserPriceFile(options.dataRootDir);
  if (!read.ok) {
    return read;
  }
  const payload = read.payload;
  const modelId = options.modelId.trim().toLowerCase();
  payload[modelId] = {
    input: options.price.input,
    output: options.price.output,
    cacheRead: options.price.cacheRead,
  };
  const aliases = readAliasMap(payload);
  if (aliases[modelId]) {
    delete aliases[modelId];
    payload[ALIASES_KEY] = aliases;
  }
  return writeUserPriceFile(options.dataRootDir, payload);
}

/** 删除用户覆盖价 = 恢复默认（回落到同步层或内置基准）；别名映射不受影响。 */
export async function deleteUserLedgerPrice(options: {
  dataRootDir: string;
  modelId: string;
}): Promise<LedgerPriceMutationResult> {
  const read = await readUserPriceFile(options.dataRootDir);
  if (!read.ok) {
    return read;
  }
  delete read.payload[options.modelId.trim().toLowerCase()];
  return writeUserPriceFile(options.dataRootDir, read.payload);
}

/** 设置别名（target=null 删除）；设置时删掉同名显式定价，否则别名会被显式价永久遮住。 */
export async function setUserLedgerAlias(options: {
  dataRootDir: string;
  alias: string;
  target: string | null;
}): Promise<LedgerPriceMutationResult> {
  const alias = options.alias.trim().toLowerCase();
  const target = options.target?.trim().toLowerCase() || null;
  if (!alias) {
    return { ok: false, error: "别名不能为空" };
  }
  if (target && target === alias) {
    return { ok: false, error: "别名不能指向自己" };
  }
  const read = await readUserPriceFile(options.dataRootDir);
  if (!read.ok) {
    return read;
  }
  const payload = read.payload;
  const aliases = readAliasMap(payload);
  if (target) {
    aliases[alias] = target;
    delete payload[alias];
  } else {
    delete aliases[alias];
  }
  payload[ALIASES_KEY] = aliases;
  return writeUserPriceFile(options.dataRootDir, payload);
}
