// Env Config Adapter - Parse the intentionally small ZCODE_* environment surface.

import type { RuntimeConfigPatch } from "@zcode/contracts";

interface EnvConfigOptions {
  prefix?: string;
}

const DEFAULT_PREFIX = "ZCODE_";

/**
 * Parse ZCODE_* environment variables into config
 */
export function parseEnvConfig(
  env: Record<string, string | undefined> = process.env,
  options: EnvConfigOptions = {},
): RuntimeConfigPatch {
  const prefix = options.prefix ?? DEFAULT_PREFIX;
  const config: RuntimeConfigPatch = {};

  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(prefix) || value === undefined) continue;

    const configKey = key.slice(prefix.length);
    // Storage config
    if (configKey === "STORAGE_DIR") {
      if (!config.storage) config.storage = {};
      config.storage.dir = value;
    } else if (configKey === "SESSION_DB_PATH" || configKey === "SESSION_DB") {
      if (!config.storage) config.storage = {};
      config.storage.sessionDbPath = value;
    }

    // Network config
    else if (configKey === "HTTP_PROXY") {
      if (!config.network) config.network = {};
      config.network.httpProxy = value;
    } else if (configKey === "NO_PROXY") {
      if (!config.network) config.network = {};
      config.network.noProxy = value;
    } else if (configKey === "AGENT_CA_CERT") {
      if (!config.network) config.network = {};
      config.network.caCertFile = value;
    } else if (configKey === "HTTP_TIMEOUT" || configKey === "TIMEOUT") {
      if (!config.network) config.network = {};
      config.network.timeout = normalizeNumber(value);
    }

    // Logging config
    else if (configKey === "LOG_FORMAT") {
      if (!config.logging) config.logging = {};
      config.logging.format = normalizeLogFormat(value);
    }

    // Tool Concurrency config
    else if (configKey === "MAX_TOOL_CONCURRENCY") {
      if (!config.toolConcurrency) config.toolConcurrency = {};
      config.toolConcurrency.maxConcurrency = normalizeNumber(value);
    }

    // Subagent dispatch config（进程级驻留座位闸门上界）
    else if (configKey === "SUBAGENT_MAX_CONCURRENT") {
      const maxConcurrent = parseSubagentMaxConcurrent(value);
      // 非法值（NaN / <1）不覆盖缺省：静默降级到 1 会把并发面掐死，不如保持配置默认。
      if (maxConcurrent !== undefined) {
        if (!config.subagents) config.subagents = {};
        config.subagents.maxConcurrent = maxConcurrent;
      }
    }
  }

  return config;
}

/**
 * 解析 `ZCODE_SUBAGENT_MAX_CONCURRENT`：1–64 **整数**，越界/非法返回 undefined（不覆盖）。
 * 与配置文件 schema 的 subagents.maxConcurrent 同一纪律：非整数拒绝而不是截断——
 * 静默截断会把用户写错的值悄悄改语义。
 */
function parseSubagentMaxConcurrent(value: string): number | undefined {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1 || num > 64) return undefined;
  return num;
}

/**
 * Get tool concurrency config from environment
 */
export function getToolConcurrencyConfig(): { maxConcurrency: number } {
  return {
    maxConcurrency: normalizeNumber(process.env.ZCODE_MAX_TOOL_CONCURRENCY ?? "10"),
  };
}

// ============================================================
// Helpers
// ============================================================

function normalizeNumber(value: string): number {
  const num = Number(value);
  return isNaN(num) ? 0 : num;
}

function normalizeLogFormat(value: string): "text" | "json" {
  const format = value.toLowerCase();
  if (format === "text" || format === "json") {
    return format;
  }
  return "text";
}
